#!/usr/bin/env bash
#
# Bootstrap a DigitalOcean Droplet running OpenEMR.
#
# Idempotent — safe to re-run. If the Droplet exists, prints its IP
# and exits without modifying it. Cloud-init runs on the Droplet's
# first boot only; subsequent re-runs of this script do not re-trigger
# cloud-init.
#
# Usage:
#   infra/bootstrap-do.sh
#
# Required environment variables:
#   GITLAB_DEPLOY_TOKEN_NAME   Username from GitLab deploy token.
#   GITLAB_DEPLOY_TOKEN_VALUE  Token secret (gldt-...) with read_repository scope.
#
# Optional environment variables (defaults shown):
#   DROPLET_NAME           openemr
#   DROPLET_REGION         nyc3
#   DROPLET_SIZE           s-2vcpu-2gb
#   DROPLET_IMAGE          ubuntu-24-04-x64
#   SSH_KEY_PATH           $HOME/.ssh/id_ed25519_gauntlet.pub
#   GITLAB_HOST            labs.gauntletai.com
#   GITLAB_REPO_PATH       keithmazanec/openemr
#   GITLAB_BRANCH          master
#   OE_DOMAIN              emr.biograph.dev
#   OE_PASS                generated random 32-char if unset
#   MYSQL_ROOT_PASSWORD    generated random 32-char if unset
#   AGENT_PG_PASSWORD      generated random 32-char if unset

set -euo pipefail

DROPLET_NAME="${DROPLET_NAME:-openemr}"
DROPLET_REGION="${DROPLET_REGION:-nyc3}"
DROPLET_SIZE="${DROPLET_SIZE:-s-2vcpu-2gb}"
DROPLET_IMAGE="${DROPLET_IMAGE:-ubuntu-24-04-x64}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_ed25519_gauntlet.pub}"

GITLAB_HOST="${GITLAB_HOST:-labs.gauntletai.com}"
GITLAB_REPO_PATH="${GITLAB_REPO_PATH:-keithmazanec/openemr}"
GITLAB_BRANCH="${GITLAB_BRANCH:-master}"
OE_DOMAIN="${OE_DOMAIN:-emr.biograph.dev}"
APEX_DOMAIN="${APEX_DOMAIN:-biograph.dev}"

: "${GITLAB_DEPLOY_TOKEN_NAME:?must set GITLAB_DEPLOY_TOKEN_NAME}"
: "${GITLAB_DEPLOY_TOKEN_VALUE:?must set GITLAB_DEPLOY_TOKEN_VALUE}"

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

require_cmd doctl
require_cmd jq
require_cmd ssh-keygen

# Generate a random alphanumeric secret. Avoids `tr | head -c` because
# head closing the pipe early raises SIGPIPE on tr (set -o pipefail).
gen_secret() {
    local raw
    raw=$(LC_ALL=C tr -dc 'A-Za-z0-9' < <(head -c 256 /dev/urandom))
    echo "${raw:0:32}"
}

# ---------------------------------------------------------------------------
# 0. Sanity
# ---------------------------------------------------------------------------

step "Verifying doctl auth and prerequisites"
doctl account get >/dev/null 2>&1 || {
    echo "error: doctl is not authenticated. Run 'doctl auth init' first." >&2
    exit 1
}
info "doctl: $(doctl account get --format Email --no-header 2>/dev/null)"

if [[ ! -f "${SSH_KEY_PATH}" ]]; then
    echo "error: SSH key not found at ${SSH_KEY_PATH}" >&2
    exit 1
fi
info "ssh key: ${SSH_KEY_PATH}"

# ---------------------------------------------------------------------------
# 1. Ensure the SSH key is registered with DigitalOcean
# ---------------------------------------------------------------------------

step "Ensuring SSH key is registered with DigitalOcean"
SSH_FINGERPRINT=$(ssh-keygen -lf "${SSH_KEY_PATH}" -E md5 | awk '{print $2}' | sed 's/^MD5://')
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,FingerPrint --no-header \
    | awk -v fp="${SSH_FINGERPRINT}" '$2 == fp { print $1; exit }')

if [[ -n "${SSH_KEY_ID}" ]]; then
    info "SSH key already registered (id=${SSH_KEY_ID})"
else
    SSH_KEY_NAME="$(basename "${SSH_KEY_PATH}" .pub)"
    SSH_KEY_ID=$(doctl compute ssh-key create "${SSH_KEY_NAME}" \
        --public-key "$(cat "${SSH_KEY_PATH}")" \
        --format ID --no-header)
    info "registered SSH key as '${SSH_KEY_NAME}' (id=${SSH_KEY_ID})"
fi

# ---------------------------------------------------------------------------
# 2. Resolve passwords (use existing values if the Droplet already exists)
# ---------------------------------------------------------------------------

EXISTING_DROPLET_ID=$(doctl compute droplet list --format ID,Name --no-header \
    | awk -v n="${DROPLET_NAME}" '$2 == n { print $1; exit }')

if [[ -n "${EXISTING_DROPLET_ID}" ]]; then
    step "Droplet '${DROPLET_NAME}' already exists (id=${EXISTING_DROPLET_ID})"
    DROPLET_IP=$(doctl compute droplet get "${EXISTING_DROPLET_ID}" \
        --format PublicIPv4 --no-header)
    info "public IPv4: ${DROPLET_IP}"
    info ""
    info "If you need to inspect the deploy, ssh in:"
    info "  ssh -i ${SSH_KEY_PATH%.pub} root@${DROPLET_IP}"
    info ""
    info "Re-running this script does not re-execute cloud-init on an"
    info "existing Droplet. To re-run the bootstrap from scratch, destroy"
    info "the Droplet first:"
    info "  doctl compute droplet delete ${EXISTING_DROPLET_ID}"
    exit 0
