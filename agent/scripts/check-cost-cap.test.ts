import { describe, expect, it } from 'vitest';

import { estimateCost, HARD_CAP_USD, PER_CASE_USD } from './check-cost-cap.js';

describe('estimateCost', () => {
    it('multiplies case count by unit and sums across suites', async () => {
        const estimate = await estimateCost({
            caseCounts: {
                'briefing-graph': 10,
                'conversational-graph': 5,
                'document-extraction': 5,
            },
            perCaseUsd: {
                'briefing-graph': 0.10,
                'conversational-graph': 0.20,
                'document-extraction': 0.30,
            },
        });
        expect(estimate.perSuite['briefing-graph']).toEqual({ caseCount: 10, estimatedUsd: 1.0 });
        expect(estimate.perSuite['conversational-graph']).toEqual({ caseCount: 5, estimatedUsd: 1.0 });
        expect(estimate.perSuite['document-extraction']).toEqual({ caseCount: 5, estimatedUsd: 1.5 });
        expect(estimate.totalUsd).toBe(3.5);
    });

    it('underCap is true at exactly the cap', async () => {
        const estimate = await estimateCost({
            caseCounts: { 'briefing-graph': 50 },
            perCaseUsd: { 'briefing-graph': 0.10 },
            hardCapUsd: 5.0,
        });
        expect(estimate.totalUsd).toBe(5.0);
        expect(estimate.underCap).toBe(true);
    });

    it('underCap is false when estimate exceeds cap', async () => {
        const estimate = await estimateCost({
            caseCounts: { 'briefing-graph': 60 },
            perCaseUsd: { 'briefing-graph': 0.10 },
            hardCapUsd: 5.0,
        });
        expect(estimate.totalUsd).toBe(6.0);
        expect(estimate.underCap).toBe(false);
    });

    it('throws on a suite with no unit price configured', async () => {
        await expect(
            estimateCost({
                caseCounts: { 'mystery-suite': 1 },
                perCaseUsd: { 'briefing-graph': 0.10 },
            }),
        ).rejects.toThrowError(/unknown suite/);
    });

    it('uses the live dataset case counts when caseCounts is not overridden', async () => {
        const estimate = await estimateCost();
        // The three suites must all be present.
        expect(Object.keys(estimate.perSuite).sort()).toEqual([
            'briefing-graph',
            'conversational-graph',
            'document-extraction',
        ]);
        // Case counts are non-negative integers and known to be small at HEAD.
        for (const { caseCount } of Object.values(estimate.perSuite)) {
            expect(caseCount).toBeGreaterThan(0);
            expect(Number.isInteger(caseCount)).toBe(true);
        }
        // The total at HEAD must be under the hard cap; if this ever
        // regresses, it's a real signal that case-count growth or unit
        // price changes pushed us over budget.
        expect(estimate.totalUsd).toBeLessThanOrEqual(HARD_CAP_USD);
        expect(estimate.underCap).toBe(true);
    });

    it('every PER_CASE_USD entry covers exactly the three suites we ship', () => {
        expect(Object.keys(PER_CASE_USD).sort()).toEqual([
            'briefing-graph',
            'conversational-graph',
            'document-extraction',
        ]);
    });
});
