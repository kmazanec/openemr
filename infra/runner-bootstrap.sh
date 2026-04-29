#!/usr/bin/env bash
#
# Runner entry point. The GitLab CI job invokes *this* script. It owns
# everything that has to happen BEFORE a release becomes the new code:
# fetch the new commit into a fresh release dir, atomically swap the
# /srv/openemr/current symlink, then exec into the new release's
# infra/deploy.sh which handles the compose recreate + healthcheck.
#
# Why this script exists:
#   The runner re-executes the on-disk copy of whatever script CI calls.
#   If that script also did the deploy work, every fix to the deploy
#   logic would only take effect on the deploy AFTER the one that
#   landed it (bash already read the old version into memory). The
#   exec into the new release's deploy.sh AFTER the symlink swap means
#   changes apply immediately.
#
# Layout this script assumes (set up by infra/cloud-init.sh.template
# on first boot, or migrated to manually on existing Droplets):
#
#   /srv/openemr/releases/<sha>/   immutable per-release checkouts
#   /srv/openemr/current           symlink → releases/<sha>/, atomic swap
#   /srv/openemr/repo.git          bare repo, runner fetches into it
#   /etc/openemr/.env              env file, never touched by container
#   /etc/openemr/docker-compose.yml  compose project, copied on each deploy
#   /etc/openemr/Caddyfile           caddy config, copied on each deploy
#
# Important: any change to THIS file only takes effect on the deploy
# AFTER the one that lands the change (the previous deploy's version of
# this file is what the runner re-invokes). Keep it small. Defer
# evolving logic to deploy.sh which we exec into post-symlink-swap.

set -euo pipefail

REPO_GIT=${REPO_GIT:-/srv/openemr/repo.git}
RELEASES_DIR=${RELEASES_DIR:-/srv/openemr/releases}
CURRENT_LINK=${CURRENT_LINK:-/srv/openemr/current}
BRANCH=${DEPLOY_BRANCH:-master}
KEEP_RELEASES=${KEEP_RELEASES:-2}

log() { echo "[bootstrap] $*"; }

log "fetching ${BRANCH}"
# A --mirror clone keeps remote refs as local refs (refs/heads/*), not
# refs/remotes/origin/*. So we ask for ${BRANCH} directly, not
# origin/${BRANCH}, and `fetch` updates refs/heads/${BRANCH} in place.
git -C "${REPO_GIT}" fetch --quiet origin "${BRANCH}:${BRANCH}"
NEW_SHA=$(git -C "${REPO_GIT}" rev-parse "${BRANCH}")

# Resolve current release (may not exist on first deploy).
if [[ -L "${CURRENT_LINK}" ]]; then
    OLD_SHA=$(basename "$(readlink -f "${CURRENT_LINK}")")
else
    OLD_SHA=""
fi

if [[ "${OLD_SHA}" == "${NEW_SHA}" ]]; then
    log "already at ${NEW_SHA}; nothing to do"
    exit 0
fi

NEW_RELEASE="${RELEASES_DIR}/${NEW_SHA}"
if [[ ! -d "${NEW_RELEASE}" ]]; then
    log "creating release ${NEW_SHA}"
    # `git clone --shared` from a local bare repo is fast and uses
    # hardlinks for the object store — no network round-trip and
    # minimal disk overhead per release.
    git clone --quiet --shared --branch "${BRANCH}" "${REPO_GIT}" "${NEW_RELEASE}"
    git -C "${NEW_RELEASE}" checkout --quiet "${NEW_SHA}"
else
    log "release dir for ${NEW_SHA} already exists; reusing"
fi

DEPLOY_SCRIPT="${NEW_RELEASE}/infra/deploy.sh"
if [[ ! -f "${DEPLOY_SCRIPT}" ]]; then
    log "FATAL: ${DEPLOY_SCRIPT} missing in ${NEW_SHA}; refusing to deploy"
    exit 1
fi

# Atomic symlink swap. `ln -sfn` plus mv -T is the standard atomic
# cutover: write the new symlink under a temp name, then rename it on
# top of the existing one. rename(2) is atomic.
log "swapping ${CURRENT_LINK} ${OLD_SHA:-<none>} -> ${NEW_SHA}"
TMP_LINK="${CURRENT_LINK}.new.$$"
ln -sfn "${NEW_RELEASE}" "${TMP_LINK}"
mv -T "${TMP_LINK}" "${CURRENT_LINK}"

# Pass SHAs and the previous release path to deploy.sh so it can
# log the move and roll back the symlink if the healthcheck fails.
export DEPLOY_OLD_SHA="${OLD_SHA}"
export DEPLOY_NEW_SHA="${NEW_SHA}"
if [[ -n "${OLD_SHA}" ]]; then
    export DEPLOY_OLD_RELEASE="${RELEASES_DIR}/${OLD_SHA}"
fi
export DEPLOY_KEEP_RELEASES="${KEEP_RELEASES}"

log "exec'ing into ${DEPLOY_SCRIPT}"
exec bash "${DEPLOY_SCRIPT}"
