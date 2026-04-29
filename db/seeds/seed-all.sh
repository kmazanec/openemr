#!/usr/bin/env bash
#
# Run the full seed pipeline end-to-end. Designed to run *inside* the OpenEMR
# container (locally via `docker compose exec openemr db/seeds/seed-all.sh`
# or in Railway via `railway ssh`).
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
# Usage:
#   db/seeds/seed-all.sh                       # 100 patients, 10 schedule days
#   db/seeds/seed-all.sh --count=50 --days=14  # custom counts
#   db/seeds/seed-all.sh --skip-baseline       # additive run on existing data
#   db/seeds/seed-all.sh --seed=42             # deterministic Faker output
#
# Exit codes:
#   0 = success
#   non-zero = whichever step failed (set -e propagates)

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

for arg in "$@"; do
    case "$arg" in
        --count=*)         COUNT="${arg#--count=}" ;;
        --days=*)          DAYS="${arg#--days=}" ;;
        --weeks=*)         WEEKS="${arg#--weeks=}" ;;
        --seed=*)          SEED="${arg#--seed=}" ;;
        --skip-baseline)   SKIP_BASELINE=1 ;;
        --force-baseline)  FORCE_BASELINE=1 ;;
        -h|--help)
            sed -n '2,30p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

SEED_ARG=""
if [[ -n "${SEED}" ]]; then
    SEED_ARG="--seed=${SEED}"
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
echo "==> [2/5] Seeding ${COUNT} patient(s)"
php "${CONSOLE}" seed:patients --count="${COUNT}" ${SEED_ARG}

echo
echo "==> [3/5] Seeding provider availability (${WEEKS} weeks forward)"
php "${CONSOLE}" seed:availability --weeks="${WEEKS}"

echo
echo "==> [4/5] Seeding ${DAYS} business days of appointments"
php "${CONSOLE}" seed:schedule --days="${DAYS}" ${SEED_ARG}

echo
echo "==> [5/5] Final state"
php "${CONSOLE}" seed:status
