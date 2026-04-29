#!/usr/bin/env bash
#
# Bootstrap a Railway environment for OpenEMR.
#
# The OpenEMR service runs the upstream `openemr/openemr:flex` image
# directly. The flex image clones the application source from GitLab
# at container startup, so there is no Docker build step and no
# repository upload — Railway just pulls a published image and the
# image clones our code at boot.
#
# Idempotent — safe to re-run. Each step checks if the resource exists
# before creating, so re-running converges to the desired state.
#
# Usage:
#   infra/bootstrap-env.sh <environment-name>
#
# Example:
#   infra/bootstrap-env.sh dev
#   infra/bootstrap-env.sh production
#
# Service naming:
#   Railway requires service names to be unique within a project, so
#   the openemr service is suffixed with the environment name:
#     - openemr-<env>
#   The MySQL service is provisioned via Railway's managed-database
#   plugin, which picks its own name (typically "MySQL" for the first
#   environment, "MySQL-<random>" for subsequent ones). The script
#   discovers the actual name and uses it for variable references.
#
# Required environment variables:
#   GITLAB_DEPLOY_TOKEN_NAME   Username from GitLab deploy token
#                              (e.g. "gitlab+deploy-token-3")
#   GITLAB_DEPLOY_TOKEN_VALUE  The deploy token secret (starts with
#                              "gldt-"), with read_repository scope
#
# Optional environment variables:
#   OE_PASS                 Admin password for the OpenEMR `admin`
#                           user. If unset and the service does not
#                           already have one, a random 32-char password
#                           is generated and printed once.
#   GITLAB_HOST             GitLab hostname. Default: labs.gauntletai.com
#   GITLAB_REPO_PATH        Repo path. Default: keithmazanec/openemr
#   GITLAB_BRANCH           Branch to track per environment. Default: master

set -euo pipefail

ENV_NAME="${1:?usage: $(basename "$0") <environment-name>}"

OPENEMR_SERVICE="openemr-${ENV_NAME}"
MOUNT_PATH="/var/www/localhost/htdocs/openemr/sites"
# Thin overlay on the upstream openemr/openemr:flex image that adds
# Apache configuration for Railway's TLS-terminating edge proxy. Built
# from docker/railway/Dockerfile and pushed to Docker Hub.
FLEX_IMAGE="kmazanec/openemr-railway:flex"

GITLAB_HOST="${GITLAB_HOST:-labs.gauntletai.com}"
GITLAB_REPO_PATH="${GITLAB_REPO_PATH:-keithmazanec/openemr}"
GITLAB_BRANCH="${GITLAB_BRANCH:-master}"

: "${GITLAB_DEPLOY_TOKEN_NAME:?must set GITLAB_DEPLOY_TOKEN_NAME (deploy token username from GitLab)}"
: "${GITLAB_DEPLOY_TOKEN_VALUE:?must set GITLAB_DEPLOY_TOKEN_VALUE (deploy token secret from GitLab)}"

FLEX_REPOSITORY="https://${GITLAB_DEPLOY_TOKEN_NAME}:${GITLAB_DEPLOY_TOKEN_VALUE}@${GITLAB_HOST}/${GITLAB_REPO_PATH}.git"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    [warn]\033[0m %s\n' "$*"; }

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: required command '$1' not found in PATH" >&2
        exit 1
    fi
}

require_cmd railway
require_cmd jq

# Returns 0 if a service with the given name exists in the linked
# environment, non-zero otherwise.
service_exists() {
    railway service list --json 2>/dev/null \
        | jq -e --arg n "$1" '.[] | select(.name == $n)' >/dev/null
}

# Returns 0 if a volume is mounted at the given path on the given service,
# non-zero otherwise.
volume_mounted() {
    local service="$1" path="$2"
    railway volume list --json 2>/dev/null \
        | jq -e --arg s "$service" --arg p "$path" \
            '.volumes[] | select(.serviceName == $s and .mountPath == $p)' \
            >/dev/null
}

# Find the managed MySQL service in the linked environment by looking for
# any service whose source image starts with "mysql:". Prints the service
# name on stdout, or empty string if none found.
find_mysql_service() {
    railway service list --json 2>/dev/null \
        | jq -r '[.[] | select(.source.image // "" | startswith("mysql:"))] | .[0].name // empty'
}

