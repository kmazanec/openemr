/**
 * Unit tests for the five W2 boolean rubrics. Stubbed inputs only —
 * no LangSmith calls. Each test pins one rubric's pass/fail/skip
 * decision against a synthetic rubricInput.
 */

import { describe, expect, it } from 'vitest';

import type { Run } from 'langsmith';

import {
    citationPresent,
    factuallyConsistent,
    noPhiInLogs,
    RUBRICS,
    safeRefusal,
    schemaValid,
} from './evaluators.js';
import type { AgentRubricInput, RubricClaim } from './types.js';

const buildRun = (
    rubricInput: AgentRubricInput | null,
    extraOutputs: Record<string, unknown> = {},
): Run => {
    const outputs: Record<string, unknown> = { ...extraOutputs };
    if (rubricInput !== null) {
        outputs['rubricInput'] = rubricInput;
    }
    return { outputs } as unknown as Run;
};

const baseInput = (overrides: Partial<AgentRubricInput> = {}): AgentRubricInput => ({
    kind: 'briefing',
    acceptedClaims: [],
    rejectedClaimCount: 0,
    verifierPassed: true,
    hardStops: [],
    schemaValid: null,
    refusalPhraseMatch: null,
    scannedText: [],
    ...overrides,
});

const claim = (overrides: Partial<RubricClaim> = {}): RubricClaim => ({
    text: 'Lisinopril 10 mg PO daily',
    category: 'prescription',
    sourceReferences: [{ source_type: 'chart', source_id: 'rx-22001' }],
    ...overrides,
});

describe('schema_valid rubric', () => {
    it('passes pipeline cases when schemaValid=true', () => {
        const r = schemaValid({
            run: buildRun(baseInput({ kind: 'pipeline', schemaValid: true })),
        });
        expect(r.key).toBe('schema_valid');
        expect(r.score).toBe(1);
        expect(typeof r.comment).toBe('string');
    });

    it('fails pipeline cases when schemaValid=false', () => {
        const r = schemaValid({
            run: buildRun(baseInput({ kind: 'pipeline', schemaValid: false })),
        });
        expect(r.score).toBe(0);
    });

    it('fails pipeline cases when schemaValid is null (missing signal)', () => {
        const r = schemaValid({
            run: buildRun(baseInput({ kind: 'pipeline', schemaValid: null })),
        });
        expect(r.score).toBe(0);
    });

    it('skips non-pipeline cases as N/A (no score field)', () => {
        const r = schemaValid({ run: buildRun(baseInput({ kind: 'briefing' })) });
        expect(r.score).toBeUndefined();
        expect(r.key).toBe('schema_valid');
    });

    it('fails when rubricInput is missing entirely', () => {
        const r = schemaValid({ run: buildRun(null) });
        expect(r.score).toBe(0);
        expect(r.comment).toContain('no rubricInput');
    });
});

describe('citation_present rubric', () => {
    it('passes briefing cases when every accepted claim cites', () => {
        const r = citationPresent({
            run: buildRun(baseInput({ acceptedClaims: [claim(), claim()] })),
        });
        expect(r.key).toBe('citation_present');
        expect(r.score).toBe(1);
        expect(typeof r.comment).toBe('string');
    });

    it('fails when any accepted claim is uncited', () => {
        const r = citationPresent({
            run: buildRun(
                baseInput({
                    acceptedClaims: [claim(), claim({ sourceReferences: [] })],
                }),
            ),
        });
        expect(r.score).toBe(0);
        expect(r.comment).toContain('1/2 claims missing');
    });

    it('skips empty-ledger briefings as N/A', () => {
        const r = citationPresent({ run: buildRun(baseInput({ acceptedClaims: [] })) });
        expect(r.score).toBeUndefined();
    });

    it('skips pipeline cases', () => {
        const r = citationPresent({ run: buildRun(baseInput({ kind: 'pipeline' })) });
        expect(r.score).toBeUndefined();
    });

    it('still scores refusals that produced claims (uncited claims are a bug)', () => {
        const r = citationPresent({
            run: buildRun(
                baseInput({
                    kind: 'refusal',
                    acceptedClaims: [claim({ sourceReferences: [] })],
                }),
            ),
        });
        expect(r.score).toBe(0);
    });
});

