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
install -D -m 0644 "${RELEASE_DIR}/docker/digitalocean/docker-compose.yml" \
    "${CONFIG_DIR}/docker-compose.yml"
install -D -m 0644 "${RELEASE_DIR}/docker/digitalocean/Caddyfile" \
    "${CONFIG_DIR}/Caddyfile"

ENV_FILE="${CONFIG_DIR}/.env"
if [[ ! -r "${ENV_FILE}" ]]; then
    log "FATAL: cannot read ${ENV_FILE} as $(whoami)"
    ls -la "${ENV_FILE}" || true
    exit 1
fi

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

log "recreating openemr container"
docker compose up --detach --no-deps --force-recreate openemr

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
# 4. Healthcheck loop.
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
# 4. Prune old releases (keep the most recent KEEP_RELEASES).
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
        rm -rf "${r}"
    fi
done

log "complete at $(date -Iseconds)"
