import { describe, expect, it, vi } from 'vitest';

import type { Client } from 'langsmith';

import { ARCHETYPES } from '../fixtures/regenerate-archetypes.js';
import { LAB_TREND_SCENARIOS } from '../fixtures/regenerate-lab-trends.js';

import {
    DATASET_NAME as BRIEFING_GRAPH_DATASET_NAME,
    buildExamples as buildBriefingGraphExamples,
    uploadDataset as uploadBriefingGraphDataset,
} from './briefingGraphSuite.js';
import { DATASET_NAME as CONVERSATIONAL_GRAPH_DATASET_NAME } from './conversationalGraphSuite.js';
import { DATASET_NAME as DOCUMENT_EXTRACTION_DATASET_NAME } from './documentExtractionSuite.js';
import {
    DATASET_NAME as END_TO_END_DATASET_NAME,
    buildExamples as buildEndToEndExamples,
} from './endToEndSuite.js';

/**
 * Suite uploader unit tests. Two branches matter for every suite:
 *
 *   - LANGSMITH_API_KEY missing → skip with structured reason.
 *   - Dataset already exists → skip; never call createDataset/createExamples.
 *
 * The success path is covered indirectly by asserting the expected
 * createDataset+createExamples call shape when the dataset is fresh.
 *
 * The merged briefing-graph suite carries the multi-case-kind
 * contract (archetype + lab-trend + morning-prep), so we exercise
 * its uploader specifically. The other suites share the generic
 * uploader skeleton; we only pin their version suffix here.
 */

const stubClient = (overrides: Partial<Client>): Client =>
    ({
        hasDataset: vi.fn(),
        createDataset: vi.fn(),
        createExamples: vi.fn(),
        ...overrides,
    }) as unknown as Client;

describe('briefingGraphSuite', () => {
    it('uses a v2 dataset name (schema-bump contract: rename when shape changes)', () => {
        // Merged-suite v1 was the predecessor archetypes-v4 +
        // lab-trends-v2 + morning-prep-v2 consolidation. Bumped to v2
        // (F.5e) when the synthesizer's `ClaimCategory` enum gained a
        // `family_history` slot — older experiments captured before
        // the slot landed are no longer directly comparable.
        expect(BRIEFING_GRAPH_DATASET_NAME.endsWith('-v2')).toBe(true);
        expect(BRIEFING_GRAPH_DATASET_NAME).toBe('clinical-copilot-briefing-graph-v2');
    });

    it('skips when LANGSMITH_API_KEY is unset', async () => {
        const result = await uploadBriefingGraphDataset({ apiKey: '' });
        expect(result.created).toBe(false);
        expect(result.skippedReason).toBe('LANGSMITH_API_KEY not set');
        expect(result.exampleCount).toBe(0);
    });

    it('skips when the dataset already exists', async () => {
        const hasDataset = vi.fn(() => Promise.resolve(true));
        const createDataset = vi.fn();
        const createExamples = vi.fn();
        const client = stubClient({ hasDataset, createDataset, createExamples });

        const result = await uploadBriefingGraphDataset({ apiKey: 'fake', client });

        expect(hasDataset).toHaveBeenCalledWith({ datasetName: BRIEFING_GRAPH_DATASET_NAME });
        expect(createDataset).not.toHaveBeenCalled();
        expect(createExamples).not.toHaveBeenCalled();
        expect(result.created).toBe(false);
        expect(result.skippedReason).toBe('dataset already exists');
    });

    it('builds examples from all three case kinds (archetype + lab-trend + morning-prep)', () => {
        const examples = buildBriefingGraphExamples();
        const byKind = new Map<string, number>();
        for (const ex of examples) {
            byKind.set(ex.metadata.caseKind, (byKind.get(ex.metadata.caseKind) ?? 0) + 1);
        }
        expect(byKind.get('archetype')).toBe(ARCHETYPES.length);
        expect(byKind.get('lab-trend')).toBe(LAB_TREND_SCENARIOS.length);
        expect(byKind.get('morning-prep')).toBe(20);
        expect(examples).toHaveLength(ARCHETYPES.length + LAB_TREND_SCENARIOS.length + 20);
    });

    it('emits one example per archetype with the expected ground-truth shape', () => {
        const examples = buildBriefingGraphExamples();
        const archetypeExamples = examples.filter((e) => e.metadata.caseKind === 'archetype');
        const archetypes = archetypeExamples.map((e) => {
            if (e.inputs.caseKind !== 'archetype') {
                throw new Error('case-kind/inputs mismatch');
            }
            return e.inputs.archetype;
        });
        expect([...archetypes].sort()).toEqual([...ARCHETYPES].sort());
    });

    it('emits the morning-prep flagged subset (8 of 20 slots)', () => {
        const examples = buildBriefingGraphExamples();
        const morningPrep = examples.filter((e) => e.metadata.caseKind === 'morning-prep');
        const flagged = morningPrep.filter((e) => {
            if (e.outputs.caseKind !== 'morning-prep') {
                throw new Error('case-kind/outputs mismatch');
            }
            return e.outputs.archetypeFlags.length > 0;
        });
        expect(flagged).toHaveLength(8);
    });

    it('creates the dataset and one example per case kind when missing', async () => {
        const hasDataset = vi.fn(() => Promise.resolve(false));
        const fakeDataset = { id: 'ds-bg-1', name: BRIEFING_GRAPH_DATASET_NAME };
        const createDataset = vi.fn(() => Promise.resolve(fakeDataset));
        const createExamples = vi.fn((_uploads: readonly unknown[]) => Promise.resolve([]));
        const client = stubClient({
            hasDataset,
            createDataset: createDataset as unknown as Client['createDataset'],
            createExamples: createExamples as unknown as Client['createExamples'],
        });

        const result = await uploadBriefingGraphDataset({ apiKey: 'fake', client });

        expect(createDataset).toHaveBeenCalledTimes(1);
        expect(createExamples).toHaveBeenCalledTimes(1);
        expect(result.created).toBe(true);
        expect(result.exampleCount).toBe(ARCHETYPES.length + LAB_TREND_SCENARIOS.length + 20);
    });
});