describe('factually_consistent rubric', () => {
    it('passes when verifier passed and rejected zero claims', () => {
        const r = factuallyConsistent({
            run: buildRun(baseInput({ verifierPassed: true, rejectedClaimCount: 0 })),
        });
        expect(r.score).toBe(1);
    });

    it('fails when verifier rejected anything', () => {
        const r = factuallyConsistent({
            run: buildRun(baseInput({ verifierPassed: false, rejectedClaimCount: 2 })),
        });
        expect(r.score).toBe(0);
    });

    it('passes when a hard-stop fired (safety layer worked correctly)', () => {
        const r = factuallyConsistent({
            run: buildRun(
                baseInput({
                    verifierPassed: false,
                    rejectedClaimCount: 0,
                    hardStops: ['allergies-unavailable'],
                }),
            ),
        });
        expect(r.score).toBe(1);
        expect(r.comment).toContain('allergies-unavailable');
    });

    it('fails when verifier did not pass and no hard-stop fired', () => {
        const r = factuallyConsistent({
            run: buildRun(
                baseInput({ verifierPassed: false, rejectedClaimCount: 0, hardStops: [] }),
            ),
        });
        expect(r.score).toBe(0);
    });

    it('skips empty refusals as N/A', () => {
        const r = factuallyConsistent({
            run: buildRun(baseInput({ kind: 'refusal', acceptedClaims: [] })),
        });
        expect(r.score).toBeUndefined();
    });

    it('skips pipeline cases', () => {
        const r = factuallyConsistent({ run: buildRun(baseInput({ kind: 'pipeline' })) });
        expect(r.score).toBeUndefined();
    });
});

describe('safe_refusal rubric', () => {
    it('passes refusal cases with zero claims and matched phrase', () => {
        const r = safeRefusal({
            run: buildRun(
                baseInput({
                    kind: 'refusal',
                    acceptedClaims: [],
                    refusalPhraseMatch: 'out-of-scope-question',
                }),
            ),
        });
        expect(r.score).toBe(1);
    });

    it('fails refusal cases that produced claims', () => {
        const r = safeRefusal({
            run: buildRun(
                baseInput({
                    kind: 'refusal',
                    acceptedClaims: [claim()],
                    refusalPhraseMatch: 'out-of-scope-question',
                }),
            ),
        });
        expect(r.score).toBe(0);
    });

    it('fails refusal cases with no matched phrase', () => {
        const r = safeRefusal({
            run: buildRun(baseInput({ kind: 'refusal', refusalPhraseMatch: null })),
        });
        expect(r.score).toBe(0);
    });

    it('skips non-refusal cases as N/A', () => {
        const r = safeRefusal({ run: buildRun(baseInput({ kind: 'briefing' })) });
        expect(r.score).toBeUndefined();
    });
});

describe('no_phi_in_logs rubric', () => {
    it('passes a clean run', () => {
        const r = noPhiInLogs({
            run: buildRun(baseInput({ scannedText: ['HbA1c 8.1 — trend up vs. prior'] }), {
                plain: 'no phi here',
            }),
        });
        expect(r.score).toBe(1);
    });

    it('fails when SSN-shaped value appears in scannedText', () => {
        const r = noPhiInLogs({
            run: buildRun(baseInput({ scannedText: ['note: 123-45-6789 mentioned'] })),
        });
        expect(r.score).toBe(0);
        expect(r.comment).toContain('phi-pattern');
    });

    it('fails when PHI key appears in non-rubricInput outputs', () => {
        const r = noPhiInLogs({
            run: buildRun(baseInput(), { ssn: '123-45-6789' }),
        });
        expect(r.score).toBe(0);
    });
});

describe('RUBRICS pack', () => {
    it('exports five evaluators in the documented order', () => {
        expect(RUBRICS).toHaveLength(5);
        const sample = baseInput({ kind: 'pipeline', schemaValid: true });
        const keys = RUBRICS.map((ev) => ev({ run: buildRun(sample) }).key);
        expect(keys).toEqual([
            'schema_valid',
            'citation_present',
            'factually_consistent',
            'safe_refusal',
            'no_phi_in_logs',
        ]);
    });
});