fi

# ---------------------------------------------------------------------------
# 3. Generate secrets if not provided
# ---------------------------------------------------------------------------

step "Resolving secrets for fresh Droplet"

if [[ -z "${OE_PASS:-}" ]]; then
    OE_PASS=$(gen_secret)
    warn "OE_PASS was not set — generated a random 32-character password."
    warn "SAVE THIS NOW (it will not be displayed again on subsequent runs):"
    printf '\n    OE_PASS for %s: %s\n\n' "${OE_DOMAIN}" "${OE_PASS}"
fi

if [[ -z "${MYSQL_ROOT_PASSWORD:-}" ]]; then
    MYSQL_ROOT_PASSWORD=$(gen_secret)
    warn "MYSQL_ROOT_PASSWORD was not set — generated a random 32-character password."
    warn "SAVE THIS NOW:"
    printf '\n    MYSQL_ROOT_PASSWORD: %s\n\n' "${MYSQL_ROOT_PASSWORD}"
fi

if [[ -z "${AGENT_PG_PASSWORD:-}" ]]; then
    AGENT_PG_PASSWORD=$(gen_secret)
    warn "AGENT_PG_PASSWORD was not set — generated a random 32-character password."
    warn "SAVE THIS NOW:"
    printf '\n    AGENT_PG_PASSWORD: %s\n\n' "${AGENT_PG_PASSWORD}"
fi

# ---------------------------------------------------------------------------
# 4. Render cloud-init script from template
# ---------------------------------------------------------------------------

step "Rendering cloud-init from template"
TEMPLATE="$(dirname "$0")/cloud-init.sh.template"
if [[ ! -f "${TEMPLATE}" ]]; then
    echo "error: template not found at ${TEMPLATE}" >&2
    exit 1
fi

RENDERED=$(mktemp)
trap 'rm -f "${RENDERED}"' EXIT

# Shell-quote each replacement value so it survives sed substitution
# even if it contains characters sed treats specially. We use awk for
# the substitution (one var per pass) — simpler than escaping for sed.
cp "${TEMPLATE}" "${RENDERED}"
substitute() {
    local key="$1" value="$2" tmp
    tmp=$(mktemp)
    awk -v k="__${key}__" -v v="${value}" '
        {
            line = $0
            while ((p = index(line, k)) > 0) {
                printf "%s%s", substr(line, 1, p-1), v
                line = substr(line, p + length(k))
            }
            print line
        }
    ' "${RENDERED}" > "${tmp}"
    mv "${tmp}" "${RENDERED}"
}

substitute "GITLAB_DEPLOY_TOKEN_NAME"  "${GITLAB_DEPLOY_TOKEN_NAME}"
substitute "GITLAB_DEPLOY_TOKEN_VALUE" "${GITLAB_DEPLOY_TOKEN_VALUE}"
substitute "GITLAB_HOST"               "${GITLAB_HOST}"
substitute "GITLAB_REPO_PATH"          "${GITLAB_REPO_PATH}"
substitute "GITLAB_BRANCH"             "${GITLAB_BRANCH}"
substitute "OE_DOMAIN"                 "${OE_DOMAIN}"
substitute "APEX_DOMAIN"               "${APEX_DOMAIN}"
substitute "OE_PASS"                   "${OE_PASS}"
substitute "MYSQL_ROOT_PASSWORD"       "${MYSQL_ROOT_PASSWORD}"
substitute "AGENT_PG_PASSWORD"         "${AGENT_PG_PASSWORD}"

info "rendered cloud-init: ${RENDERED}"

# ---------------------------------------------------------------------------
# 5. Create the Droplet
# ---------------------------------------------------------------------------

step "Creating Droplet '${DROPLET_NAME}' in ${DROPLET_REGION}"
DROPLET_ID=$(doctl compute droplet create "${DROPLET_NAME}" \
    --region "${DROPLET_REGION}" \
    --size "${DROPLET_SIZE}" \
    --image "${DROPLET_IMAGE}" \
    --ssh-keys "${SSH_KEY_ID}" \
    --user-data-file "${RENDERED}" \
    --enable-ipv6 \
    --enable-monitoring \
    --tag-name openemr \
    --wait \
    --format ID --no-header)

DROPLET_IP=$(doctl compute droplet get "${DROPLET_ID}" \
    --format PublicIPv4 --no-header)

info "created Droplet id=${DROPLET_ID}"
info "public IPv4:  ${DROPLET_IP}"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

step "Bootstrap complete"
cat <<EOF

Next steps:

  1. Point DNS at the Droplet:
       A   ${OE_DOMAIN}   ${DROPLET_IP}
     Caddy will fetch a Let's Encrypt cert on first request once the
     A record resolves (typically 1–5 minutes after creation).

  2. Watch cloud-init progress (first boot takes ~5–10 minutes):
       ssh -i ${SSH_KEY_PATH%.pub} root@${DROPLET_IP} \\
         tail -f /var/log/openemr-bootstrap.log

  3. Once cloud-init finishes and DNS resolves:
       https://${OE_DOMAIN}/
     Log in with admin / <OE_PASS shown above>.

  4. To deploy code changes, push to the '${GITLAB_BRANCH}' branch on
     GitLab, then SSH into the Droplet and:
       cd /opt/openemr && git pull
       cd docker/digitalocean && docker compose up -d

EOF
