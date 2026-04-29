#!/usr/bin/env bash
#
# Runner entry point. The GitLab CI job invokes *this* script. Its only
# job is to update the working tree and then exec into infra/deploy.sh
# from the freshly-pulled commit.
#
# Why this script exists:
#   The runner re-executes the on-disk copy of whatever script CI calls.
#   If that script is also responsible for `git pull`-ing, it ends up
#   updating itself mid-run — bash has already read the old version into
#   memory, so changes you commit to the deploy logic don't take effect
#   until the deploy AFTER the one that lands them. That made
#   "fix the deploy script" debugging maddening.
#
#   So we split: this bootstrap is intentionally tiny and stable, and
#   the real work lives in infra/deploy.sh which we exec into AFTER the
#   pull. `exec` replaces the bootstrap process entirely, so the new
#   deploy.sh runs as itself, not as a child of the old bootstrap.
#
# Important consequence: any change to THIS file only takes effect on
# the deploy AFTER the one that lands the change (since the previous
# deploy's version of this file is what CI re-invokes). Keep this file
# small. Defer everything that might need to evolve to deploy.sh.

set -euo pipefail

REPO_DIR=${REPO_DIR:-/opt/openemr}
BRANCH=${DEPLOY_BRANCH:-master}

log() { echo "[bootstrap] $*"; }

log "fetching origin/${BRANCH}"
OLD_SHA=$(git -C "${REPO_DIR}" rev-parse HEAD)
git -C "${REPO_DIR}" fetch --quiet origin "${BRANCH}"
NEW_SHA=$(git -C "${REPO_DIR}" rev-parse "origin/${BRANCH}")

if [[ "${OLD_SHA}" == "${NEW_SHA}" ]]; then
    log "already at ${NEW_SHA}; nothing to do"
    exit 0
fi

log "updating ${OLD_SHA} -> ${NEW_SHA}"
git -C "${REPO_DIR}" reset --hard "${NEW_SHA}"

DEPLOY_SCRIPT="${REPO_DIR}/infra/deploy.sh"
if [[ ! -f "${DEPLOY_SCRIPT}" ]]; then
    log "FATAL: ${DEPLOY_SCRIPT} missing in ${NEW_SHA}; refusing to deploy"
    log "the working tree is now at the new commit but the stack is unchanged"
    exit 1
fi

# Pass the SHAs to deploy.sh via env so it can log them without
# re-deriving them from git (which would just show NEW_SHA twice now
# that the working tree is already updated).
export DEPLOY_OLD_SHA="${OLD_SHA}"
export DEPLOY_NEW_SHA="${NEW_SHA}"

log "exec'ing into infra/deploy.sh@${NEW_SHA}"
exec bash "${DEPLOY_SCRIPT}"
