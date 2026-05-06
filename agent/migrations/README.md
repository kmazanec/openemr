# Agent Postgres migrations

Forward-only schema migrations for the agent service's Postgres database, run by [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate).

## Format

Each migration is a `<unix-ms>_<name>.sql` file with `-- Up Migration` and `-- Down Migration` blocks. The Unix-ms prefix orders them chronologically; node-pg-migrate refuses to run a migration whose prefix doesn't parse as a valid Unix timestamp.

```
1700000001000_baseline_unverified_claims.sql
1700000002000_baseline_conversations.sql
...
```

The `1700…` prefixes on the baseline migrations are placeholder timestamps in November 2023 — they predate the introduction of node-pg-migrate to this codebase. New migrations should use the current Unix-ms timestamp (`Date.now()`) so they sort after the baselines.

## Running migrations

From `agent/`:

```sh
DATABASE_URL=postgresql://agent:agent@127.0.0.1:8330/agent npm run migrate:up
DATABASE_URL=... npm run migrate:down                  # roll back the most recent
DATABASE_URL=... npm run migrate -- redo               # down + up the most recent
DATABASE_URL=... npm run migrate:create my_migration   # scaffold a new file
```

In production / CI / dev-easy boot, `runMigrations()` is called from `agent/src/server/index.ts` before any state-store factory is wired. A pending migration that fails throws — the agent refuses to serve requests against a half-applied schema.

## Tracking table

Applied migrations are recorded in the `pgmigrations` table (created automatically). Don't edit it by hand except for the rare rename-an-applied-migration case: rename the file, then `UPDATE pgmigrations SET name = '<new>' WHERE name = '<old>'`.

## What goes here vs. what doesn't

- **Goes here:** every DDL change to a table or index the agent owns.
- **Doesn't go here:** LangGraph's `checkpoint*` tables — `PostgresSaver` owns its own schema and runs its own `setup()`.

## When you write a new migration

1. `npm run migrate:create my_migration` to scaffold a `<ts>_my_migration.sql`.
2. Fill in the `-- Up Migration` block with the forward DDL.
3. Fill in the `-- Down Migration` block with the rollback DDL — it must be safe to apply against a database where the up-migration has been applied.
4. Apply locally: `DATABASE_URL=... npm run migrate:up`.
5. Verify by inspecting the schema: `psql ... -c "\d <table>"`.
6. Apply down to verify the rollback: `DATABASE_URL=... npm run migrate:down`.
7. Re-apply up before committing.
8. Open the MR; CI applies migrations on its agent-postgres test container before running tests.
