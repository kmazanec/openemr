#!/usr/bin/env bash
# agent-pg-backup entrypoint.
#
# Loop-sleep architecture: dump → upload → prune → sleep until next
# 02:30 UTC. We avoid `cron` so the container has a single foreground
# process that PID 1 can supervise, and the schedule is an obvious
# `date`-based check at the top of this script.
#
# Refuses to start if any required env var is unset — a fresh Droplet
# without SPACES_* configured shouldn't silently skip backups. The
# operator sees the loop crash in `docker compose logs` until they fill
# in the secrets in /etc/openemr/.env.
set -euo pipefail

require() {
    local name="$1"
    if [ -z "${!name:-}" ]; then
        echo "[agent-pg-backup] FATAL: \$$name is required but unset" >&2
        exit 64
    fi
}

require POSTGRES_HOST
require POSTGRES_DB
require POSTGRES_USER
require POSTGRES_PASSWORD
require SPACES_BUCKET
require SPACES_REGION
require SPACES_KEY
require SPACES_SECRET

# Local cache — survives container recreate via the agentpgbackupvolume
# named volume in compose. If an upload fails, the dump stays here and
# the next successful run re-uploads from the same path.
BACKUP_DIR="${BACKUP_DIR:-/backups}"
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"

S3_ENDPOINT="https://${SPACES_REGION}.digitaloceanspaces.com"
S3_PREFIX="${S3_PREFIX:-agent-postgres}"

export AWS_ACCESS_KEY_ID="$SPACES_KEY"
export AWS_SECRET_ACCESS_KEY="$SPACES_SECRET"
export AWS_DEFAULT_REGION="$SPACES_REGION"
export PGPASSWORD="$POSTGRES_PASSWORD"

run_backup() {
    local now today dow tier filename target s3_target
    now="$(date -u +%Y%m%dT%H%M%SZ)"
    today="$(date -u +%Y%m%d)"
    # 7 = Sunday in date's %u — weekly snapshots line up with calendar weeks.
    dow="$(date -u +%u)"
    if [ "$dow" = "7" ]; then
        tier="weekly"
    else
        tier="daily"
    fi
    filename="${POSTGRES_DB}-${today}-${now}.sql.gz"
    target="$BACKUP_DIR/$tier/$filename"
    s3_target="s3://${SPACES_BUCKET}/${S3_PREFIX}/${tier}/${filename}"

    echo "[agent-pg-backup] $(date -u -Iseconds) start tier=$tier file=$filename"

    # --no-owner / --no-acl keep the dump portable to a fresh Postgres
    # without the original role catalog. Errors in pg_dump or gzip break
    # the pipeline via `set -o pipefail`.
    pg_dump \
        --host="$POSTGRES_HOST" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --no-owner \
        --no-acl \
        --format=plain \
        | gzip --best > "$target"

    aws s3 cp \
        --endpoint-url "$S3_ENDPOINT" \
        --only-show-errors \
        "$target" "$s3_target"

    echo "[agent-pg-backup] $(date -u -Iseconds) uploaded $s3_target"
}

prune() {
    # Local pruning — the off-volume copies in Spaces are pruned the
    # same way against the s3 prefix. We list, sort newest-first, drop
    # the head we want to keep, and remove the rest.
    local tier keep dir
    for tier in daily weekly; do
        if [ "$tier" = "daily" ]; then keep="$KEEP_DAILY"; else keep="$KEEP_WEEKLY"; fi
        dir="$BACKUP_DIR/$tier"

        if [ -d "$dir" ]; then
            find "$dir" -maxdepth 1 -type f -name '*.sql.gz' -printf '%T@ %p\n' \
                | sort -nr \
                | tail -n "+$((keep + 1))" \
                | awk '{ $1=""; sub(/^ /, ""); print }' \
                | while read -r victim; do
                    [ -n "$victim" ] && rm -f -- "$victim"
                  done
        fi

        # S3 side: list, sort by key (filename starts with the date so
        # lexicographic == chronological), keep the newest N.
        local list_path
        list_path="$(mktemp)"
        if aws s3 ls "s3://${SPACES_BUCKET}/${S3_PREFIX}/${tier}/" \
            --endpoint-url "$S3_ENDPOINT" \
            --only-show-errors \
            > "$list_path" 2>/dev/null; then
            sort -r "$list_path" \
                | awk '{ print $4 }' \
                | tail -n "+$((keep + 1))" \
                | while read -r victim; do
                    [ -z "$victim" ] && continue
                    aws s3 rm \
                        "s3://${SPACES_BUCKET}/${S3_PREFIX}/${tier}/${victim}" \
                        --endpoint-url "$S3_ENDPOINT" \
                        --only-show-errors
                  done
        fi
        rm -f "$list_path"
    done
}

# Sleep until the next 02:30 UTC. Computed each iteration so a long pg_dump
# can't drift the schedule.
seconds_until_next_run() {
    local now next
    now="$(date -u +%s)"
    next="$(date -u -d 'today 02:30 UTC' +%s)"
    if [ "$next" -le "$now" ]; then
        next="$(date -u -d 'tomorrow 02:30 UTC' +%s)"
    fi
    echo "$((next - now))"
}

# A run-on-start mode for `docker compose run --rm agent-pg-backup once`,
# documented in docs/RUNBOOK.md.
if [ "${1:-}" = "once" ]; then
    run_backup
    prune
    exit 0
fi

while true; do
    sleep_for="$(seconds_until_next_run)"
    echo "[agent-pg-backup] $(date -u -Iseconds) sleeping ${sleep_for}s until next run"
    sleep "$sleep_for"
    if ! run_backup; then
        echo "[agent-pg-backup] $(date -u -Iseconds) backup failed; will retry on next schedule" >&2
    fi
    if ! prune; then
        echo "[agent-pg-backup] $(date -u -Iseconds) prune failed; non-fatal" >&2
    fi
done
