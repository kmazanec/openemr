# Baseline seed dump

`baseline.sql.gz` is a gzipped `mariadb-dump` of the OpenEMR database
immediately after `openemr-cmd dev-reset-install-demodata` runs. It contains:

- The full OpenEMR schema (every table, including ones with no rows)
- The standard upstream demo content: 3 demo patients, 9 users with assorted
  roles for ACL testing, the patient-portal logins listed at
  https://www.open-emr.org/wiki/index.php/Development_Demo#Demo_Credentials
- ~5,500 `list_options` rows (race/ethnicity/language codes, encounter types,
  ICD-10 references, etc. — all the lookup data OpenEMR ships with)

It does *not* contain Synthea-generated random patients. The seed CLI
(`bin/seed/seed.php patients`) layers those on top of the baseline using
PHP Faker.

## When to regenerate

Run `db/seeds/regenerate-baseline.sh` after any of the following:

- An OpenEMR upgrade that adds or modifies tables (the dump's CREATE TABLE
  statements would otherwise drift from the live schema)
- A change to the upstream demo dataset that you want reflected in deploys
- A site-wide change to baseline `globals` / `list_options` you want
  pre-loaded in every environment

The regeneration script wipes the local dev DB, reinstalls demo data, dumps
the result, and round-trips the dump through a scratch database to confirm
it's restorable.

## When *not* to regenerate

Do not regenerate the dump just because you have local test data you'd like
to share. The baseline is meant to be a clean upstream-demo snapshot — any
project-specific test data belongs in a seed scenario under `bin/seed/`,
not in this dump.

## How it's restored

`db/seeds/restore-baseline.sh` (run inside the OpenEMR container — locally
via `docker compose exec openemr ...`, in Railway via `railway ssh`)
reads DB credentials from `sites/<site>/sqlconf.php`, gunzips this file,
and pipes it into `mariadb`. It refuses to run if `patient_data` is
non-empty, so the baseline can only be applied to a freshly-installed
environment.

Restore is intentionally a plain shell script rather than a Symfony
Console command. OpenEMR's `bin/console` bootstrap reads from tables that
don't exist on a virgin database, which would make a console-based restore
fail noisily before it could even start. The shell script side-steps that
by talking to MariaDB directly.
