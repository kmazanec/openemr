import { describe, expect, it, vi } from 'vitest';

import type { Client } from 'langsmith';

import { ARCHETYPES } from '../fixtures/regenerate.js';

import { DATASET_NAME, uploadDataset } from './langsmithDataset.js';

/**
 * §3.6 uploader unit tests. Two branches matter:
 *
 *   - LANGSMITH_API_KEY missing → skip with structured reason.
 *   - Dataset already exists → skip; never call createDataset/createExamples.
 *
 * The success path is covered indirectly by asserting the expected
 * createDataset+createExamples call shape when the dataset is fresh.
 */

const stubClient = (overrides: Partial<Client>): Client =>
    ({
        hasDataset: vi.fn(),
        createDataset: vi.fn(),
        createExamples: vi.fn(),
        ...overrides,
    }) as unknown as Client;

describe('uploadDataset', () => {
    it('skips when LANGSMITH_API_KEY is unset', async () => {
        const result = await uploadDataset({ apiKey: '' });
        expect(result.created).toBe(false);
        expect(result.skippedReason).toBe('LANGSMITH_API_KEY not set');
        expect(result.exampleCount).toBe(0);
    });

    it('skips when the dataset already exists', async () => {
        const hasDataset = vi.fn(() => Promise.resolve(true));
        const createDataset = vi.fn();
        const createExamples = vi.fn();
        const client = stubClient({ hasDataset, createDataset, createExamples });

        const result = await uploadDataset({ apiKey: 'fake', client });

        expect(hasDataset).toHaveBeenCalledWith({ datasetName: DATASET_NAME });
        expect(createDataset).not.toHaveBeenCalled();
        expect(createExamples).not.toHaveBeenCalled();
        expect(result.created).toBe(false);
        expect(result.skippedReason).toBe('dataset already exists');
    });

    it('creates the dataset and one example per archetype when missing', async () => {
        const hasDataset = vi.fn(() => Promise.resolve(false));
        const fakeDataset = { id: 'ds-id-1', name: DATASET_NAME };
        const createDataset = vi.fn(() => Promise.resolve(fakeDataset));
        const createExamples = vi.fn((_uploads: readonly unknown[]) => Promise.resolve([]));
        const client = stubClient({
            hasDataset,
            createDataset: createDataset as unknown as Client['createDataset'],
            createExamples: createExamples as unknown as Client['createExamples'],
        });

        const result = await uploadDataset({ apiKey: 'fake', client });

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
