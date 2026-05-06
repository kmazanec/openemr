/**
 * `no_phi_in_logs` rubric — vision-call traces.
 *
 * Vision payloads are PHI by construction: the model receives the raw
 * page bytes (lab PDFs, intake forms) along with a system prompt that
 * names the patient. `LANGSMITH_HIDE_INPUTS` / `LANGSMITH_HIDE_OUTPUTS`
 * defaults must suppress those payloads from the LangSmith trace body,
 * and the trace scanner must catch any regression that lets one
 * through. This file scopes the scanner to the
 * `pipeline.vision.invoke` traceable specifically, where the leak risk
 * is highest.
 *
 * Two-mode test mirroring `tests/observability/scanRecentTraces.test.ts`:
 *
 *  - **Always-on fixture mode** asserts the scanner reports zero
 *    findings on a redacted vision trace and catches every signal
 *    type on a leaky one. CI-resident; deterministic; fast.
 *  - **Live mode** runs only when `LANGSMITH_API_KEY` AND
 *    `LANGSMITH_PROJECT` are both set. It pulls the last 50 runs
 *    matching the vision-name pattern and scans them. This is the
 *    post-deploy gate against a code change that forgets to redact
 *    vision payloads.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    scanForPhi,
    type PhiFinding,
} from '../../../src/observability/phiTraceScanner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures');

/**
 * Seed-pipeline canary tokens. The seed pipeline writes patient names
 * into the chart; the vision payload then renders the same patient's
 * intake/lab paperwork. If a name appears in either trace body, that's
 * a leak. Add new seed personas here as the fixture set grows; mirror
 * `tests/observability/scanRecentTraces.test.ts` SEED_CANARIES list.
 */
const SEED_CANARIES: readonly string[] = [
    'Maya',
    'Patel',
    'Garcia',
    'Johnson',
    'Whitaker',
    'Reyes',
    'Kowalski',
];

const readFixture = async (name: string): Promise<unknown> => {
    const raw = await readFile(resolve(FIXTURES, name), 'utf-8');
    return JSON.parse(raw) as unknown;
};

describe('no_phi_in_logs vision-trace extension — fixture mode', () => {
    it('reports zero findings on a redacted vision trace where LANGSMITH_HIDE_* did its job', async () => {
        const trace = await readFixture('clean-vision-trace.json');
        const findings = scanForPhi(trace, { canaries: SEED_CANARIES });
        expect(findings).toEqual([]);
    });

    it('catches a leaky vision trace via every signal type', async () => {
        const trace = await readFixture('leaky-vision-trace.json');
        const findings = scanForPhi(trace, { canaries: SEED_CANARIES });

        const kinds = new Set(findings.map((f) => f.kind));
        // The leaky vision fixture leaks via all three signal classes:
        //   - phi-key (firstName, lastName, dob, ssn, mrn, phone)
        //   - phi-pattern (SSN regex on '123-45-6789'; phone regex on
        //     '415-555-0142')
        //   - phi-canary ('Maya' / 'Patel' tokens)
        // A blind spot in any class would let a regression slip through.
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

const VISION_RUN_PATTERN = /vision/i;

const collectVisionRuns = async (limit: number): Promise<RunSummary[]> => {
    // Imported lazily so the always-on suite never pays the cost of
    // the langsmith client when the live-mode test won't run in this
    // environment.
    const mod = await import('langsmith');
    const project = process.env['LANGSMITH_PROJECT'] ?? 'default';
    const sinceMs = 24 * 60 * 60 * 1000;
    const client = new mod.Client();
    const runs: RunSummary[] = [];
    const iter = client.listRuns({
        projectName: project,
        startTime: new Date(Date.now() - sinceMs),
        // Pull a wider candidate set so the post-filter still leaves
        // enough vision runs to scan; the actual filter is in JS.
        limit: limit * 5,
    });
    for await (const run of iter) {
        if (run.name !== undefined && VISION_RUN_PATTERN.test(run.name)) {
            runs.push({
                id: run.id,
                name: run.name,
                inputs: run.inputs,
                outputs: run.outputs,
            });
        }
        if (runs.length >= limit) {
            break;
        }
    }
    return runs;
};

const liveModeEnabled =
    (process.env['LANGSMITH_API_KEY'] ?? '').length > 0
    && (process.env['LANGSMITH_PROJECT'] ?? '').length > 0;
const live = liveModeEnabled ? describe : describe.skip;

live('no_phi_in_logs vision-trace extension — live mode against LangSmith', () => {
    it('reports zero PHI findings across recent vision-call runs in the configured project', async () => {
        const runs = await collectVisionRuns(50);
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
            throw new Error(`PHI found in recent vision traces:\n${summary}`);
        }
        expect(offending).toEqual([]);
    }, 30_000);
});
