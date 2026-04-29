#!/usr/bin/env bash
#
# Regenerate db/seeds/baseline.sql.gz from a clean local OpenEMR demo install.
#
# Workflow:
#   1. Reset the local dev DB to upstream demo state (admin/pass + 3 demo patients)
#   2. Dump the result, gzip it, and overwrite baseline.sql.gz
#   3. Smoke-test the dump by round-tripping it through a scratch database
#
# Run this from the repo root (or anywhere — paths are absolute via git rev-parse).
# Requires the local docker/development-easy stack to be running.
#
# Why this exists: the baseline dump is committed to the repo so deployments can
# restore a known-good demo DB. When OpenEMR's schema or upstream demo data
# changes (new migration, new lookup table, etc.), regenerate the dump so a
# fresh deploy doesn't import a stale baseline.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
DUMP_PATH="${REPO_ROOT}/db/seeds/baseline.sql.gz"
MYSQL_CONTAINER="development-easy-mysql-1"
SCRATCH_DB="baseline_smoketest"

if ! docker ps --format '{{.Names}}' | grep -q "^${MYSQL_CONTAINER}$"; then
    echo "Error: ${MYSQL_CONTAINER} is not running. Start the dev stack first:"
    echo "  cd docker/development-easy && docker compose up --detach --wait"
    exit 1
fi

echo "==> Resetting local OpenEMR to upstream demo state"
openemr-cmd dev-reset-install-demodata > /tmp/baseline-reset.log 2>&1
echo "    (full log: /tmp/baseline-reset.log)"

echo "==> Dumping openemr database"
docker exec "${MYSQL_CONTAINER}" mariadb-dump \
    -uroot -proot \
    --single-transaction \
    --quick \
    --skip-lock-tables \
    openemr | gzip -9 > "${DUMP_PATH}"

DUMP_SIZE=$(ls -lh "${DUMP_PATH}" | awk '{print $5}')
echo "    Wrote ${DUMP_PATH} (${DUMP_SIZE})"

echo "==> Smoke-testing dump against scratch database '${SCRATCH_DB}'"
docker exec "${MYSQL_CONTAINER}" mariadb -uroot -proot \
    -e "DROP DATABASE IF EXISTS ${SCRATCH_DB}; CREATE DATABASE ${SCRATCH_DB};"

gzip -dc "${DUMP_PATH}" | docker exec -i "${MYSQL_CONTAINER}" \
    mariadb -uroot -proot "${SCRATCH_DB}"

COUNTS=$(docker exec "${MYSQL_CONTAINER}" mariadb -uroot -proot "${SCRATCH_DB}" \
    -Nse "SELECT CONCAT(
        (SELECT COUNT(*) FROM patient_data), ' patients, ',
        (SELECT COUNT(*) FROM users), ' users, ',
        (SELECT COUNT(*) FROM list_options), ' list_options'
    );")
echo "    Restored: ${COUNTS}"

docker exec "${MYSQL_CONTAINER}" mariadb -uroot -proot \
    -e "DROP DATABASE ${SCRATCH_DB};"

echo
echo "Baseline regenerated. Review the diff and commit:"
echo "  git diff --stat ${DUMP_PATH}"
echo "  git add ${DUMP_PATH} && git commit"
