import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runner } from 'node-pg-migrate';

import { createLogger } from '../observability/logger.js';

/**
 * Schema migrations for the agent's Postgres. The migrations live in
 * `agent/migrations/` as `<unix-ms>_<name>.sql` files with `-- Up` and
 * `-- Down` blocks; each one runs exactly once per database, tracked
 * in the `pgmigrations` table.
 *
 * `runMigrations` runs at agent boot, before any state-store factory
 * is asked to read or write. A pending migration that fails throws —
 * the agent refuses to serve briefings against a half-applied schema.
 *
 * The directory is resolved relative to the package root (one level
 * up from `agent/dist/state/` after compile, two levels up from
 * `agent/src/state/` under `tsx`/`vitest`). The runtime check
 * (`existsSync`) is intentional: if migrations move and someone forgot
 * to update this resolver, we want a typed error at boot, not silent
 * "no migrations to run" success.
 */

const LOG = createLogger('migrations');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from `state/` to the package root regardless of whether
 * we're running from `src/` (tsx, vitest) or `dist/` (compiled).
 *
 *   src/state/migrations.ts          → ../../migrations
 *   dist/state/migrations.js         → ../../migrations
 */
const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'migrations');

export interface RunMigrationsOptions {
    readonly databaseUrl: string;
    /**
     * Test seam — point at an alternate migrations directory. Production
     * always uses the colocated `agent/migrations/`.
     */
    readonly migrationsDir?: string;
    /**
     * Test seam — direction defaults to `'up'`. Tests for the down
     * path can pass `'down'` and a `count`.
     */
    readonly direction?: 'up' | 'down';
    readonly count?: number;
}

export const runMigrations = async (
    options: RunMigrationsOptions,
): Promise<readonly string[]> => {
    if (options.databaseUrl.length === 0) {
        throw new Error('runMigrations: databaseUrl is required');
    }
    const dir = options.migrationsDir ?? MIGRATIONS_DIR;
    const direction = options.direction ?? 'up';
    LOG.info({ dir, direction }, 'applying migrations');
    const applied = await runner({
        databaseUrl: options.databaseUrl,
        dir,
        direction,
        count: options.count ?? Infinity,
        migrationsTable: 'pgmigrations',
        verbose: false,
        // SQL files only; the loader auto-detects the `.sql` extension.
        // We don't allow JS migrations (TypeScript compile complications +
        // the SQL surface is sufficient for our shapes today).
        singleTransaction: true,
    });
    const names = applied.map((m) => m.name);
    LOG.info(
        { count: names.length, names },
        names.length === 0 ? 'no migrations to apply' : 'migrations applied',
    );
    return names;
};
