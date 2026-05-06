import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanForPhi, type PhiFinding } from '../../src/observability/phiTraceScanner.js';

/**
 * §6.1: "No PHI in prompt/completion bodies stored to LangSmith —
 * confirmed by a test that scans recent traces."
 *
 * Two-mode test:
 *
 *   - **Always-on fixture mode** asserts the scanner catches PHI in a
 *     leaky trace shape and reports zero findings on a clean trace
 *     shape. This is what runs in CI on every PR.
 *
 *   - **Live mode** runs only when `LANGSMITH_API_KEY` is set. It pulls
 *     recent runs from the configured project via `langsmith.Client`
 *     and asserts none contain PHI in their `inputs`/`outputs`. This
 *     is the post-deploy gate — Phase 6.1's intent is that a real
 *     production trace stream stays PHI-free even if a code change
 *     forgets to set `LANGSMITH_HIDE_INPUTS`.
 *
 * Canary tokens cover the seed-pipeline fixture identifiers from
 * `db/seeds/`. Add new fixture names here when seed personas change.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures');

const SEED_CANARIES: readonly string[] = [
    // First names from the USERS.md / seed archetypes
    'Maya',
    'Patel',
    // Defensive set; expand as seed personas grow
    'Garcia',
    'Johnson',
];

const readFixture = async (name: string): Promise<unknown> => {
    const raw = await readFile(resolve(FIXTURES, name), 'utf-8');
    return JSON.parse(raw) as unknown;
};

describe('PHI trace scanner — fixture mode', () => {
    it('reports zero findings on a redacted trace where LANGSMITH_HIDE_* did its job', async () => {
        const trace = await readFixture('clean-trace.json');
        const findings = scanForPhi(trace, { canaries: SEED_CANARIES });
        expect(findings).toEqual([]);
    });

    it('catches a leaky trace that uploaded a real prompt body', async () => {
        const trace = await readFixture('leaky-trace.json');
        const findings = scanForPhi(trace, { canaries: SEED_CANARIES });

        const kinds = new Set(findings.map((f) => f.kind));
        // The leaky fixture leaks via all three signal types — every one
        // must fire, otherwise the scanner has a blind spot.
        expect(kinds.has('phi-key')).toBe(true);
        expect(kinds.has('phi-pattern')).toBe(true);
        expect(kinds.has('phi-canary')).toBe(true);
    });
});

interface RunSummary {
    readonly id: string;
    readonly name?: string;
    readonly inputs?: unknown;
    readonly outputs?: unknown;
}

const collectRuns = async (limit: number): Promise<RunSummary[]> => {
    // Imported lazily so the always-on suite never pays the cost of the
    // langsmith client when the test won't run in this environment.
    const mod = await import('langsmith');
    const project = process.env['LANGSMITH_PROJECT'] ?? 'default';
    const sinceMs = 24 * 60 * 60 * 1000;
    const client = new mod.Client();
    const runs: RunSummary[] = [];
    const iter = client.listRuns({
        projectName: project,
        startTime: new Date(Date.now() - sinceMs),
        limit,
    });
    for await (const run of iter) {
        runs.push({
            id: run.id,
            name: run.name,
            inputs: run.inputs,
            outputs: run.outputs,
        });
        if (runs.length >= limit) {
            break;
        }
    }
    return runs;
};

// Live mode requires BOTH credentials and a project name. With only an API
// key set, `listRuns` falls back to LangSmith's `'default'` project — which
// most accounts do not have, causing a noisy `Project not found` error
// that masquerades as a real test failure. Gate on both so the live suite
// either runs against a real project or skips cleanly.
const liveModeEnabled =
    (process.env['LANGSMITH_API_KEY'] ?? '').length > 0
    && (process.env['LANGSMITH_PROJECT'] ?? '').length > 0;
const live = liveModeEnabled ? describe : describe.skip;

live('PHI trace scanner — live mode against LangSmith', () => {
    it('reports zero PHI findings across recent runs in the configured project', async () => {
        const runs = await collectRuns(50);
        const offending: { run: RunSummary; findings: readonly PhiFinding[] }[] = [];
        for (const run of runs) {
            const findings = scanForPhi(
                { inputs: run.inputs, outputs: run.outputs },
                { canaries: SEED_CANARIES },
            );
            if (findings.length > 0) {
                offending.push({ run, findings });
            }
        }
        if (offending.length > 0) {
            const summary = offending
                .map(
                    (o) =>
                        `run ${o.run.id} (${o.run.name ?? '?'}): ${o.findings
                            .map((f) => `${f.kind}@${f.path}:${f.match}`)
                            .join(', ')}`,
                )
                .join('\n');
            throw new Error(`PHI found in recent traces:\n${summary}`);
        }
        expect(offending).toEqual([]);
    }, 30_000);
});
