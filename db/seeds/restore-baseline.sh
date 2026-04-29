#!/usr/bin/env bash
#
# Restore db/seeds/baseline.sql.gz into the OpenEMR database for the current
# site. Designed to run *inside* the OpenEMR container (locally via
# `docker compose exec openemr ...` or in Railway via `railway ssh`).
#
# Refuses to run if patient_data already has rows, so this can't accidentally
# clobber a populated environment. Override with --force.
#
# Usage:
#   db/seeds/restore-baseline.sh                # default site
#   db/seeds/restore-baseline.sh --site=other   # named site
#   db/seeds/restore-baseline.sh --force        # restore even if patient_data has rows
#
# Exit codes:
#   0 = success
#   1 = config / dump missing
#   2 = patient_data non-empty (without --force)
#   3 = mariadb restore failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DUMP_PATH="${SCRIPT_DIR}/baseline.sql.gz"

SITE="default"
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --site=*) SITE="${arg#--site=}" ;;
        --force)  FORCE=1 ;;
        -h|--help)
            sed -n '2,20p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

SQLCONF="${REPO_ROOT}/sites/${SITE}/sqlconf.php"
if [[ ! -f "${SQLCONF}" ]]; then
    echo "Error: ${SQLCONF} not found." >&2
    exit 1
fi
if [[ ! -f "${DUMP_PATH}" ]]; then
    echo "Error: ${DUMP_PATH} not found." >&2
    exit 1
fi

# Pull connection settings out of sqlconf.php via a short PHP one-liner.
# Outputs five tab-separated values: host, port, login, pass, dbase.
read -r DB_HOST DB_PORT DB_LOGIN DB_PASS DB_NAME <<< "$(php -r '
    require $argv[1];
    echo implode("\t", [$host, $port, $login, $pass, $dbase]);
' "${SQLCONF}")"

if [[ -z "${DB_HOST}" || -z "${DB_LOGIN}" || -z "${DB_NAME}" ]]; then
    echo "Error: failed to read DB settings from ${SQLCONF}" >&2
    exit 1
fi

echo "==> Database: ${DB_LOGIN}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "==> Dump:     ${DUMP_PATH} ($(du -h "${DUMP_PATH}" | cut -f1))"

# patient_data may not exist yet (genuinely empty schema). Treat that as zero.
EXISTING=$(MYSQL_PWD="${DB_PASS}" mariadb \
    --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_LOGIN}" "${DB_NAME}" \
    -Nse "SELECT COUNT(*) FROM patient_data" 2>/dev/null || echo 0)

if [[ "${EXISTING}" -gt 0 && "${FORCE}" -ne 1 ]]; then
    echo "Error: patient_data already contains ${EXISTING} rows. Refusing to restore." >&2
    echo "       Use --force to override (existing rows will cause INSERT collisions)." >&2
    exit 2
fi

echo "==> Restoring (this can take ~30s)..."
START=$(date +%s)

if ! gzip -dc "${DUMP_PATH}" | MYSQL_PWD="${DB_PASS}" mariadb \
        --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_LOGIN}" "${DB_NAME}"; then
    echo "Error: mariadb restore failed." >&2
    exit 3
fi

ELAPSED=$(( $(date +%s) - START ))

PATIENTS_AFTER=$(MYSQL_PWD="${DB_PASS}" mariadb \
    --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_LOGIN}" "${DB_NAME}" \
    -Nse "SELECT COUNT(*) FROM patient_data")

echo "==> Done in ${ELAPSED}s. patient_data now has ${PATIENTS_AFTER} rows."
