/**
 * §B.10 stubbed-only summary case for the developer's inner loop.
 *
 * The four sibling test files (lab-pdf / intake-form / degraded /
 * adversarial) are already stubbed at the per-MR layer, so they're
 * the load-bearing local-dev gate. This file pins one additional
 * invariant the four sibling files don't: every manifest row must
 * resolve to exactly one of the categorized test files. Without this,
 * a future fixture addition that picks a CaseKind not covered by the
 * sibling files would land silently uncovered.
 */

import { describe, expect, it } from 'vitest';

import { allEntries } from '../_helpers.js';

const COVERED_CASE_KINDS = new Set([
    // lab-pdf/
    'lab-pdf-clean',
    'lab-pdf-multi-panel',
    'lab-pdf-low-quality',
    'lab-pdf-fax-packet',
    // intake-form/
    'intake-form-clean',
    'intake-form-image',
    'intake-form-demographics-delta',
    // degraded/
    'degraded-smudged',
    'degraded-rotated',
    'degraded-blank',
    'degraded-unrelated',
    'degraded-partial',
    'degraded-ocr-bad',
    // adversarial/
    'adversarial-wrong-patient',
    'adversarial-prompt-injection',
    'adversarial-oversized',
    'adversarial-corrupted',
]);

describe('§B.10 stubbed-only coverage', () => {
    it('every manifest entry maps to a CaseKind one of the per-category test files asserts on', async () => {
        const entries = await allEntries();
        const uncovered = entries.filter((e) => !COVERED_CASE_KINDS.has(e.caseKind));
        expect(uncovered.map((e) => `${e.id}/${e.caseKind}`)).toEqual([]);
    });

    it('exactly 26 cases land', async () => {
        const entries = await allEntries();
        expect(entries.length).toBe(26);
    });

    it('case-kind balance matches the W2 plan: 8 lab + 8 intake + 6 degraded + 4 adversarial', async () => {
        const entries = await allEntries();
        const labKinds = new Set([
            'lab-pdf-clean',
            'lab-pdf-multi-panel',
            'lab-pdf-low-quality',
            'lab-pdf-fax-packet',
        ]);
        const intakeKinds = new Set([
            'intake-form-clean',
            'intake-form-image',
            'intake-form-demographics-delta',
        ]);
        const degradedKinds = new Set([
            'degraded-smudged',
            'degraded-rotated',
            'degraded-blank',
            'degraded-unrelated',
            'degraded-partial',
            'degraded-ocr-bad',
        ]);
        const adversarialKinds = new Set([
            'adversarial-wrong-patient',
            'adversarial-prompt-injection',
            'adversarial-oversized',
            'adversarial-corrupted',
        ]);
        const labCount = entries.filter((e) => labKinds.has(e.caseKind)).length;
        const intakeCount = entries.filter((e) => intakeKinds.has(e.caseKind)).length;
        const degradedCount = entries.filter((e) => degradedKinds.has(e.caseKind)).length;
        const adversarialCount = entries.filter((e) => adversarialKinds.has(e.caseKind)).length;
        expect(labCount).toBe(8);
        expect(intakeCount).toBe(8);
        expect(degradedCount).toBe(6);
        expect(adversarialCount).toBe(4);
    });
});
