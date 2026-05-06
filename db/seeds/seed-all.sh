#!/usr/bin/env bash
#
# Run the full seed pipeline end-to-end. Designed to run *inside* the OpenEMR
# container (locally via `docker compose exec openemr db/seeds/seed-all.sh`
# or on a server via `ssh` + `docker compose exec`).
#
# Order matters:
#   1. restore-baseline.sh   — clean slate (skip with --skip-baseline)
#   2. seed:patients         — archetype-driven patients with clinical scaffolding
#   3. seed:availability     — recurring In Office / Out Of Office blocks per provider
#   4. seed:schedule         — calendar appointments using the availability blocks
#   5. seed:status           — final summary
#
# Step 3 must precede step 4: without availability blocks, OpenEMR treats
# every provider as unavailable and patient check-in fails on appointments
# created in step 4.
#
# Production safety:
#   The baseline restore step is destructive — it replaces every table in
#   the database, including the users table. On any environment where the
#   real admin password and real users matter, pass --skip-baseline so the
#   pipeline only runs the four additive/idempotent steps. The script
#   prompts for confirmation before running the destructive step unless
#   --yes is also passed (and refuses to proceed at all without --yes when
#   stdin is not a terminal).
#
# Usage:
#   db/seeds/seed-all.sh                          # 100 patients, 10 schedule days
#   db/seeds/seed-all.sh --count=50 --days=14     # custom counts
#   db/seeds/seed-all.sh --skip-baseline          # PRODUCTION: additive run
#   db/seeds/seed-all.sh --fixtures-only          # only seed/refresh the docs/example-documents fixture patients + their weekly appts (skips random fill)
#   db/seeds/seed-all.sh --seed=42                # deterministic Faker output
#   db/seeds/seed-all.sh --yes                    # skip the confirmation prompt
#
# Note: from inside the container, run with the absolute path —
#   docker compose exec openemr /var/www/localhost/htdocs/openemr/db/seeds/seed-all.sh ...
# (the container's default cwd is one level above the openemr/ directory).
#
# Exit codes:
#   0 = success
#   1 = bad argument or refusal to overwrite without --yes in non-tty mode
#   2 = user declined the confirmation prompt
#   non-zero (other) = whichever step failed (set -e propagates)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONSOLE="${REPO_ROOT}/bin/console"

COUNT=100
DAYS=10
WEEKS=26
SEED=""
SKIP_BASELINE=0
FORCE_BASELINE=0
ASSUME_YES=0
FIXTURES_ONLY=0

for arg in "$@"; do
    case "$arg" in
        --count=*)         COUNT="${arg#--count=}" ;;
        --days=*)          DAYS="${arg#--days=}" ;;
        --weeks=*)         WEEKS="${arg#--weeks=}" ;;
        --seed=*)          SEED="${arg#--seed=}" ;;
        --skip-baseline)   SKIP_BASELINE=1 ;;
        --force-baseline)  FORCE_BASELINE=1 ;;
        --fixtures-only)   FIXTURES_ONLY=1; SKIP_BASELINE=1 ;;
        -y|--yes)          ASSUME_YES=1 ;;
        -h|--help)
            sed -n '2,40p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

FIXTURES_ARG=""
if [[ "${FIXTURES_ONLY}" -eq 1 ]]; then
    FIXTURES_ARG="--fixtures-only"
fi

SEED_ARG=""
if [[ -n "${SEED}" ]]; then
    SEED_ARG="--seed=${SEED}"
fi

# Confirm before the destructive step unless --skip-baseline was passed.
if [[ "${SKIP_BASELINE}" -ne 1 ]]; then
    cat >&2 <<'EOF'

============================================================
  WARNING — destructive operation about to run
============================================================
  Step 1 (restore-baseline.sh) will drop and replace every
  table in the OpenEMR database. This includes the users
  table, so your admin password and any real user accounts
  will be replaced with the upstream demo accounts.

  On a production-like environment, abort and re-run with
  --skip-baseline so only the additive/idempotent steps run.
============================================================
EOF

    if [[ "${ASSUME_YES}" -ne 1 ]]; then
        if [[ ! -t 0 ]]; then
            echo >&2
            echo "Error: stdin is not a terminal — refusing to prompt." >&2
            echo "       Pass --yes to confirm non-interactively, or" >&2
            echo "       --skip-baseline to skip the destructive step." >&2
            exit 1
        fi
        echo >&2
        printf "Type 'yes' to proceed with the destructive baseline restore: " >&2
        read -r confirm
        if [[ "${confirm}" != "yes" ]]; then
            echo "Aborted." >&2
            exit 2
        fi
    fi
fi

if [[ "${SKIP_BASELINE}" -ne 1 ]]; then
    echo "==> [1/5] Restoring baseline"
    if [[ "${FORCE_BASELINE}" -eq 1 ]]; then
        "${SCRIPT_DIR}/restore-baseline.sh" --force
    else
        "${SCRIPT_DIR}/restore-baseline.sh"
    fi
else
    echo "==> [1/5] Skipping baseline restore (--skip-baseline)"
fi

echo
if [[ "${FIXTURES_ONLY}" -eq 1 ]]; then
    echo "==> [2/5] Seeding fixture patients only (--fixtures-only)"
else
    echo "==> [2/5] Seeding ${COUNT} patient(s)"
fi
php "${CONSOLE}" seed:patients --count="${COUNT}" ${SEED_ARG} ${FIXTURES_ARG}

echo
echo "==> [3/5] Seeding provider availability (${WEEKS} weeks forward)"
php "${CONSOLE}" seed:availability --weeks="${WEEKS}"

echo
if [[ "${FIXTURES_ONLY}" -eq 1 ]]; then
    echo "==> [4/5] Seeding fixture-patient weekly appointments only (--fixtures-only)"
else
    echo "==> [4/5] Seeding ${DAYS} business days of appointments"
fi
php "${CONSOLE}" seed:schedule --days="${DAYS}" ${SEED_ARG} ${FIXTURES_ARG}

echo
echo "==> [5/5] Final state"
php "${CONSOLE}" seed:status
