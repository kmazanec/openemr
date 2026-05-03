# Hand-rolled backup sidecar for agent-postgres.
#
# Why hand-rolled instead of an off-the-shelf image (§6.3): we need
# pg_dump for Postgres 16 + an S3-compatible upload (DigitalOcean
# Spaces) + 7-daily/4-weekly retention. The popular
# prodrigestivill/postgres-backup-local image doesn't speak S3;
# tiredofit/docker-db-backup uses minute-based retention which is awkward
# to map to "7 daily + 4 weekly"; eeshugerman/postgres-backup-s3 is
# archived. A 40-line shell script is easier to audit than any of those.
#
# Pin the Postgres major version to match `agent-postgres` (postgres:16
# in docker-compose.yml). pg_dump from a newer minor is fine; from an
# older or different major is not — bump in lockstep when the agent's
# Postgres image is bumped.
FROM postgres:16-alpine

# awscli for S3 uploads to DigitalOcean Spaces (S3-compatible).
# tini gives us correct signal handling so `docker stop` interrupts the
# `sleep` loop in entrypoint.sh promptly instead of waiting out the
# kernel's 10s grace period.
RUN apk add --no-cache aws-cli tini bash

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Local cache so a failed S3 upload still leaves a recoverable file
# behind. Survives container recreate via the named volume in compose.
VOLUME ["/backups"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
