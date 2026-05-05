import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { createBriefingGraph } from '../../../src/graph/index.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';
import type { Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildClient, loadFixture } from './_helpers.js';

/**
 * §6.6 malformed model output. The PDF asks what happens "when the
 * model returns something unexpected." Today the production
 * synthesizer goes through `withStructuredOutput(zodSchema)` in
 * `agent/src/graph/nodes/synthesize.ts` — Zod parses the JSON and
 * coerces it into the strict ledger shape. A real model emitting
 * malformed JSON or a schema-violating ledger surfaces as a thrown
 * `ZodError` (or LangChain `OutputParserException`) at the
 * synthesizer layer, before the verifier sees anything.
 *
 * The `Synthesizer` injection point sits *after* parsing — it's a TS
 * function, so it cannot literally "return malformed JSON". We
 * exercise the equivalent failure modes by stubbing the synthesizer
 * to throw the kind of error a real Zod-backed synthesizer would
 * throw, and asserting the graph surfaces a structured error rather
 * than crashing or producing a malformed `BriefingState`. The
 * empty-`sourceReferences` case is the one shape Zod would catch
 * today (`.min(1)` at synthesize.ts:64) but the verifier *also*
 * gates against (`REJECT_NO_SOURCE` at verifier.ts:38) — so this
 * pin holds even if Zod is loosened.
 */

describe('UC1 malformed model output — graph surfaces structured errors', () => {
    it('synthesizer throws a malformed-JSON-shaped error: rejection propagates, verify never runs', async () => {
        const snapshot = loadFixture('diabetic');
        const client = buildClient(snapshot);
        const counters = createInMemoryCounters();

        const malformedJsonError = new Error('Invalid JSON output: unexpected token } at position 42');
        const synth: Synthesizer = vi.fn(() => Promise.reject(malformedJsonError));

        const graph = createBriefingGraph({
            retrieveChart: { client, token: 'eval-token', siteId: 'default', counters },
            synthesize: { synthesizer: synth, counters },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog(), counters },
        });

        await expect(graph.invoke({ envelope: baseEnvelope(snapshot) })).rejects.toBe(
            malformedJsonError,
        );

        const tally = counters.snapshot();
        expect(tally.verification.passed).toBe(0);
        expect(tally.verification.failed).toBe(0);
    });

    it('synthesizer throws a ZodError (schema-violating ledger): graph surfaces the typed error', async () => {
        const snapshot = loadFixture('diabetic');
        const client = buildClient(snapshot);
        const counters = createInMemoryCounters();

        const zodError = new ZodError([
            {
                code: 'invalid_type',
                expected: 'string',
                input: undefined,
                path: ['claims', 0, 'id'],
                message: 'Required',
            },
        ]);
        const synth: Synthesizer = vi.fn(() => Promise.reject(zodError));

        const graph = createBriefingGraph({
            retrieveChart: { client, token: 'eval-token', siteId: 'default', counters },
            synthesize: { synthesizer: synth, counters },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog(), counters },
        });

        await expect(graph.invoke({ envelope: baseEnvelope(snapshot) })).rejects.toBe(zodError);
        await expect(graph.invoke({ envelope: baseEnvelope(snapshot) })).rejects.toBeInstanceOf(
            ZodError,
        );

        // Zod-rejection happens before verify runs.
        const tally = counters.snapshot();
        expect(tally.verification.passed).toBe(0);
        expect(tally.verification.failed).toBe(0);
    });

    it('claim with empty sourceReferences[]: verifier rejects with missing-source-references', async () => {
        const snapshot = loadFixture('diabetic');
        const client = buildClient(snapshot);

        // Production Zod enforces `.min(1)` on sourceReferences
        // (synthesize.ts:64), so a real model couldn't reach the
        // verifier with this shape today. The Synthesizer *type*
        // permits it, though, and this case pins that the verifier
        // remains the second gate even if Zod is ever loosened.
        const sourcelessSynth: Synthesizer = vi.fn(() => Promise.resolve({
            draft: {
                segments: [
                    { text: 'Patient is on a mystery medication', claimIds: ['c-empty'] },
                ],
            },
            ledger: {
                claims: [
                    {
                        id: 'c-empty',
                        text: 'Patient is on a mystery medication',
                        category: 'prescription' as const,
                        sourceReferences: [],
                        safetyCritical: true,
                    },
                ],
            },
        }));

        const graph = createBriefingGraph({
            retrieveChart: { client, token: 'eval-token', siteId: 'default' },
            synthesize: { synthesizer: sourcelessSynth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });

        expect(out.verified).toBeDefined();
        expect(out.verified?.passed).toBe(false);

        const rejected = out.verified?.rejected ?? [];
        const drop = rejected.find((r) => r.claim.id === 'c-empty');
        expect(drop).toBeDefined();
        expect(drop?.reason).toBe('missing-source-references');

        // The unbacked segment is redacted, not rendered as fact.
        const leakSegment = out.formatted?.segments.find((s) =>
            s.claims.some((c) => c.id === 'c-empty'),
        );
        expect(leakSegment).toBeUndefined();
    });
});
