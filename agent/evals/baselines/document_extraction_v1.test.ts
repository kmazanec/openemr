/**
 * §B.10 baseline structural test.
 *
 * Pins three properties of the per-case baseline:
 *   1. Every manifest entry has a baseline row (no untracked cases).
 *   2. Every baseline row's `id` matches a manifest entry (no orphans).
 *   3. The dataset name on the baseline matches the suite's
 *      DATASET_NAME constant (so a future schema-bump rename forces
 *      both files in lockstep).
 *
 * Phase E extends the baseline with real-model rubric scores; the
 * boolean shape pinned here is the Phase B contract.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEntries } from '../runners/documentExtractionFixtures.js';
import { DATASET_NAME } from '../runners/documentExtractionSuite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, 'document_extraction_v1.json');

interface BaselineFile {
    readonly version: number;
    readonly datasetName: string;
    readonly description: string;
    readonly cases: readonly {
        readonly id: string;
        readonly category: string;
        readonly passing: boolean;
    }[];
}

const loadBaseline = async (): Promise<BaselineFile> => {
    const buf = await readFile(BASELINE_PATH, 'utf8');
    return JSON.parse(buf) as BaselineFile;
};

describe('§B.10 baseline file', () => {
    it('every manifest case has a baseline row', async () => {
        const [entries, baseline] = await Promise.all([loadEntries(), loadBaseline()]);
        const baselineIds = new Set(baseline.cases.map((c) => c.id));
        const missingFromBaseline = entries
            .map((e) => e.id)
            .filter((id) => !baselineIds.has(id));
        expect(missingFromBaseline).toEqual([]);
    });

    it('every baseline row has a matching manifest case', async () => {
        const [entries, baseline] = await Promise.all([loadEntries(), loadBaseline()]);
        const manifestIds = new Set(entries.map((e) => e.id));
        const orphans = baseline.cases.map((c) => c.id).filter((id) => !manifestIds.has(id));
        expect(orphans).toEqual([]);
    });

    it("baseline dataset name matches the suite's DATASET_NAME", async () => {
        const baseline = await loadBaseline();
        expect(baseline.datasetName).toBe(DATASET_NAME);
    });

    it('every baseline row currently passes (Phase B contract)', async () => {
        const baseline = await loadBaseline();
        const failing = baseline.cases.filter((c) => !c.passing).map((c) => c.id);
        expect(failing).toEqual([]);
    });
});
