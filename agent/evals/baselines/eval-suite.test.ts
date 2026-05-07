/**
 * Structural test for the unified eval baseline.
 *
 * The PR-blocking CI gate (Phase E.4) sums per-rubric booleans across
 * every (dataset, case, rubric) cell in `eval-suite.json` and fails the
 * pipeline when more than 5% of those cells flip live. This test does
 * not score rubrics — it pins the file's *shape* against the on-disk
 * case sets so the gate cannot silently drift away from the suites.
 *
 * Three properties are asserted across all three datasets:
 *
 *   1. Every dataset's on-disk case set (manifest entries / suite
 *      EXAMPLES) is fully covered in the baseline (no untracked
 *      cases).
 *   2. Every baseline case row maps to a real case in its dataset
 *      (no orphans).
 *   3. The three `datasets.*` keys exactly match the three suite
 *      `DATASET_NAME` exports — so a future schema-bump rename
 *      (e.g. `-v1` → `-v2`) forces both the suite and the baseline
 *      in lockstep.
 *
 * The per-rubric values inside each row are not validated here; they
 * are the rebaseline script's territory (E.2 checklist + RUNBOOK
 * rebaseline section) and the CI gate's source of truth.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ARCHETYPES } from '../fixtures/regenerate-archetypes.js';
import { LAB_TREND_SCENARIOS } from '../fixtures/regenerate-lab-trends.js';
import { loadUc5MorningPrepDay } from '../fixtures/load.js';
import {
    buildExamples as buildBriefingGraphExamples,
    DATASET_NAME as BRIEFING_GRAPH_DATASET_NAME,
} from '../runners/briefingGraphSuite.js';
import {
    buildExamples as buildConversationalGraphExamples,
    DATASET_NAME as CONVERSATIONAL_GRAPH_DATASET_NAME,
} from '../runners/conversationalGraphSuite.js';
import {
    buildExamples as buildDocumentExtractionExamples,
    DATASET_NAME as DOCUMENT_EXTRACTION_DATASET_NAME,
} from '../runners/documentExtractionSuite.js';
import { RUBRIC_KEYS, type RubricKey } from '../rubrics/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, 'eval-suite.json');

interface BaselineFile {
    readonly version: number;
    readonly committedAt: string;
    readonly commitSha: string | null;
    readonly datasets: Record<string, { readonly cases: Record<string, Record<string, boolean>> }>;
}

const loadBaseline = async (): Promise<BaselineFile> => {
    const buf = await readFile(BASELINE_PATH, 'utf8');
    return JSON.parse(buf) as BaselineFile;
};

const briefingGraphCaseIds = (): readonly string[] =>
    buildBriefingGraphExamples().map((e) => e.metadata.caseId);

const conversationalGraphCaseIds = (): readonly string[] =>
    buildConversationalGraphExamples().map((e) => e.metadata.group);

const documentExtractionCaseIds = async (): Promise<readonly string[]> => {
    const examples = await buildDocumentExtractionExamples();
    return examples.map((e) => e.inputs.caseId);
};

describe('eval-suite baseline file', () => {
    it('the three dataset keys exactly match the suite DATASET_NAME exports', async () => {
        const baseline = await loadBaseline();
        const expected = new Set([
            BRIEFING_GRAPH_DATASET_NAME,
            CONVERSATIONAL_GRAPH_DATASET_NAME,
            DOCUMENT_EXTRACTION_DATASET_NAME,
        ]);
        expect(new Set(Object.keys(baseline.datasets))).toEqual(expected);
    });

    it('every on-disk briefing-graph case is covered by the baseline', async () => {
        const baseline = await loadBaseline();
        const onDisk = new Set(briefingGraphCaseIds());
        const baselined = new Set(
            Object.keys(baseline.datasets[BRIEFING_GRAPH_DATASET_NAME]!.cases),
        );
        const missing = [...onDisk].filter((id) => !baselined.has(id));
        expect(missing).toEqual([]);
    });

    it('every briefing-graph baseline row maps to a real case', async () => {
        const baseline = await loadBaseline();
        const onDisk = new Set(briefingGraphCaseIds());
        const baselined = Object.keys(baseline.datasets[BRIEFING_GRAPH_DATASET_NAME]!.cases);
        const orphans = baselined.filter((id) => !onDisk.has(id));
        expect(orphans).toEqual([]);
    });

    it('every on-disk conversational-graph case is covered by the baseline', async () => {
        const baseline = await loadBaseline();
        const onDisk = new Set(conversationalGraphCaseIds());
        const baselined = new Set(
            Object.keys(baseline.datasets[CONVERSATIONAL_GRAPH_DATASET_NAME]!.cases),
        );
        const missing = [...onDisk].filter((id) => !baselined.has(id));
        expect(missing).toEqual([]);
    });

    it('every conversational-graph baseline row maps to a real case', async () => {
        const baseline = await loadBaseline();
        const onDisk = new Set(conversationalGraphCaseIds());
        const baselined = Object.keys(baseline.datasets[CONVERSATIONAL_GRAPH_DATASET_NAME]!.cases);
        const orphans = baselined.filter((id) => !onDisk.has(id));
        expect(orphans).toEqual([]);
    });

    it('every on-disk document-extraction case is covered by the baseline', async () => {
        const [baseline, onDisk] = await Promise.all([
            loadBaseline(),
            documentExtractionCaseIds(),
        ]);
        const baselined = new Set(
            Object.keys(baseline.datasets[DOCUMENT_EXTRACTION_DATASET_NAME]!.cases),
        );
        const missing = onDisk.filter((id) => !baselined.has(id));
        expect(missing).toEqual([]);
    });

    it('every document-extraction baseline row maps to a real case', async () => {
        const [baseline, onDisk] = await Promise.all([
            loadBaseline(),
            documentExtractionCaseIds(),
        ]);
        const onDiskSet = new Set(onDisk);
        const baselined = Object.keys(baseline.datasets[DOCUMENT_EXTRACTION_DATASET_NAME]!.cases);
        const orphans = baselined.filter((id) => !onDiskSet.has(id));
        expect(orphans).toEqual([]);
    });

    it('every rubric key referenced in any case row is from the closed RUBRIC_KEYS set', async () => {
        const baseline = await loadBaseline();
        const allowed = new Set<RubricKey>(RUBRIC_KEYS);
        const offenders: string[] = [];
        for (const [datasetName, dataset] of Object.entries(baseline.datasets)) {
            for (const [caseId, row] of Object.entries(dataset.cases)) {
                for (const rubric of Object.keys(row)) {
                    if (!allowed.has(rubric as RubricKey)) {
                        offenders.push(`${datasetName}::${caseId}::${rubric}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('archetype + lab-trend + morning-prep case ids match the briefing-graph suite shape', () => {
        // Sanity-check: the briefing-graph suite emits case ids of the
        // form `archetype:<key>`, `lab-trend:<key>`, `morning-prep:<id>`.
        // If a case-id-shape regression lands in the suite, this test
        // catches it before the baseline coverage tests above produce a
        // confusing diff.
        const ids = briefingGraphCaseIds();
        const archetypeIds = ids.filter((id) => id.startsWith('archetype:'));
        const labTrendIds = ids.filter((id) => id.startsWith('lab-trend:'));
        const morningPrepIds = ids.filter((id) => id.startsWith('morning-prep:'));
        expect(archetypeIds).toHaveLength(ARCHETYPES.length);
        expect(labTrendIds).toHaveLength(LAB_TREND_SCENARIOS.length);
        expect(morningPrepIds).toHaveLength(loadUc5MorningPrepDay().slots.length);
    });
});