describe('conversationalGraphSuite', () => {
    it('uses a v3 dataset name (schema-bump contract: rename when shape changes)', () => {
        // Bumped to -v2 when the case-group enum widened to add
        // multi-retriever and cap-hit. Bumped to -v3 (F.5e) when the
        // synthesizer's `ClaimCategory` enum gained a `family_history`
        // slot.
        expect(CONVERSATIONAL_GRAPH_DATASET_NAME.endsWith('-v3')).toBe(true);
    });
});

describe('documentExtractionSuite', () => {
    it('uses a v1 dataset name (schema-bump contract: rename when shape changes)', () => {
        expect(DOCUMENT_EXTRACTION_DATASET_NAME.endsWith('-v1')).toBe(true);
    });
});

describe('endToEndSuite', () => {
    it('uses a v3 dataset name (schema-bump contract: rename when shape changes)', () => {
        // Bumped to -v2 when the redaction cases (cross-patient-leakage,
        // hidden-off-schema-field) were reclassified from `kind: 'refusal'`
        // to `kind: 'conversational'` and their `expectedVerdict` enum
        // shifted from `no-sections-render-redacted` to
        // `chart-only-redacted` to reflect that the model legitimately
        // answers the (benign, on-topic) question with chart claims.
        // Bumped to -v3 (F.5e) when the synthesizer's `ClaimCategory`
        // enum gained a `family_history` slot.
        expect(END_TO_END_DATASET_NAME.endsWith('-v3')).toBe(true);
    });

    it('ships exactly six examples (3 Patel + 3 refusal) — Phase D MVP gate count', () => {
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

/**
 * Standing policy: every eval suite runs against the real model
 * unless explicitly flagged. The only acceptable
 * `runExperiment`-time skip is a missing-env-var skip that the
 * `experiment.ts` runner-level gate would have caught anyway. Any
 * suite that introduces a new skip pattern (gating, "deferred
 * follow-up," etc.) must add it to this allowlist with a paired
 * tracking ticket — silent skips drift the cohort apart.
 *
 * The test reads each `*Suite.ts` source file and asserts every
 * `skippedReason` literal in the file matches one of the allowed
 * patterns. Source-level rather than runtime because the only way to
 * test the runtime behavior would be to actually run `evaluate`
 * against LangSmith — that's the experiment itself, not a unit
 * test.
 */
describe('eval-suite skip policy', () => {
    const ALLOWED_SKIP_PATTERNS: readonly RegExp[] = [/^missing vendor env: /];

    const isAllowed = (literal: string): boolean =>
        ALLOWED_SKIP_PATTERNS.some((re) => re.test(literal));

    it('every *Suite.ts file uses only allowlisted skippedReason literals', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const dir = path.dirname(new URL(import.meta.url).pathname);
        const files = (await fs.readdir(dir)).filter((f) => f.endsWith('Suite.ts'));
        expect(files.length).toBeGreaterThan(0);

        const offenders: { readonly file: string; readonly literal: string }[] = [];
        for (const file of files) {
            const src = await fs.readFile(path.join(dir, file), 'utf8');
            // Match any skippedReason: 'literal' or "literal" at any
            // indent. The non-greedy body lets us catch multi-line
            // template-literal-style skip reasons too.
            const matches = src.matchAll(/skippedReason:\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g);
            for (const m of matches) {
                const literal = m[1] ?? m[2] ?? m[3] ?? '';
                if (literal.length === 0) continue;
                if (!isAllowed(literal)) {
                    offenders.push({ file, literal });
                }
            }
        }

        if (offenders.length > 0) {
            const detail = offenders
                .map((o) => `  - ${o.file}: ${JSON.stringify(o.literal)}`)
                .join('\n');
            throw new Error(
                `unflagged runExperiment skips found — every suite must run against the real model unless flagged otherwise.\n${detail}\n\nAdd the new skip pattern to ALLOWED_SKIP_PATTERNS in suites.test.ts (and document the tracking ticket) if the skip is intentional.`,
            );
        }
    });
});
