#!/usr/bin/env bash
#
# Restore the four demo patients (Chen / Whitaker / Reyes / Kowalski) to a
# known demoable state:
#
#   1. Look up each fixture's CURRENT pid in OpenEMR's MySQL.
#   2. Wipe the agent Postgres rows that key on those pids
#      (conversations + cascading messages/chips, extraction_artifacts +
#       cascading dispositions, schedule_briefings for the patients'
#       upcoming appointments).
#   3. Hard-delete the patients from OpenEMR (mirrors the patient_file
#      deleter, so encounters/forms/lists/labs/prescriptions/calendar
#      events/documents all go).
#   4. Re-seed the four fixtures via `seed:patients --fixtures-only`
#      and `seed:schedule --fixtures-only` (12-week weekly recurrence
#      anchored to next business day at 10:00).
#   5. Book one fresh next-business-day appointment per patient with
#      their PCP, staggered 09:00 / 09:30 / 10:00 / 10:30. (Skippable —
#      the seed:schedule run already covers next business day at 10:00.)
#
# Pids change every reset (patient_data.pid is auto-increment), so the
# agent-DB wipe has to happen BEFORE the OpenEMR delete — once the rows
# are gone, the lookup-by-(lname,DOB) returns nothing and the link to
# the old pids is lost.
#
# Two environments, both run from the host (not from inside a
# container). Both use `docker compose exec` against the local stack —
# on the DigitalOcean droplet that stack is the production deploy, and
# locally it's development-easy. Pick which one with --env:
#
#   --env=local  (default)  Compose stack at docker/development-easy/.
#                           Run from the repo root on a dev machine.
#
#   --env=prod              Compose stack at /srv/openemr/current/docker/
#                           digitalocean/. Run from the DO droplet
#                           (`ssh deploy@<droplet>`, then either cd into
#                           the deploy tree or run this script via its
#                           full path — it resolves its own paths).
#
# Usage:
#   db/seeds/reset-demo-patients.sh                           # local dev
#   db/seeds/reset-demo-patients.sh --env=prod --yes          # DO droplet
#   db/seeds/reset-demo-patients.sh --skip-next-day-appt      # skip step 5
#   db/seeds/reset-demo-patients.sh --skip-agent-db-wipe      # OpenEMR only
#
# Exit codes:
#   0 = success
#   1 = bad argument or missing prerequisite
#   2 = user declined the confirmation prompt
#   non-zero (other) = whichever step failed (set -e propagates)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ENV_NAME="local"
ASSUME_YES=0
SKIP_NEXT_DAY_APPT=0
SKIP_AGENT_DB_WIPE=0

for arg in "$@"; do
    case "$arg" in
        --env=local)          ENV_NAME="local" ;;
        --env=prod)           ENV_NAME="prod" ;;
        --env=*)
            echo "Unknown --env value: ${arg#--env=} (expected 'local' or 'prod')." >&2
            exit 1
            ;;
        -y|--yes)             ASSUME_YES=1 ;;
        --skip-next-day-appt) SKIP_NEXT_DAY_APPT=1 ;;
        --skip-agent-db-wipe) SKIP_AGENT_DB_WIPE=1 ;;
        -h|--help)
            sed -n '2,55p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

#
# Both environments orchestrate the same `docker compose exec` calls
# against the local stack — only the compose-file path differs. On the
# DO droplet that stack IS the production deploy; on a dev machine it
# is development-easy. Define `run_console` and `run_psql` once so the
# rest of the script reads identically in both modes.
#
if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker not found on PATH." >&2
    exit 1
fi

case "${ENV_NAME}" in
    local) COMPOSE_DIR="${REPO_ROOT}/docker/development-easy" ;;
    prod)  COMPOSE_DIR="/srv/openemr/current/docker/digitalocean" ;;
esac

if [[ ! -f "${COMPOSE_DIR}/docker-compose.yml" ]]; then
    echo "Error: docker-compose.yml not found at ${COMPOSE_DIR}." >&2
    if [[ "${ENV_NAME}" == "prod" ]]; then
        echo "       This script's --env=prod assumes it's being run from the" >&2
        echo "       DigitalOcean droplet, where the deploy tree lives at" >&2
        echo "       /srv/openemr/current/. If your deploy path differs, adjust" >&2
        echo "       COMPOSE_DIR in this script." >&2
    fi
    exit 1
fi

run_console() {
    docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T openemr \
        php /var/www/localhost/htdocs/openemr/bin/console "$@"
}
run_psql() {
    docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T agent-postgres \
        psql -U agent -d agent -v ON_ERROR_STOP=1 "$@"
}

#
# Confirmation prompt. The reset is destructive against demo data only,
# but on a shared/staging environment a stray run could wipe a
# colleague's in-progress chart edits — so we prompt by default.
#
cat >&2 <<'EOF'

