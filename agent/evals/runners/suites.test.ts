import { describe, expect, it, vi } from 'vitest';

import type { Client } from 'langsmith';

import { ARCHETYPES } from '../fixtures/regenerate-archetypes.js';

import {
    DATASET_NAME as ARCHETYPES_DATASET_NAME,
    uploadDataset as uploadArchetypesDataset,
} from './archetypesSuite.js';
import { DATASET_NAME as CONVERSATIONAL_GRAPH_DATASET_NAME } from './conversationalGraphSuite.js';
import { DATASET_NAME as DOCUMENT_EXTRACTION_DATASET_NAME } from './documentExtractionSuite.js';
import { DATASET_NAME as END_TO_END_DATASET_NAME, buildExamples as buildEndToEndExamples } from './endToEndSuite.js';
import { DATASET_NAME as LAB_TRENDS_DATASET_NAME } from './labTrendsSuite.js';
import {
    DATASET_NAME as MORNING_PREP_DATASET_NAME,
    uploadDataset as uploadMorningPrepDataset,
} from './morningPrepSuite.js';

/**
 * Suite uploader unit tests. Two branches matter for every suite:
 *
 *   - LANGSMITH_API_KEY missing → skip with structured reason.
 *   - Dataset already exists → skip; never call createDataset/createExamples.
 *
 * The success path is covered indirectly by asserting the expected
 * createDataset+createExamples call shape when the dataset is fresh.
 *
 * Archetypes and morning-prep have substantively different example
 * shapes; lab-trends shares the same skeleton as archetypes (every
 * test would be a copy), so we cover archetypes (string-keyed
 * outputs) and morning-prep (per-slot flag arrays) and trust the
 * generic uploader for the rest.
 */

const stubClient = (overrides: Partial<Client>): Client =>
    ({
        hasDataset: vi.fn(),
        createDataset: vi.fn(),
        createExamples: vi.fn(),
        ...overrides,
    }) as unknown as Client;

describe('archetypesSuite.uploadDataset', () => {
    it('uses a v4 dataset name (schema-bump contract: rename when shape changes)', () => {
        // The bump-on-shape-change rule lives in the suite module's
        // docblock; pinning the suffix here means a future shape change
        // is forced through a name change rather than silent reuse.
        // Bumped to -v4 with the W2 unified `SourceReference` shape.
        expect(ARCHETYPES_DATASET_NAME.endsWith('-v4')).toBe(true);
    });

    it('skips when LANGSMITH_API_KEY is unset', async () => {
        const result = await uploadArchetypesDataset({ apiKey: '' });
        expect(result.created).toBe(false);
        expect(result.skippedReason).toBe('LANGSMITH_API_KEY not set');
        expect(result.exampleCount).toBe(0);
    });

    it('skips when the dataset already exists', async () => {
        const hasDataset = vi.fn(() => Promise.resolve(true));
        const createDataset = vi.fn();
        const createExamples = vi.fn();
        const client = stubClient({ hasDataset, createDataset, createExamples });

        const result = await uploadArchetypesDataset({ apiKey: 'fake', client });

        expect(hasDataset).toHaveBeenCalledWith({ datasetName: ARCHETYPES_DATASET_NAME });
        expect(createDataset).not.toHaveBeenCalled();
        expect(createExamples).not.toHaveBeenCalled();
        expect(result.created).toBe(false);
        expect(result.skippedReason).toBe('dataset already exists');
    });

    it('creates the dataset and one example per archetype when missing', async () => {
        const hasDataset = vi.fn(() => Promise.resolve(false));
        const fakeDataset = { id: 'ds-id-1', name: ARCHETYPES_DATASET_NAME };
        const createDataset = vi.fn(() => Promise.resolve(fakeDataset));
        const createExamples = vi.fn((_uploads: readonly unknown[]) => Promise.resolve([]));
        const client = stubClient({
            hasDataset,
            createDataset: createDataset as unknown as Client['createDataset'],
            createExamples: createExamples as unknown as Client['createExamples'],
        });

        const result = await uploadArchetypesDataset({ apiKey: 'fake', client });

        expect(createDataset).toHaveBeenCalledTimes(1);
        expect(createExamples).toHaveBeenCalledTimes(1);
        const firstCall = createExamples.mock.calls[0];
        if (firstCall === undefined) {
            throw new Error('expected createExamples to have been called');
        }
        const args = firstCall[0] as readonly { metadata: { archetype: string } }[];
        expect(args).toHaveLength(ARCHETYPES.length);
        expect(args.map((a) => a.metadata.archetype).sort()).toEqual([...ARCHETYPES].sort());
        expect(result.created).toBe(true);
        expect(result.exampleCount).toBe(ARCHETYPES.length);
    });
});

