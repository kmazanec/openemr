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
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}

log() { echo "[deploy] $*"; }

log "starting at $(date -Iseconds)"

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
while (( $(date +%s) < deadline )); do
    if docker compose exec -T openemr curl --fail --insecure --silent \
            --max-time 5 "${HEALTH_URL}" > /dev/null 2>&1; then
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
