#!/usr/bin/env bash
#
# Droplet-side deploy script. NOT invoked directly by CI — the runner
# calls infra/runner-bootstrap.sh, which updates the working tree and
# then exec's into this file from the new commit. See the header in
# runner-bootstrap.sh for why we split.
#
# Strategy: rolling recreate of the openemr container only. MariaDB and
# Caddy stay up across the deploy. Caddy holds in-flight connections to
# the old container until it exits, so the switchover window is the few
# seconds between the new container becoming healthy and the old one
# being torn down.
#
# Safe to invoke manually (e.g. `bash infra/deploy.sh`) for a hotfix
# without going through CI — in that case we derive the deployed SHA
# from HEAD, since there's no bootstrap to pass it in.

set -euo pipefail

REPO_DIR=${REPO_DIR:-/opt/openemr}
COMPOSE_DIR="${REPO_DIR}/docker/digitalocean"
HEALTH_URL=${HEALTH_URL:-https://localhost/meta/health/readyz}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-600}

log() { echo "[deploy] $*"; }

log "starting at $(date -Iseconds)"

# When invoked via runner-bootstrap.sh we get OLD/NEW from env. When
# invoked manually, fall back to "we don't know what was running before"
# and use HEAD for the new SHA.
NEW_SHA=${DEPLOY_NEW_SHA:-$(git -C "${REPO_DIR}" rev-parse HEAD)}
OLD_SHA=${DEPLOY_OLD_SHA:-unknown}
log "deploying ${OLD_SHA} -> ${NEW_SHA}"

# Pre-flight: docker compose silently treats an unreadable .env as
# "all variables empty" during `pull`/`up` while hard-failing on
# `exec`/`logs`. That asymmetry once produced a deploy that recreated
# the container with empty env vars and timed out the healthcheck for
# unrelated-looking reasons. Fail loud here instead.
ENV_FILE="${COMPOSE_DIR}/.env"
if [[ ! -r "${ENV_FILE}" ]]; then
    log "FATAL: cannot read ${ENV_FILE} as $(whoami)"
    ls -la "${ENV_FILE}" || true
    exit 1
fi

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
