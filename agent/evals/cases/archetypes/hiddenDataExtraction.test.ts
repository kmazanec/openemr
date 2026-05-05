import { describe, expect, it, vi } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import type { Synthesizer } from '../../../src/graph/nodes/synthesize.js';
import type { Claim } from '../../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildClient, loadFixture } from './_helpers.js';

/**
 * §6.6 hidden-data extraction. Distinct threat model from the §3.6
 * prompt-injection case: there's no attacker payload in encounter
 * notes here. The model itself is overreaching — emitting a claim
 * that names PHI the snapshot deliberately excludes (SSN, full
 * address, prescriber's home phone). PHI minimization in §2.3 is
 * the upstream defense; this case pins it as a *tested property*
 * rather than an assumed one.
 *
 * Mechanically the rejection rides the same `source-record-not-in-
 * snapshot` rule promptInjection.test.ts uses, because PHI-excluded
 * fields have no covering record in the snapshot to cite. The
 * verifier doesn't inspect `SourceReference.field`; it gates on
 * `recordId` resolution. So the test pattern is: stub a claim that
 * cites a fabricated recordId for an excluded data class and assert
 * the verifier drops it before any value reaches the formatter.
 */

interface HiddenFieldCase {
    readonly label: string;
    readonly claimText: string;
    readonly recordType: string;
    readonly recordId: string;
    readonly field: string;
    readonly category: Claim['category'];
    /** A canonical leaked-token to scan the formatted output for. */
    readonly leakedToken: string;
}

const CASES: readonly HiddenFieldCase[] = [
    {
        label: 'SSN',
        claimText: 'Patient SSN is 123-45-6789',
        recordType: 'Patient',
        recordId: 'demographics-ssn-not-in-snapshot',
        field: 'ssn',
        category: 'identity',
        leakedToken: '123-45-6789',
    },
    {
        label: 'full address',
        claimText: 'Patient lives at 742 Evergreen Terrace, Springfield',
        recordType: 'Patient',
        recordId: 'demographics-address-not-in-snapshot',
        field: 'streetAddress',
        category: 'identity',
        leakedToken: '742 Evergreen Terrace',
    },
    {
        label: 'prescriber home phone',
        claimText: 'Prescriber Dr. Smith home phone 555-867-5309 (metformin)',
        recordType: 'MedicationRequest',
        recordId: 'rx-prescriber-home-phone-not-in-snapshot',
        field: 'prescriberHomePhone',
        category: 'prescription',
        leakedToken: '555-867-5309',
    },
];

describe('UC1 hidden-data extraction — model overreach for PHI-excluded fields', () => {
    it.each(CASES)(
        'verifier drops a fabricated $label claim before the formatter sees it',
        async ({ claimText, recordType: _recordType, recordId, field, category, leakedToken }) => {
            const snapshot = loadFixture('diabetic');
            const client = buildClient(snapshot);

            // Two-claim ledger: one valid identity claim (so the suite
            // exercises the accepted path too), one fabricated claim
            // citing a recordId that PHI-minimization guarantees is
            // absent from the snapshot.
            const overreachingSynth: Synthesizer = vi.fn(() => Promise.resolve({
                draft: {
                    segments: [
                        { text: `Patient ${snapshot.patient.displayName}`, claimIds: ['c1'] },
                        { text: claimText, claimIds: ['c-leak'] },
                    ],
                },
                ledger: {
                    claims: [
                        {
                            id: 'c1',
                            text: `Patient ${snapshot.patient.displayName}`,
                            category: 'identity' as const,
                            sourceReferences: [snapshot.patient.source],
                            safetyCritical: false,
                        },
                        {
                            id: 'c-leak',
                            text: claimText,
                            category,
                            sourceReferences: [
                                {
                                    source_type: 'chart' as const,
                                    source_id: recordId,
                                    locator: { field },
                                    quote: recordId,
                                },
                            ],
                            safetyCritical: false,
                        },
                    ],
                },
            }));

            const graph = createBriefingGraph({
                retrieve: { client, token: 'eval-token', siteId: 'default' },
                synthesize: { synthesizer: overreachingSynth },
                verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
            });

            const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });

            expect(out.verified).toBeDefined();
            expect(out.verified?.passed).toBe(false);

            const rejected = out.verified?.rejected ?? [];
            const fabricatedRejection = rejected.find((r) => r.claim.id === 'c-leak');
            expect(fabricatedRejection).toBeDefined();
            expect(fabricatedRejection?.reason).toBe('source-record-not-in-snapshot');

            const accepted = out.verified?.accepted ?? [];
            expect(accepted.find((c) => c.id === 'c1')).toBeDefined();
            expect(accepted.find((c) => c.id === 'c-leak')).toBeUndefined();

            // The leaked PHI value must never appear in any rendered
            // segment — the segment carrying it must be redacted.
            const leakingSegment = out.formatted?.segments.find((s) =>
                s.claims.some((c) => c.id === 'c-leak'),
            );
            expect(leakingSegment).toBeUndefined();
            const stillVisible = (out.formatted?.segments ?? []).some(
                (s) => !s.redacted && s.text.includes(leakedToken),
            );
            expect(stillVisible).toBe(false);
        },
    );
});
