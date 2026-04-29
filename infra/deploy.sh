#!/usr/bin/env bash
#
# Droplet-side deploy script. Invoked over SSH from GitLab CI on every
# push to master. Idempotent and safe to re-run.
#
# Strategy: rolling recreate of the openemr container only. MariaDB and
# Caddy stay up across the deploy. Caddy holds in-flight connections to
# the old container until it exits, so the switchover window is the few
# seconds between the new container becoming healthy and the old one
# being torn down.

set -euo pipefail

REPO_DIR=${REPO_DIR:-/opt/openemr}
COMPOSE_DIR="${REPO_DIR}/docker/digitalocean"
BRANCH=${DEPLOY_BRANCH:-master}
HEALTH_URL=${HEALTH_URL:-https://localhost/meta/health/readyz}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-600}

log() { echo "[deploy] $*"; }

log "starting at $(date -Iseconds)"

# Pre-flight: docker compose silently treats an unreadable .env as
# "all variables empty" during `pull`/`up` while hard-failing on
# `exec`/`logs`. That asymmetry once produced a deploy that recreated
# the container with empty env vars and timed out the healthcheck for
# unrelated-looking reasons. Fail loud here instead.
ENV_FILE="${REPO_DIR}/docker/digitalocean/.env"
if [[ ! -r "${ENV_FILE}" ]]; then
    log "FATAL: cannot read ${ENV_FILE} as $(whoami)"
    ls -la "${ENV_FILE}" || true
    exit 1
fi

cd "${REPO_DIR}"
log "fetching origin/${BRANCH}"
git fetch --quiet origin "${BRANCH}"

OLD_SHA=$(git rev-parse HEAD)
NEW_SHA=$(git rev-parse "origin/${BRANCH}")

if [[ "${OLD_SHA}" == "${NEW_SHA}" ]]; then
    log "already at ${NEW_SHA}; nothing to do"
    exit 0
fi

log "deploying ${OLD_SHA} -> ${NEW_SHA}"
git reset --hard "origin/${BRANCH}"

cd "${COMPOSE_DIR}"
log "pulling images"
docker compose pull --quiet

log "recreating openemr container"
# --no-deps: don't touch mysql or caddy
# --force-recreate: pick up the new bind-mounted code even if the image
#   digest hasn't changed (it usually hasn't — the code change is in the
#   bind-mount, not the image).
docker compose up --detach --no-deps --force-recreate openemr

log "waiting for ${HEALTH_URL} (timeout ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
# Don't suppress stderr — if `docker compose exec` itself fails (e.g.
# can't read .env), we want it visible in the CI log instead of looking
# like a slow startup.
while (( $(date +%s) < deadline )); do
    if docker compose exec -T openemr curl --fail --insecure --silent \
            --max-time 5 "${HEALTH_URL}" > /dev/null; then
        log "healthy"
        log "complete at $(date -Iseconds)"
        exit 0
    fi
    sleep 5
done

log "health check did not pass within ${HEALTH_TIMEOUT}s"
log "container logs (last 50 lines):"
docker compose logs --tail=50 openemr || true
exit 1
