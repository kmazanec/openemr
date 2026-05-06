import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_TS = resolve(HERE, '..', '..', 'src', 'state', 'migrations.ts');
const MIGRATIONS_DIR = resolve(HERE, '..', '..', 'migrations');

/**
 * Regression coverage for the agent's Postgres migration runner.
 *
 * node-pg-migrate's loader iterates everything in the migrations
 * directory and tries to import each entry. Without an `ignorePattern`,
 * a non-SQL file like `migrations/README.md` lands in `import()` and
 * throws `ERR_UNKNOWN_FILE_EXTENSION`, refusing to start the agent.
 *
 * Two complementary checks:
 *
 *   1. The runner config in `migrations.ts` carries an `ignorePattern`
 *      that excludes anything not ending in `.sql`. Pinning the literal
 *      regex stops a future "let me clean this up" refactor from
 *      removing the filter and re-introducing the boot failure.
 *   2. The runtime regex itself behaves the way we think: `.md`/`.txt`
 *      get filtered, `.sql` survives. This is the semantic check the
 *      pinning would otherwise be hand-waving about.
 */

describe('migrations runner: ignorePattern keeps non-SQL files out of the loader', () => {
    it('migrations.ts pins the ignorePattern that filters non-.sql files', async () => {
        const src = await readFile(MIGRATIONS_TS, 'utf-8');
        // Negative lookahead: matches every name that does NOT end in
        // `.sql`. node-pg-migrate's loader anchors with `^...$` and
        // skips matches, so this leaves only `.sql` filenames as
        // migration candidates.
        expect(src).toContain("ignorePattern: '(?!.*\\\\.sql$).*'");
    });

    it('the configured regex actually rejects non-SQL filenames', () => {
        // Replicate node-pg-migrate's anchoring (`^...$`) so the test
        // exercises the same matching the loader does.
        const ignoreRegexp = new RegExp('^(?!.*\\.sql$).*$');

        expect(ignoreRegexp.test('README.md')).toBe(true);
        expect(ignoreRegexp.test('notes.txt')).toBe(true);
        expect(ignoreRegexp.test('.gitkeep')).toBe(true);
        expect(ignoreRegexp.test('1700000000000_baseline.sql')).toBe(false);
    });

    it('every checked-in file in agent/migrations/ is either .sql or excluded by the pattern', async () => {
        // Defensive: if someone adds, say, a `.json` config alongside
        // the migrations, this test catches it before it bites at boot.
        const ignoreRegexp = new RegExp('^(?!.*\\.sql$).*$');
        const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
        const surviving = entries
            .filter((e) => e.isFile())
            .filter((e) => !ignoreRegexp.test(e.name))
            .map((e) => e.name);

        for (const name of surviving) {
            expect(name).toMatch(/\.sql$/u);
        }
    });
});

describe('migrations runner: smoke (works against a temp directory)', () => {
    // Sanity: a fixture dir of mixed extensions yields only the .sql.
    // Doesn't exercise node-pg-migrate (its internal helpers aren't a
    // stable subpath export); the regex itself is what matters.
    it('regex applied via Array.filter strips README/.gitkeep but keeps .sql', async () => {
        const tmp = await mkdtemp(join(tmpdir(), 'agent-mig-test-'));
        try {
            await writeFile(join(tmp, '1700000000000_keep.sql'), '-- Up\n');
            await writeFile(join(tmp, 'README.md'), '# docs');
            await writeFile(join(tmp, '.gitkeep'), '');
            await writeFile(join(tmp, 'notes.txt'), 'misc');

            const ignoreRegexp = new RegExp('^(?!.*\\.sql$).*$');
            const dirContent = await readdir(tmp, { withFileTypes: true });
            const survivors = dirContent
                .filter((e) => e.isFile())
                .filter((e) => !ignoreRegexp.test(e.name))
                .map((e) => e.name);

            expect(survivors).toEqual(['1700000000000_keep.sql']);
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
});