# Poll find_mysql_service until it returns a name, or timeout. Railway
# operations are asynchronous: a service created by `railway add` may
# not be visible in `railway service list` immediately. Prints the
# discovered name on stdout, or empty string after the timeout.
wait_for_mysql_service() {
    local deadline=$(($(date +%s) + 30))
    local name=""
    while [[ "$(date +%s)" -lt "$deadline" ]]; do
        name=$(find_mysql_service)
        if [[ -n "$name" ]]; then
            echo "$name"
            return 0
        fi
        sleep 2
    done
    return 1
}

# ---------------------------------------------------------------------------
# 0. Sanity: authenticated and inside the linked project
# ---------------------------------------------------------------------------

step "Verifying Railway CLI authentication and project link"
railway whoami >/dev/null 2>&1 || {
    echo "error: not authenticated. Run 'railway login' first." >&2
    exit 1
}
# `railway status` errors when the linked environment was deleted from
# under the CLI. `environment list` works regardless and confirms the
# project is linked at all.
ENV_LIST=$(railway environment list --json 2>&1) || {
    echo "error: no Railway project linked, or CLI cannot reach project." >&2
    echo "Run 'railway link' from the repo root." >&2
    echo "$ENV_LIST" >&2
    exit 1
}
info "project linked"

# ---------------------------------------------------------------------------
# 1. Environment
# ---------------------------------------------------------------------------

step "Ensuring environment '$ENV_NAME' exists"
if echo "$ENV_LIST" | jq -e --arg n "$ENV_NAME" '.environments[] | select(.name == $n)' >/dev/null; then
    info "environment '$ENV_NAME' already exists"
else
    railway environment new "$ENV_NAME" >/dev/null
    info "created environment '$ENV_NAME'"
fi
railway environment "$ENV_NAME" >/dev/null
info "linked to '$ENV_NAME'"

# ---------------------------------------------------------------------------
# 2. Managed MySQL plugin
# ---------------------------------------------------------------------------

step "Ensuring managed MySQL exists in this environment"
MYSQL_SERVICE=$(find_mysql_service)
if [[ -n "$MYSQL_SERVICE" ]]; then
    info "managed MySQL already provisioned as '$MYSQL_SERVICE'"
else
    # `railway add --database mysql` is interactive even with the flag.
    # Driving it with `</dev/null` accepts defaults at every prompt.
    railway add --database mysql </dev/null >/dev/null
    # Railway operations are async; poll for the new service to appear.
    MYSQL_SERVICE=$(wait_for_mysql_service)
    if [[ -z "$MYSQL_SERVICE" ]]; then
        echo "error: provisioned MySQL but could not discover its service name within 30s" >&2
        exit 1
    fi
    info "provisioned managed MySQL as '$MYSQL_SERVICE'"
fi

# ---------------------------------------------------------------------------
# 3. openemr service
# ---------------------------------------------------------------------------

step "Ensuring openemr service '$OPENEMR_SERVICE' exists"
if service_exists "$OPENEMR_SERVICE"; then
    info "$OPENEMR_SERVICE already exists"
    # Note: Railway's CLI cannot change a service's source image after
    # creation. If the existing service was created with the wrong
    # image, delete it (`railway service delete`) and re-run this script.
else
    railway add \
        --service "$OPENEMR_SERVICE" \
        --image "$FLEX_IMAGE" \
        --variables "BOOTSTRAP_PLACEHOLDER=1" \
        </dev/null >/dev/null
    info "created $OPENEMR_SERVICE from image $FLEX_IMAGE"
fi

railway service link "$OPENEMR_SERVICE" >/dev/null

# ---------------------------------------------------------------------------
# 4. Volume for openemr sites/
# ---------------------------------------------------------------------------

step "Ensuring openemr volume at $MOUNT_PATH"
if volume_mounted "$OPENEMR_SERVICE" "$MOUNT_PATH"; then
    info "openemr volume already attached"
else
    railway volume add --mount-path "$MOUNT_PATH" >/dev/null
    info "created openemr volume at $MOUNT_PATH"
fi

# ---------------------------------------------------------------------------
# 5. Environment variables on openemr
# ---------------------------------------------------------------------------

step "Setting environment variables on $OPENEMR_SERVICE"

# OE_PASS resolution priority:
#   1. Explicit OE_PASS env var passed to this script (override).
#   2. OE_PASS already set on the service (idempotent — leave alone).
#   3. Generate a fresh random 32-char password and print it once.
EXISTING_OE_PASS=$(railway variables --service "$OPENEMR_SERVICE" --kv 2>/dev/null \
    | awk -F= '/^OE_PASS=/ { sub(/^OE_PASS=/, ""); print; exit }')

