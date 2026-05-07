#!/usr/bin/env bash
#
# Per-release deploy script. Invoked by infra/runner-bootstrap.sh AFTER
# the /srv/openemr/current symlink has been swapped to point at the new
# release. Handles: copying compose config to /etc/openemr/, recreating
# the openemr container, healthchecking it, rolling back the symlink
# if the new release fails to come up healthy, and pruning old releases.
#
# Safe to invoke manually for a redeploy of the currently-symlinked
# release without going through CI:
#
#   bash /srv/openemr/current/infra/deploy.sh

set -euo pipefail

CONFIG_DIR=${CONFIG_DIR:-/etc/openemr}
RELEASE_DIR=${RELEASE_DIR:-/srv/openemr/current}
RELEASES_DIR=${RELEASES_DIR:-/srv/openemr/releases}
CURRENT_LINK=${CURRENT_LINK:-/srv/openemr/current}
HEALTH_URL=${HEALTH_URL:-https://localhost/meta/health/readyz}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-600}
KEEP_RELEASES=${DEPLOY_KEEP_RELEASES:-2}

# When invoked via runner-bootstrap.sh we get OLD/NEW from env. Manual
# invocations don't, in which case we treat the symlink target as both.
NEW_SHA=${DEPLOY_NEW_SHA:-$(basename "$(readlink -f "${CURRENT_LINK}")")}
OLD_SHA=${DEPLOY_OLD_SHA:-unknown}
OLD_RELEASE=${DEPLOY_OLD_RELEASE:-}

log() { echo "[deploy] $*"; }

log "starting at $(date -Iseconds)"
log "deploying ${OLD_SHA} -> ${NEW_SHA}"

# ---------------------------------------------------------------------
# 1. Copy compose config into /etc/openemr.
# ---------------------------------------------------------------------
# The compose file in the repo is the source of truth. /etc/openemr/ is
# outside any bind-mount, so the container can never chown it, and the
# runner can always read .env. Caddyfile rides along because the compose
# file's relative `./Caddyfile` mount resolves against /etc/openemr/.
log "syncing compose config to ${CONFIG_DIR}"
# rsync the whole tree so build-context subdirs (e.g. agent-pg-backup/)
# land alongside docker-compose.yml — `compose pull` triggers a bake of
# locally-built services, and bake resolves `build.context` relative to
# the compose file, so a missing subdir aborts the deploy. --exclude=.env
# preserves the env file that's only on disk in /etc/openemr/.
rsync --archive --delete --exclude=.env \
    "${RELEASE_DIR}/docker/digitalocean/" "${CONFIG_DIR}/"

ENV_FILE="${CONFIG_DIR}/.env"
if [[ ! -r "${ENV_FILE}" ]]; then
    log "FATAL: cannot read ${ENV_FILE} as $(whoami)"
    ls -la "${ENV_FILE}" || true
    exit 1
fi

# ---------------------------------------------------------------------
# 1.5. Build the patient dashboard SPA bundle.
# ---------------------------------------------------------------------
# The dashboard at /dashboard/ (T1 onward) is a Vite-built React SPA.
# Its build output, dashboard/dist/, is intentionally NOT vendored
# into git — we build it here, into the release tree, before the
# openemr container starts.
#
# The flex entrypoint rsyncs the bind-mounted /openemr source into
# the container's writable docroot on boot (with --ignore-existing,
# which is fine because dist/ doesn't yet exist in the docroot on a
# fresh recreate). Apache then serves /dashboard/* off dist/ via the
# T1.6 .htaccess rewrite.
#
# Build runs in a one-shot node:22-alpine container:
#   - Node-on-host avoided: the 2 GB Droplet has no Node toolchain
#     and we don't want to add one.
#   - Mounts the *release tree* (not /srv/openemr/current) so a
#     concurrent symlink swap by a follow-up deploy can't hand us a
#     half-built workdir.
#   - Named volume for node_modules so subsequent deploys reuse the
#     install — first deploy ~30s, repeat deploys ~5s.
log "building dashboard/dist/ for ${NEW_SHA}"
# Run the build container as the host user so dashboard/dist/ ends up
# owned by the deploy user, not root. Otherwise the prune step at the
# end of this script (running unprivileged) can't `rm -rf` previous
# releases and we leak release directories on every deploy.
#
# The named-volume node_modules cache also has to be writable by that
# UID. On a fresh volume Docker creates the mountpoint as root:root, so
# we one-shot a chown as root before the unprivileged build runs.
#
# Recursive: an earlier deploy may have populated the volume as root
# (older builder image, or before this script ran the build container
# unprivileged). `npm ci` wipes node_modules/ before reinstalling and
# would EACCES on root-owned files like .bin/acorn. The recursive
# chown is slow on the recovery deploy (~30k files) but a no-op on
# subsequent deploys once the volume is deploy-user-owned.
DEPLOY_UID=$(id -u)
DEPLOY_GID=$(id -g)
docker run --rm \
    -v openemr-deploy-dashboard-node-modules:/cache \
    alpine:3 chown -R "${DEPLOY_UID}:${DEPLOY_GID}" /cache

# Vite inlines `import.meta.env.VITE_*` at build time, so the dashboard
# bundle only knows the OIDC issuer/client/redirect/scope if those vars
# are set in the build container. Source the shared /etc/openemr/.env
# in a subshell, then forward only the four VITE_OIDC_* keys to docker
# — narrowing keeps the rest of the .env (Spaces creds, Pinecone,
# LangSmith, etc.) out of the build context and the bundle.
#
# Missing vars trip getOidcConfig() at app startup with a descriptive
# error, so we don't silently ship a broken bundle. We `source` rather
# than `eval`-after-grep because .env values may contain unquoted
# spaces (e.g. VITE_OIDC_SCOPE is a space-separated SMART scope list).
# `set -a` exports each key=value as we source.
(
    set -a
    # shellcheck disable=SC1090
    . "${ENV_FILE}"
    set +a
    : "${VITE_OIDC_ISSUER:?VITE_OIDC_ISSUER missing from ${ENV_FILE}}"
    : "${VITE_OIDC_CLIENT_ID:?VITE_OIDC_CLIENT_ID missing from ${ENV_FILE}}"
    : "${VITE_OIDC_REDIRECT_URI:?VITE_OIDC_REDIRECT_URI missing from ${ENV_FILE}}"
    : "${VITE_OIDC_SCOPE:?VITE_OIDC_SCOPE missing from ${ENV_FILE}}"
    docker run --rm \
        --user "${DEPLOY_UID}:${DEPLOY_GID}" \
        -v "${RELEASE_DIR}:/work-root" \
        -v openemr-deploy-dashboard-node-modules:/work-root/dashboard/node_modules \
        -w /work-root/dashboard \
        -e HOME=/tmp \
        -e npm_config_cache=/tmp/.npm \
        -e VITE_OIDC_ISSUER \
        -e VITE_OIDC_CLIENT_ID \
        -e VITE_OIDC_REDIRECT_URI \
        -e VITE_OIDC_SCOPE \
        node:22-alpine \
        sh -c 'npm ci --no-audit --no-fund && npm run build'
)

# ---------------------------------------------------------------------
# 2. Recreate the openemr container.
# ---------------------------------------------------------------------
cd "${CONFIG_DIR}"
log "pulling images"
docker compose pull --quiet

# Ensure all services are up (mysql, caddy). compose up with no service
# arg leaves running containers alone and starts any that are missing —
# matters after a `compose down` or a fresh Droplet, otherwise the
# subsequent --no-deps openemr recreate would happen with no DB.
log "ensuring full stack is up"
docker compose up --detach

log "rebuilding and recreating agent container"
# The agent's source lives in /srv/openemr/current/agent and is built from
# the release tree on every deploy. Without an explicit rebuild + recreate
# `compose up` is a no-op for a still-healthy agent and the running
# container keeps serving stale code (and may be missing env vars added
# in the new release's compose). Schema setup for the agent's Postgres
# tables (LangGraph checkpointer, conversations, unverified-claims log)
# runs in the agent's startup path, so the recreate doubles as the
# agent-side migration step.
docker compose up --detach --no-deps --build --force-recreate agent

log "waiting for agent /health"
agent_deadline=$(( $(date +%s) + 120 ))
agent_healthy=0
while (( $(date +%s) < agent_deadline )); do
    if docker compose exec -T agent wget --quiet --tries=1 --spider \
            http://127.0.0.1:8080/health 2>/dev/null; then
        log "agent healthy"
        agent_healthy=1
        break
    fi
    sleep 3
done
if (( agent_healthy == 0 )); then
    log "agent did not become healthy within 120s"
    docker compose logs --tail=80 agent || true
    exit 1
fi

log "rebuilding and recreating openemr container"
# `--build` rebuilds the thin derived image
# (docker/digitalocean/openemr/Dockerfile) which adds the `tiff` Alpine
# package to upstream `openemr/openemr:flex` so ext-imagick has the
# libtiff delegate F.4b's session-side TIFF -> PNG decode depends on.
# Without --build, compose would skip the local build step and reuse a
# stale derived image (or worse, fall through to the upstream image
# without the delegate).
docker compose up --detach --no-deps --build --force-recreate openemr

# ---------------------------------------------------------------------
# 3. Make dependency installs deterministic.
# ---------------------------------------------------------------------
# The flex image's entrypoint already runs composer install + npm
# install + npm run build, but only if vendor/ and node_modules/ look
# empty. On a 2GB Droplet the entrypoint has historically been OOM-
# killed mid-install, leaving partial state — and on the next boot
# the entrypoint sees a non-empty vendor/ and *skips* the install,
# keeping the broken state forever. Run the same steps unconditionally
# from the deploy so a partial state can heal on its own.
#
# Mirrors the entrypoint's logic (see /var/www/localhost/htdocs/openemr.sh
# in the flex image): composer install --no-dev, npm install +
# npm run build (which needs devDependencies for gulp), then optimize.
log "waiting for container to accept exec"
for i in $(seq 1 30); do
    if docker compose exec -T openemr true 2>/dev/null; then
        break
    fi
    sleep 2
done

# Run a command inside openemr, retrying for up to 5 minutes. The flex
# entrypoint copies the source tree from /openemr (ro) to the runtime
# path concurrently with Apache startup, so an `exec` that arrives
# before the copy finishes can see partial state — a previous deploy
# died on `composer install` because library/classes/ wasn't on disk
# yet. Retry until the file tree is complete or we give up.
retry_in_container() {
    local desc=$1
    shift
    local cmd="$*"
    local deadline=$(( $(date +%s) + 300 ))
    while (( $(date +%s) < deadline )); do
        if docker compose exec -T openemr sh -c "${cmd}"; then
            return 0
        fi
        log "${desc} failed; retrying in 10s"
        sleep 10
    done
    log "${desc} did not succeed within 5 minutes"
    return 1
}

log "running composer install"
retry_in_container "composer install" \
    "cd /var/www/localhost/htdocs/openemr && composer install --no-dev --no-interaction --no-progress"

log "running npm install + build"
retry_in_container "npm install + build" \
    "cd /var/www/localhost/htdocs/openemr && npm install --unsafe-perm --no-audit --no-fund && npm run build"

log "optimizing autoloader"
retry_in_container "composer dump-autoload" \
    "cd /var/www/localhost/htdocs/openemr && composer dump-autoload --optimize --apcu --no-interaction"

# ---------------------------------------------------------------------
# 4. Apply Doctrine migrations.
# ---------------------------------------------------------------------
# Doctrine Migrations is the upstream-supported successor to the legacy
# sql_upgrade.php / database.sql flow (see PR #10704). The legacy system
# still runs automatically via the flex entrypoint (EASY_DEV_MODE=yes);
# this is for new schema added under db/Migrations/. Idempotent —
# `migrations:migrate` is a no-op when the DB is already current.
#
# Runs *after* composer dump-autoload because the migration classes
# autoload via the OpenEMR\Core\Migrations PSR-4 namespace, and *before*
# the healthcheck so a failed migration aborts the deploy and triggers
# the existing rollback path.
log "applying Doctrine migrations"
retry_in_container "doctrine migrations" \
    "cd /var/www/localhost/htdocs/openemr && ./cli migrations:migrate --no-interaction --allow-no-migration"

# ---------------------------------------------------------------------
# 5. Healthcheck loop.
# ---------------------------------------------------------------------
log "waiting for ${HEALTH_URL} (timeout ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while (( $(date +%s) < deadline )); do
    if docker compose exec -T openemr curl --fail --insecure --silent \
            --max-time 5 "${HEALTH_URL}" > /dev/null; then
        log "healthy"
        break
    fi
    sleep 5
done

if (( $(date +%s) >= deadline )); then
    log "health check did not pass within ${HEALTH_TIMEOUT}s"
    log "container logs (last 50 lines):"
    docker compose logs --tail=50 openemr || true

    # Roll back the symlink to the previous release and recreate the
    # container. If there is no previous release (first deploy ever),
    # we have nothing to roll back to — just fail.
    if [[ -n "${OLD_RELEASE}" && -d "${OLD_RELEASE}" ]]; then
        log "rolling back ${CURRENT_LINK} -> ${OLD_SHA}"
        TMP_LINK="${CURRENT_LINK}.rollback.$$"
        ln -sfn "${OLD_RELEASE}" "${TMP_LINK}"
        mv -T "${TMP_LINK}" "${CURRENT_LINK}"
        log "recreating openemr from rolled-back release"
        docker compose up --detach --no-deps --force-recreate openemr || true
    else
        log "no previous release to roll back to"
    fi
    exit 1
fi

# ---------------------------------------------------------------------
# 6. Prune old releases (keep the most recent KEEP_RELEASES).
# ---------------------------------------------------------------------
# Sort by mtime descending; the first N we keep, the rest get removed.
# Always keep whatever the symlink currently points at, even if its
# mtime would otherwise put it outside the keep window.
KEEP_TARGET=$(readlink -f "${CURRENT_LINK}")
log "pruning ${RELEASES_DIR} (keeping ${KEEP_RELEASES} + current)"
mapfile -t all_releases < <(ls -1dt "${RELEASES_DIR}"/*/ 2>/dev/null | sed 's:/$::')
kept=0
for r in "${all_releases[@]}"; do
    if [[ "${r}" == "${KEEP_TARGET}" ]]; then
        log "keep ${r} (current)"
        continue
    fi
    if (( kept < KEEP_RELEASES - 1 )); then
        log "keep ${r}"
        kept=$(( kept + 1 ))
    else
        log "prune ${r}"
        # Fall back to docker if rm hits permission denied. Older
        # releases (pre-fix) have root-owned dashboard/dist/ files left
        # behind by the build container; the unprivileged deploy user
        # can't delete those directly.
        if ! rm -rf "${r}" 2>/dev/null; then
            log "rm -rf ${r} failed; retrying via docker as root"
            docker run --rm \
                -v "${RELEASES_DIR}:/releases" \
                alpine:3 rm -rf "/releases/$(basename "${r}")"
        fi
    fi
done

log "complete at $(date -Iseconds)"