describe('morningPrepSuite.uploadDataset', () => {
    it('skips when LANGSMITH_API_KEY is unset', async () => {
        const result = await uploadMorningPrepDataset({ apiKey: '' });
        expect(result.created).toBe(false);
        expect(result.skippedReason).toBe('LANGSMITH_API_KEY not set');
        expect(result.datasetName).toBe(MORNING_PREP_DATASET_NAME);
        expect(result.exampleCount).toBe(0);
    });

    it('uses a v2 dataset name (schema-bump contract: rename when shape changes)', () => {
        // The bump-on-shape-change rule lives in the suite module's
        // docblock; pinning the suffix here means a future shape change
        // is forced through a name change rather than silent reuse.
        // Bumped to -v2 with the W2 unified `SourceReference` shape.
        expect(MORNING_PREP_DATASET_NAME.endsWith('-v2')).toBe(true);
    });

    it('creates the dataset and one example per slot when missing', async () => {
        const hasDataset = vi.fn(() => Promise.resolve(false));
        const fakeDataset = { id: 'ds-uc5-1', name: MORNING_PREP_DATASET_NAME };
        const createDataset = vi.fn(() => Promise.resolve(fakeDataset));
        const createExamples = vi.fn((_uploads: readonly unknown[]) => Promise.resolve([]));
        const client = {
            hasDataset,
            createDataset: createDataset as unknown as Client['createDataset'],
            createExamples: createExamples as unknown as Client['createExamples'],
        } as unknown as Client;

        const result = await uploadMorningPrepDataset({ apiKey: 'fake', client });

        expect(hasDataset).toHaveBeenCalledWith({ datasetName: MORNING_PREP_DATASET_NAME });
        expect(createDataset).toHaveBeenCalledTimes(1);
        expect(createExamples).toHaveBeenCalledTimes(1);
        const firstCall = createExamples.mock.calls[0];
        if (firstCall === undefined) {
            throw new Error('expected createExamples to have been called');
        }
        const args = firstCall[0] as readonly {
            metadata: { archetype: string; appointmentId: string };
            outputs: { archetypeFlags: readonly string[] };
        }[];
        expect(args).toHaveLength(20);
        const flagged = args.filter((a) => a.outputs.archetypeFlags.length > 0);
        expect(flagged).toHaveLength(8);
        expect(result.created).toBe(true);
        expect(result.exampleCount).toBe(20);
    });
});

describe('labTrendsSuite', () => {
    it('uses a v2 dataset name (schema-bump contract: rename when shape changes)', () => {
        // Lab-trends shares the uploader skeleton with archetypes (the
        // module docblock above explains why the success-path tests
        // aren't duplicated here). The version-suffix pin still lives
        // here so the schema-bump contract is enforced for every suite.
        // Bumped to -v2 with the W2 unified `SourceReference` shape.
        expect(LAB_TRENDS_DATASET_NAME.endsWith('-v2')).toBe(true);
    });
});

describe('conversationalGraphSuite', () => {
    it('uses a v1 dataset name (schema-bump contract: rename when shape changes)', () => {
        // First version of the conversational-graph dataset; bump to
        // -v2 when the input/output shape changes so old experiments
        // stay comparable.
        expect(CONVERSATIONAL_GRAPH_DATASET_NAME.endsWith('-v1')).toBe(true);
    });
});

describe('documentExtractionSuite', () => {
    it('uses a v1 dataset name (schema-bump contract: rename when shape changes)', () => {
        // First version of the §B.10 pipeline-extraction dataset.
        // Bump the suffix when the input/output shape changes so old
        // experiments stay comparable.
        expect(DOCUMENT_EXTRACTION_DATASET_NAME.endsWith('-v1')).toBe(true);
    });
});

describe('endToEndSuite', () => {
    it('uses a v1 dataset name (schema-bump contract: rename when shape changes)', () => {
        // First version of the §D.4 end-to-end MVP dataset. Bump
        // the suffix when the input/output shape changes so old
        // experiments stay comparable.
        expect(END_TO_END_DATASET_NAME.endsWith('-v1')).toBe(true);
    });

    it('ships exactly six examples (3 Patel + 3 refusal) — Phase D MVP gate count', () => {
        // The Phase D plan pins six end-to-end cases. Pinning the
        // count here means a future change that re-balances the suite
        // is forced to re-read the plan rather than silently grow or
        // shrink the dataset.
        const examples = buildEndToEndExamples();
        expect(examples).toHaveLength(6);
        const groups = examples.map((e) => e.metadata.group).sort();
        expect(groups).toEqual([
            'patel-scenario',
            'patel-scenario',
            'patel-scenario',
            'refusal',
            'refusal',
            'refusal',
        ]);
    });
});