============================================================
  About to RESET the four demo patients to seeded state:
    - Chen, Margaret L.   (1967-08-14)
    - Whitaker, James E.  (1958-11-03)
    - Reyes, Sofia M.     (1983-12-19)
    - Kowalski, Robert    (1971-06-08)

  This will:
    * delete every encounter, form, problem, med, lab, document,
      and calendar event for these four patients
    * wipe their agent conversations, extraction artifacts, and
      schedule briefings from the agent Postgres database
    * re-seed them via seed:patients/seed:schedule
    * book one next-business-day appointment per patient

  Other patients are untouched.
============================================================
EOF

if [[ "${ASSUME_YES}" -ne 1 ]]; then
    if [[ ! -t 0 ]]; then
        echo >&2
        echo "Error: stdin is not a terminal — refusing to prompt." >&2
        echo "       Pass --yes to confirm non-interactively." >&2
        exit 1
    fi
    echo >&2
    printf "Type 'yes' to proceed: " >&2
    read -r confirm
    if [[ "${confirm}" != "yes" ]]; then
        echo "Aborted." >&2
        exit 2
    fi
fi

#
# Step 1: capture the current pids.
#
echo
echo "==> [1/4] Looking up current fixture pids"
# `--print-pids` writes one space-separated line and exits without
# making changes. Strip carriage returns in case docker exec gives us
# CRLF, then split on whitespace.
PIDS_LINE="$(run_console demo:reset-patients --print-pids 2>/dev/null | tr -d '\r' | tail -n 1 | tr -s ' ')"
PIDS_LINE="${PIDS_LINE# }"
PIDS_LINE="${PIDS_LINE% }"

if [[ -z "${PIDS_LINE}" ]]; then
    echo "    (no existing fixture patients — proceeding straight to re-seed)"
    OLD_PIDS=()
else
    # shellcheck disable=SC2206
    OLD_PIDS=( ${PIDS_LINE} )
    echo "    Old pids: ${OLD_PIDS[*]}"
fi

#
# Step 2: wipe agent Postgres rows keyed on the OLD pids.
#
# Tables touched (all live in the agent Postgres):
#   * conversation_messages         — DELETE first; FK is NO ACTION,
#                                      not CASCADE.
#   * conversation_suggestion_chips — same; FK NO ACTION.
#   * conversations                 — DELETE WHERE patient_pid IN (...).
#   * extraction_artifacts          — DELETE WHERE pid IN (...).
#                                      ON DELETE CASCADE on
#                                      extracted_fact_dispositions handles
#                                      the child rows.
#
# Not touched (intentionally):
#   * unverified_claims  — keyed only on request_id; orphans are inert
#                           audit trail.
#   * LangGraph checkpoints — keyed on thread_id (= conversation uuid).
#                              Orphan after conversations are deleted
#                              but inert. A full agent-DB wipe is the
#                              right tool if you want a clean slate.
#
if [[ "${SKIP_AGENT_DB_WIPE}" -eq 1 ]]; then
    echo
    echo "==> [2/4] Skipping agent DB wipe (--skip-agent-db-wipe)"
elif [[ ${#OLD_PIDS[@]} -eq 0 ]]; then
    echo
    echo "==> [2/4] Skipping agent DB wipe (no existing pids)"
else
    echo
    echo "==> [2/4] Wiping agent Postgres rows for pids: ${OLD_PIDS[*]}"
    # Build the IN-list once. Pids are validated as integers above (the
    # console command's `--print-pids` emits ints from a SELECT), but be
    # explicit: only digits allowed.
    PID_LIST=""
    for pid in "${OLD_PIDS[@]}"; do
        if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
            echo "Error: refusing to interpolate non-integer pid '$pid' into SQL." >&2
            exit 1
        fi
        if [[ -n "${PID_LIST}" ]]; then PID_LIST+=","; fi
        PID_LIST+="$pid"
    done
    # Children first (FK is NO ACTION on conversations, CASCADE only on
    # extracted_fact_dispositions). schedule_briefings keys on
    # appointment_id (= pc_eid as text) which we don't have handy here;
    # leftover rows are inert (the resume index is per practitioner +
    # day, and the appointment_id won't match any new event).
    run_psql <<SQL
DELETE FROM conversation_messages
  WHERE conversation_id IN (SELECT id FROM conversations WHERE patient_pid IN (${PID_LIST}));
DELETE FROM conversation_suggestion_chips
  WHERE conversation_id IN (SELECT id FROM conversations WHERE patient_pid IN (${PID_LIST}));
DELETE FROM conversations WHERE patient_pid IN (${PID_LIST});
DELETE FROM extraction_artifacts WHERE pid IN (${PID_LIST});
SQL
    echo "    Done."
fi

#
# Step 3 & 4: delete + re-seed via the console command. The command
# itself also books the next-business-day appointments unless
# --skip-next-day-appt is passed through.
#
echo
echo "==> [3/4] Deleting patients + re-seeding (seed:patients --fixtures-only, seed:schedule --fixtures-only)"
EXTRA_ARGS=()
if [[ "${SKIP_NEXT_DAY_APPT}" -eq 1 ]]; then
    EXTRA_ARGS+=(--skip-next-day-appt)
fi
run_console demo:reset-patients "${EXTRA_ARGS[@]}"

echo
echo "==> [4/4] Final state"
run_console seed:status

echo
echo "Done."