if [[ -n "${OE_PASS:-}" ]]; then
    info "using OE_PASS from environment (explicit override)"
elif [[ -n "$EXISTING_OE_PASS" ]]; then
    OE_PASS="$EXISTING_OE_PASS"
    info "OE_PASS already set on the service — leaving it unchanged"
else
    # Avoid `tr | head -c` because head closing the pipe early raises
    # SIGPIPE on tr, which `set -o pipefail` treats as an error.
    OE_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 256 /dev/urandom))
    OE_PASS="${OE_PASS:0:32}"
    warn "OE_PASS was not set — generated a random 32-character password."
    warn "SAVE THIS NOW (it will not be displayed again):"
    printf '\n    OE_PASS for %s: %s\n\n' "$OPENEMR_SERVICE" "$OE_PASS"
fi

railway variable set --service "$OPENEMR_SERVICE" --skip-deploys \
    "MYSQL_HOST=\${{${MYSQL_SERVICE}.MYSQLHOST}}" \
    "MYSQL_PORT=\${{${MYSQL_SERVICE}.MYSQLPORT}}" \
    "MYSQL_ROOT_USER=root" \
    "MYSQL_ROOT_PASS=\${{${MYSQL_SERVICE}.MYSQLPASSWORD}}" \
    "MYSQL_USER=openemr" \
    "MYSQL_PASS=\${{${MYSQL_SERVICE}.MYSQLPASSWORD}}" \
    "MYSQL_DATABASE=openemr" \
    "OE_USER=admin" \
    "OE_PASS=$OE_PASS" \
    "FLEX_REPOSITORY=$FLEX_REPOSITORY" \
    "FLEX_REPOSITORY_BRANCH=$GITLAB_BRANCH" \
    >/dev/null

# Drop the placeholder we used to create the service non-interactively.
railway variable delete --service "$OPENEMR_SERVICE" --yes BOOTSTRAP_PLACEHOLDER \
    >/dev/null 2>&1 || true

info "variables set (referencing MySQL service '$MYSQL_SERVICE')"
info "FLEX_REPOSITORY_BRANCH=$GITLAB_BRANCH"

# When a service is created with `railway add --service --image ...`,
# Railway starts it before we've set the application env vars (because
# `variable set` happens after `add`). The first deployment crashes with
# missing config and Railway gets stuck trying to restart that broken
# deployment. Forcing a fresh redeploy ensures the new container starts
# with the full env-var set we just configured.
#
# This runs unconditionally. It's a no-op (just a redeploy of an already-
# good deployment) when the service was already healthy on a previous
# bootstrap run.
step "Forcing fresh deployment of $OPENEMR_SERVICE so it picks up the env vars"
railway service redeploy --service "$OPENEMR_SERVICE" --yes >/dev/null 2>&1 || true
info "redeploy triggered"

# ---------------------------------------------------------------------------
# 6. Public domain
# ---------------------------------------------------------------------------

step "Ensuring $OPENEMR_SERVICE has a public domain on port 80"
EXISTING_DOMAIN=$(railway domain --service "$OPENEMR_SERVICE" --json 2>/dev/null \
    | jq -r '.domains[0] // empty')
if [[ -n "$EXISTING_DOMAIN" ]]; then
    info "domain already exists: $EXISTING_DOMAIN"
else
    NEW_DOMAIN=$(railway domain --service "$OPENEMR_SERVICE" --port 80 --json 2>/dev/null \
        | jq -r '.domains[0] // empty')
    info "generated domain: $NEW_DOMAIN"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

step "Bootstrap complete for environment '$ENV_NAME'"
cat <<EOF

Next steps:
  1. Watch logs as the flex container clones the repo and starts:
       railway logs --service $OPENEMR_SERVICE --environment $ENV_NAME
     (first boot takes 5–10 minutes — clone, composer install, npm build.)
  2. Once the healthcheck passes, the public domain serves OpenEMR.
     Log in with admin / <OE_PASS shown above>.
  3. To deploy a new version, push to the '$GITLAB_BRANCH' branch and
     restart the service:
       railway service restart --service $OPENEMR_SERVICE --environment $ENV_NAME
     (or use the dashboard's Restart button.)

EOF
