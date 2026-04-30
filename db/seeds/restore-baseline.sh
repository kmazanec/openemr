#!/usr/bin/env bash
#
# Restore db/seeds/baseline.sql.gz into the OpenEMR database for the current
# site. Designed to run *inside* the OpenEMR container (locally via
# `docker compose exec openemr ...`).
#
# Safety guards:
#   * Refuses if patient_data already has rows, unless --force.
#   * With --force, additionally checks the users table — if it contains any
#     username that's not in the upstream baseline dump, the operator is
#     prompted to confirm. That username mismatch is the strong tell that
#     this is a real environment (created users, edited admin) rather than
#     a fresh dev one. Pass --yes to bypass the prompt non-interactively.
#
# Usage:
#   db/seeds/restore-baseline.sh                # default site
#   db/seeds/restore-baseline.sh --site=other   # named site
#   db/seeds/restore-baseline.sh --force        # restore over an existing seeded DB
#   db/seeds/restore-baseline.sh --force --yes  # additionally bypass user-mismatch prompt
#
# Exit codes:
#   0 = success
#   1 = config / dump missing or bad argument
#   2 = patient_data non-empty (without --force)
#   3 = mariadb restore failed
#   4 = user declined the user-mismatch prompt
#   5 = stdin not a tty and --yes not provided when prompt was needed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DUMP_PATH="${SCRIPT_DIR}/baseline.sql.gz"

# Usernames present in the upstream baseline dump. Any username on the
# target environment that isn't in this list is a strong signal we're
# running over a real installation that we shouldn't silently flatten.
BASELINE_USERNAMES=(
    "admin"
    "phimail-service"
    "portal-user"
    "accountant"
    "clinician"
    "physician"
    "receptionist"
    "zhportal"
    "oe-system"
)

SITE="default"
FORCE=0
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --site=*) SITE="${arg#--site=}" ;;
        --force)  FORCE=1 ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help)
            sed -n '2,28p' "${BASH_SOURCE[0]}"
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

# Helper for one-shot SELECTs (no headers).
db_query() {
    MYSQL_PWD="${DB_PASS}" mariadb \
        --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_LOGIN}" "${DB_NAME}" \
        -Nse "$1" 2>/dev/null
}

echo "==> Database: ${DB_LOGIN}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "==> Dump:     ${DUMP_PATH} ($(du -h "${DUMP_PATH}" | cut -f1))"

# patient_data may not exist yet (genuinely empty schema). Treat that as zero.
EXISTING=$(db_query "SELECT COUNT(*) FROM patient_data" || echo 0)

if [[ "${EXISTING}" -gt 0 && "${FORCE}" -ne 1 ]]; then
    echo "Error: patient_data already contains ${EXISTING} rows. Refusing to restore." >&2
    echo "       Use --force to override (existing rows will cause INSERT collisions)." >&2
    exit 2
fi

# When --force was used and there are existing users, check whether the
# target environment has any username that isn't in our baseline dump.
# That's the strongest signal we're about to wipe a real installation.
if [[ "${FORCE}" -eq 1 ]]; then
    USERS_EXIST=$(db_query "SELECT COUNT(*) FROM users" || echo 0)
    if [[ "${USERS_EXIST}" -gt 0 ]]; then
        EXISTING_USERS=$(db_query "SELECT username FROM users WHERE username IS NOT NULL AND username != ''" || true)

        # Build the baseline lookup as a newline-delimited blob, then grep
        # the live list against it to find usernames not in the baseline.
        BASELINE_LIST=$(printf "%s\n" "${BASELINE_USERNAMES[@]}")
        UNKNOWN_USERS=$(printf "%s\n" "${EXISTING_USERS}" \
            | grep -vxF -f <(printf "%s\n" "${BASELINE_LIST}") \
            | grep -v '^$' \
            || true)

        if [[ -n "${UNKNOWN_USERS}" ]]; then
            cat >&2 <<EOF

============================================================
  WARNING — non-baseline users detected
============================================================
  The target database contains usernames that aren't in the
  upstream baseline dump:

$(printf '    - %s\n' ${UNKNOWN_USERS})

  This usually means the target is a real installation, not
  a fresh dev environment. Restoring the baseline will
  permanently replace these accounts (and the admin password)
  with the upstream demo accounts.

  If this is unexpected, abort now.
============================================================
EOF

            if [[ "${ASSUME_YES}" -ne 1 ]]; then
                if [[ ! -t 0 ]]; then
                    echo >&2
                    echo "Error: stdin is not a terminal — refusing to prompt." >&2
                    echo "       Pass --yes to confirm non-interactively." >&2
                    exit 5
                fi
                echo >&2
                printf "Type 'yes' to overwrite these users with baseline accounts: " >&2
                read -r confirm
                if [[ "${confirm}" != "yes" ]]; then
                    echo "Aborted." >&2
                    exit 4
                fi
            fi
        fi
    fi
fi

echo "==> Restoring (this can take ~30s)..."
START=$(date +%s)

if ! gzip -dc "${DUMP_PATH}" | MYSQL_PWD="${DB_PASS}" mariadb \
        --host="${DB_HOST}" --port="${DB_PORT}" --user="${DB_LOGIN}" "${DB_NAME}"; then
    echo "Error: mariadb restore failed." >&2
    exit 3
fi

ELAPSED=$(( $(date +%s) - START ))

PATIENTS_AFTER=$(db_query "SELECT COUNT(*) FROM patient_data")

echo "==> Done in ${ELAPSED}s. patient_data now has ${PATIENTS_AFTER} rows."
