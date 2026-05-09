import { describe, expect, it } from 'vitest';

import { decideTrendChart } from '../../src/graph/trendChart.js';
import type {
    BriefingSnapshot,
    Claim,
    RequestEnvelope,
    VerifiedLedger,
} from '../../src/graph/types.js';
import type { LabObservation } from '../../src/snapshot/types.js';

const sourceRef = (id: string) => ({
    source_type: 'chart' as const,
    source_id: id,
    locator: { field: 'observation.value' },
    quote: id,
});

const lab = (
    overrides: Partial<LabObservation> & { source_id: string },
): LabObservation => ({
    analyte: 'Hemoglobin A1c',
    value: '6.8',
    unit: '%',
    referenceRange: '<5.7',
    abnormalFlag: 'H',
    observedAt: '2025-04-01T10:00:00Z',
    source: sourceRef(overrides.source_id),
    ...overrides,
});

const labClaim = (id: string, source_id: string): Claim => ({
    id,
    text: `A1c claim ${id}`,
    category: 'lab',
    sourceReferences: [sourceRef(source_id)],
    safetyCritical: false,
});

const baseSnapshot = (overrides: Partial<BriefingSnapshot> = {}): BriefingSnapshot => ({
    patient: {
        pid: 1,
        uuid: 'p',
        displayName: 'Test',
        sex: null,
        dateOfBirth: null,
        ageYears: null,
        source: sourceRef('p'),
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    labHistory: null,
    ...overrides,
});

const baseEnvelope = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({
    conversationId: 'c',
    requestId: 'r',
    siteId: 'default',
    actor: { userId: 'u', fhirUser: 'https://emr/Practitioner/u' },
    patient: { pid: 1, uuid: 'p' },
    task: 'default_briefing',
    ...overrides,
});

const verifiedWith = (claims: readonly Claim[]): VerifiedLedger => ({
    passed: true,
    accepted: claims,
    rejected: [],
    safetyHardStops: [],
});

describe('decideTrendChart', () => {
    it('returns null when no lab claims are accepted', () => {
        const result = decideTrendChart({
            verified: verifiedWith([]),
            snapshot: baseSnapshot(),
            envelope: baseEnvelope(),
        });
        expect(result).toBeNull();
    });

    it('returns a chart when an accepted lab claim has prior history (default briefing path)', () => {
        const labs = [
            lab({ source_id: 'l1', value: '7.2', observedAt: '2024-09-15T00:00:00Z' }),
            lab({ source_id: 'l2', value: '7.0', observedAt: '2024-12-20T00:00:00Z' }),
            lab({ source_id: 'l3', value: '6.8', observedAt: '2025-04-01T00:00:00Z' }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l3')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope(),
        });
        expect(result).not.toBeNull();
        expect(result?.analyte).toBe('Hemoglobin A1c');
        expect(result?.unit).toBe('%');
        expect(result?.referenceRange).toBe('<5.7');
        expect(result?.reason).toBe('fresh_lab_with_history');
        expect(result?.points).toHaveLength(3);
        // Sorted ascending by observedAt
        expect(result?.points[0]?.value).toBeCloseTo(7.2);
        expect(result?.points[2]?.value).toBeCloseTo(6.8);
        // Single-chart cap: trendChart slot is a single value, not array.
        expect(result?.groundedInClaimIds).toEqual(['c1']);
    });

    it('does not chart when only one numeric data point is on file', () => {
        const labs = [lab({ source_id: 'l1', value: '6.8', observedAt: '2025-04-01T00:00:00Z' })];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l1')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope(),
        });
        expect(result).toBeNull();
    });

    it('does not chart when values are non-numeric (positive/qualitative)', () => {
        const labs = [
            lab({ source_id: 'l1', analyte: 'Strep', value: 'positive', observedAt: '2025-01-01T00:00:00Z' }),
            lab({ source_id: 'l2', analyte: 'Strep', value: 'positive', observedAt: '2025-04-01T00:00:00Z' }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l2')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope(),
        });
        expect(result).toBeNull();
    });

    it('strips a leading qualifier on values like "<0.01" so they still plot', () => {
        const labs = [
            lab({ source_id: 'l1', value: '<0.01', observedAt: '2024-09-01T00:00:00Z' }),
            lab({ source_id: 'l2', value: '0.05', observedAt: '2025-04-01T00:00:00Z' }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l2')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope(),
        });
        expect(result?.points).toHaveLength(2);
        expect(result?.points[0]?.value).toBeCloseTo(0.01);
    });

    it('caps the rendered series to the most-recent 24 points', () => {
        // 30 monthly points; expect the last 24 sorted ascending.
        const labs = Array.from({ length: 30 }, (_, i) => {
            const month = String((i % 12) + 1).padStart(2, '0');
            const year = 2022 + Math.floor(i / 12);
            return lab({
                source_id: `l${i}`,
                value: String(6 + i * 0.05),
                observedAt: `${year}-${month}-01T00:00:00Z`,
            });
        });
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l29')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope(),
        });
        expect(result?.points).toHaveLength(24);
    });

    it('returns at most one chart even when multiple analytes have history', () => {
        const labs = [
            lab({ source_id: 'a1c-1', analyte: 'A1c', value: '7.5', observedAt: '2024-01-01T00:00:00Z' }),
            lab({ source_id: 'a1c-2', analyte: 'A1c', value: '7.0', observedAt: '2025-01-01T00:00:00Z' }),
            lab({ source_id: 'ldl-1', analyte: 'LDL', value: '120', observedAt: '2024-01-01T00:00:00Z' }),
            lab({ source_id: 'ldl-2', analyte: 'LDL', value: '110', observedAt: '2025-04-01T00:00:00Z' }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'a1c-2'), labClaim('c2', 'ldl-2')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope(),
        });
        // Most-recently-observed lab claim wins (LDL on 2025-04-01).
        expect(result).not.toBeNull();
        expect(result?.analyte).toBe('LDL');
        expect(result?.points).toHaveLength(2);
    });

    it('returns a chart on a follow_up trend question; rule 1 wins when both could fire', () => {
        const labs = [
            lab({ source_id: 'l1', value: '7.2', observedAt: '2024-09-15T00:00:00Z' }),
            lab({ source_id: 'l2', value: '7.0', observedAt: '2024-12-20T00:00:00Z' }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l2')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope({ task: 'follow_up', question: 'How is A1c trending?' }),
        });
        // Both rules technically fire for this snapshot; rule 1 wins
        // because it's the more specific match.
        expect(result?.reason).toBe('fresh_lab_with_history');
    });

    it('charts plain-lookup follow-ups too — no trend keyword required', () => {
        // "What's her A1c?" should chart when the snapshot has ≥2
        // numeric A1c points. The verifier-accepted claim provides
        // the analyte; the points threshold + single-chart cap do
        // the gating. The only lab claim cites a row whose date is
        // empty so rule 1's "most-recently-observed" candidate list
        // is empty and rule 2 is the only path that can fire — pins
        // the new branch independently of rule 1.
        const labs = [
            lab({ source_id: 'l-old1', value: '7.5', observedAt: '2024-01-01T00:00:00Z' }),
            lab({ source_id: 'l-old2', value: '7.2', observedAt: '2024-09-15T00:00:00Z' }),
            lab({ source_id: 'l-cited', value: '7.0', observedAt: null }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l-cited')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope({ task: 'follow_up', question: "What's her A1c?" }),
        });
        expect(result).not.toBeNull();
        expect(result?.reason).toBe('follow_up_lab_question');
        expect(result?.points.length).toBeGreaterThanOrEqual(2);
    });

    it('does not chart on default_briefing turns even when a lab claim has history', () => {
        // Routine briefings already render labs in the chart-record
        // panel section; layering a chart on every briefing turn that
        // happens to mention a lab would clutter the bubble. Rule 2
        // is gated on `task === 'follow_up'` — pin it.
        const labs = [
            lab({ source_id: 'l1', value: '7.5', observedAt: '2024-01-01T00:00:00Z' }),
            lab({ source_id: 'l2', value: '7.0', observedAt: null }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l2')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope({ task: 'default_briefing' }),
        });
        // Rule 1 needs a non-null observedAt for the candidate list,
        // so the cited claim drops out; rule 2 is gated on follow_up.
        // Both miss → no chart on the default briefing.
        expect(result).toBeNull();
    });

    it('does not chart a follow-up that has no lab claims at all', () => {
        const labs = [
            lab({ source_id: 'l1', value: '7.5', observedAt: '2024-01-01T00:00:00Z' }),
            lab({ source_id: 'l2', value: '7.0', observedAt: '2024-09-15T00:00:00Z' }),
        ];
        // No accepted lab claims in the ledger — even though the
        // snapshot has chartable history, there's no analyte for the
        // doctor's question to anchor against. (e.g. "Why was
        // metformin prescribed?".)
        const result = decideTrendChart({
            verified: verifiedWith([]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope({
                task: 'follow_up',
                question: 'Why was metformin prescribed?',
            }),
        });
        expect(result).toBeNull();
    });

    it('merges labHistory observations with snapshot.labs', () => {
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l-fresh')]),
            snapshot: baseSnapshot({
                labs: [lab({ source_id: 'l-fresh', value: '6.8', observedAt: '2025-04-01T00:00:00Z' })],
                labHistory: {
                    analyte: 'Hemoglobin A1c',
                    observations: [
                        lab({ source_id: 'h1', value: '7.4', observedAt: '2024-04-01T00:00:00Z' }),
                        lab({ source_id: 'h2', value: '7.0', observedAt: '2024-10-01T00:00:00Z' }),
                    ],
                },
            }),
            envelope: baseEnvelope(),
        });
        expect(result?.points).toHaveLength(3);
        expect(result?.points.map((p) => p.observedAt)).toEqual([
            '2024-04-01T00:00:00Z',
            '2024-10-01T00:00:00Z',
            '2025-04-01T00:00:00Z',
        ]);
    });

    it('treats labHistory Gap as no extra data without crashing', () => {
        const labs = [
            lab({ source_id: 'l1', value: '7.2', observedAt: '2024-09-15T00:00:00Z' }),
            lab({ source_id: 'l2', value: '7.0', observedAt: '2024-12-20T00:00:00Z' }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l2')]),
            snapshot: baseSnapshot({
                labs,
                labHistory: { kind: 'gap', reason: 'lab-history-unavailable', message: 'X' },
            }),
            envelope: baseEnvelope(),
        });
        expect(result?.points).toHaveLength(2);
    });

    it('flags abnormal points so the renderer can highlight them', () => {
        const labs = [
            lab({ source_id: 'l1', value: '5.5', abnormalFlag: null, observedAt: '2024-01-01T00:00:00Z' }),
            lab({ source_id: 'l2', value: '6.8', abnormalFlag: 'H', observedAt: '2025-04-01T00:00:00Z' }),
        ];
        const result = decideTrendChart({
            verified: verifiedWith([labClaim('c1', 'l2')]),
            snapshot: baseSnapshot({ labs }),
            envelope: baseEnvelope(),
        });
        expect(result?.points[0]?.abnormal).toBe(false);
        expect(result?.points[1]?.abnormal).toBe(true);
    });
});
