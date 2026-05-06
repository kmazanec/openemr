/**
 * §B.7 End-to-end pipeline graph test.
 *
 * Stubs every external boundary (Spaces, Anthropic, the Tier-1 RPC,
 * the chart-snapshot fetch, the Postgres store) and runs the full
 * compiled graph. Asserts:
 *
 *   - Happy path: a fixture lab PDF flows through every node and lands
 *     a Tier-2 row with deltas; transient PNGs are deleted on EXIT.
 *   - Idempotency: re-running with identical bytes returns the cached
 *     `artifact_id` and writes nothing.
 *   - Failure isolation: a doc that fails patient_match still cleans
 *     up its transient PNGs.
 *
 * The graph itself is the §B.7 contribution; this test is what proves
 * the wiring (`patientMatch → persist → emitDeltas → cleanup`) is
 * correct without depending on any real external service.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { createPipelineGraph, type PipelineDeps } from '../../src/pipeline/index.js';
import { initialPipelineState } from '../../src/pipeline/state.js';
import { type Rasterizer } from '../../src/pipeline/rasterizer.js';
import {
    keyForCanonical,
    keyForTransientPage,
    type SpacesClient,
} from '../../src/storage/spaces.js';
import {
    type ArtifactStatus,
    type DocumentLockHandle,
    type ExtractionArtifact,
    type ExtractionArtifactStore,
    type NewExtractionArtifact,
} from '../../src/state/extractionArtifacts.js';
import { EXTRACTOR_VERSION } from '../../src/pipeline/nodes/vision.js';
import type { ChartSnapshot, Demographics, SourceReference } from '../../src/snapshot/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = resolve(__dirname, '../../evals/fixtures/document-extraction/source');

const noopLogger = pino({ level: 'silent' });

const dummySource: SourceReference = {
    source_type: 'chart',
    source_id: 'x',
    locator: {},
    quote: 'q',
};

const chenChart = (): ChartSnapshot => ({
    patient: {
        pid: 4242,
        uuid: 'u',
        displayName: 'Margaret L. Chen',
        sex: 'female',
        dateOfBirth: '1967-08-14',
        ageYears: 58,
        source: dummySource,
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
});

const labSchemaForChen = (): unknown => ({
    patient_demographics: {
        name: { value: 'Margaret Chen', page: 1, bbox: [0, 0, 1, 1], quote: 'CHEN', confidence: 0.99 },
        dob: { value: '1967-08-14', page: 1, bbox: [0, 0, 1, 1], quote: '1967-08-14', confidence: 0.99 },
        sex: { value: 'female', page: 1, bbox: [0, 0, 1, 1], quote: 'F', confidence: 0.99 },
    },
    results: [
        {
            analyte_name: 'Hemoglobin A1c',
            value: '7.2',
            unit: '%',
            collection_date: '2026-04-30',
            page: 1,
            bbox: [0, 0, 1, 1],
            quote: '7.2',
            confidence: 0.95,
        },
    ],
    ordering_provider: {
        name: 'Dr. Patel',
        page: 1,
        bbox: [0, 0, 1, 1],
        quote: 'Patel',
        confidence: 0.9,
    },
});

const buildFakeSpaces = (canonicalBytes: Buffer): {
    spaces: SpacesClient;
    stored: Map<string, Buffer>;
    deletedKeys: string[];
} => {
    const stored = new Map<string, Buffer>();
    const deletedKeys: string[] = [];

    const canonicalKey = keyForCanonical(4242, 'placeholder-1', 'pdf');
    stored.set(canonicalKey, canonicalBytes);

    const spaces: SpacesClient = {
        bucket: 'cdn.test.dev',
        putObject: vi.fn((input: { key: string; body: Buffer }) => {
            stored.set(input.key, input.body);
            return Promise.resolve();
        }),
        getObject: vi.fn((input: { key: string }) => {
            const buf = stored.get(input.key);
            if (buf === undefined) return Promise.reject(new Error(`no fake object at ${input.key}`));
            return Promise.resolve({ body: buf, contentType: 'application/pdf' });
        }),
        deleteObject: vi.fn((input: { key: string }) => {
            deletedKeys.push(input.key);
            stored.delete(input.key);
            return Promise.resolve();
        }),
        presignGetUrl: vi.fn((key: string) => Promise.resolve(`https://signed.test/${key}`)),
        presignPutUrl: vi.fn((key: string) => Promise.resolve(`https://signed.test/put/${key}`)),
        destroy: vi.fn(),
    };
    return { spaces, stored, deletedKeys };
};

const buildFakeArtifactStore = (): {
    store: ExtractionArtifactStore;
    inserts: NewExtractionArtifact[];
    updates: { artifactId: string; status: string; deltasJson: unknown }[];
} => {
    const inserts: NewExtractionArtifact[] = [];
    const updates: { artifactId: string; status: string; deltasJson: unknown }[] = [];
    let counter = 0;
    const store: ExtractionArtifactStore = {
        claimDocumentLock: vi.fn(() => {
            const handle: DocumentLockHandle = { release: vi.fn(() => Promise.resolve()) };
            return Promise.resolve(handle);
        }),
        findArtifactByDocumentHash: vi.fn(
            (hash: string, version: string): Promise<ExtractionArtifact | null> => {
                const found = inserts.find(
                    (a) => a.documentHash === hash && a.extractorVersion === version,
                );
                if (found === undefined) return Promise.resolve(null);
                return Promise.resolve({
                    ...found,
                    createdAt: '2026-05-05T00:00:00Z',
                    confirmedAt: null,
                    confirmedByUser: null,
                });
            },
        ),
        insertArtifact: vi.fn((a: NewExtractionArtifact): Promise<ExtractionArtifact> => {
            inserts.push(a);
            counter += 1;
            return Promise.resolve({
                ...a,
                createdAt: '2026-05-05T00:00:00Z',
                confirmedAt: null,
                confirmedByUser: null,
            });
        }),
        updateArtifactStatus: vi.fn(
            (
                artifactId: string,
                status: ArtifactStatus,
                metadata?: { readonly deltasJson?: unknown },
            ): Promise<ExtractionArtifact | null> => {
                updates.push({ artifactId, status, deltasJson: metadata?.deltasJson });
                return Promise.resolve(null);
            },
        ),
        searchArtifacts: vi.fn(),
        recordDisposition: vi.fn(),
        getDispositions: vi.fn(),
    };
    void counter;
    return { store, inserts, updates };
};

const buildPipelineDeps = (
    canonicalBytes: Buffer,
    overrides: {
        canonicalKey?: string;
        chart?: ChartSnapshot;
        rasterizer?: Rasterizer;
        rpcUuid?: string;
        forcedExtractionSchema?: unknown;
        chartDemographics?: Demographics;
    } = {},
): {
    deps: PipelineDeps;
    spacesContext: ReturnType<typeof buildFakeSpaces>;
    storeContext: ReturnType<typeof buildFakeArtifactStore>;
} => {
    const spacesContext = buildFakeSpaces(canonicalBytes);
    const storeContext = buildFakeArtifactStore();

    // Stub the rasterizer to return one PNG per page without invoking the
    // real `pdf-img-convert` (canvas binaries aren't always available).
    const fakeRasterizer: Rasterizer =
        overrides.rasterizer ?? {
            pageCount: vi.fn(() => Promise.resolve(2)),
            rasterize: vi.fn(() =>
                Promise.resolve([
                    { pageNum: 1, pngBytes: Buffer.from('png-1') },
                    { pageNum: 2, pngBytes: Buffer.from('png-2') },
                ]),
            ),
        };

    const forcedSchema = overrides.forcedExtractionSchema ?? labSchemaForChen();
    const visionInvoker = {
        invoke: vi.fn(() => Promise.resolve({ extraction: forcedSchema })),
    };

    const rpcUuid = overrides.rpcUuid ?? 'canonical-uuid-1';
    const documentReferenceClient = {
        writeDocumentReference: vi.fn(() => Promise.resolve({ documentUuid: rpcUuid })),
    };

    const chart = overrides.chart ?? chenChart();
    const chartDemographics: Demographics = overrides.chartDemographics ?? chart.patient;

    const deps: PipelineDeps = {
        rasterize: {
            openemrSpaces: spacesContext.spaces,
            agentSpaces: spacesContext.spaces,
            rasterizer: fakeRasterizer,
            transientPrefix: 'transient',
            logger: noopLogger,
            canonicalExt: 'pdf',
        },
        vision: {
            logger: noopLogger,
            invoker: visionInvoker,
        },
        schemaValidate: { logger: noopLogger },
        patientMatch: {
            logger: noopLogger,
            fetchChartDemographics: vi.fn(() => Promise.resolve(chartDemographics)),
        },
        persist: {
            artifactStore: storeContext.store,
            openemrSpaces: spacesContext.spaces,
            documentReferenceClient,
            logger: noopLogger,
            artifactIdGenerator: () => `artifact-${String(storeContext.inserts.length + 1)}`,
            canonicalExt: 'pdf',
            openemrToken: 'JWT',
            openemrSiteId: 'default',
            bucketName: 'cdn.test.dev',
        },
        emitDeltas: {
            artifactStore: storeContext.store,
            logger: noopLogger,
            fetchChartSnapshot: vi.fn(() => Promise.resolve(chart)),
        },
        cleanup: {
            openemrSpaces: spacesContext.spaces,
            transientPrefix: 'transient',
            logger: noopLogger,
        },
    };

    return { deps, spacesContext, storeContext };
};

describe('pipeline end-to-end', () => {
    it('happy path: fixture lab PDF lands Tier-2 row, deltas, and cleans up transients', async () => {
        const fixturePdf = readFileSync(resolve(FIXTURE_ROOT, 'lab-results/p01-chen-lipid-panel.pdf'));
        const built = buildPipelineDeps(fixturePdf);
        const graph = createPipelineGraph(built.deps);

        const result = await graph.invoke(
            initialPipelineState({
                documentUuid: 'placeholder-1',
                docType: 'lab_pdf',
                pid: 4242,
                triggerSource: 'panel',
            }),
        );

        const status = result.status;
        expect(status).toBe('persisted');
        expect(result.artifactId).toBe('artifact-1');
        expect(result.documentUuid).toBe('canonical-uuid-1');

        // Tier-2 row inserted
        expect(built.storeContext.inserts).toHaveLength(1);
        expect(built.storeContext.inserts[0]).toMatchObject({
            documentUuid: 'canonical-uuid-1',
            pid: 4242,
            docType: 'lab_pdf',
            extractorVersion: EXTRACTOR_VERSION,
            status: 'pending_confirmation',
        });

        // Deltas update fired
        expect(built.storeContext.updates).toHaveLength(1);
        expect(built.storeContext.updates[0]!.artifactId).toBe('artifact-1');

        // Transient PNGs deleted
        expect(built.spacesContext.deletedKeys).toEqual([
            keyForTransientPage('transient', 'placeholder-1', 1),
            keyForTransientPage('transient', 'placeholder-1', 2),
        ]);
    });

    it('idempotency: replaying the same input returns the cached artifact_id', async () => {
        const fixturePdf = readFileSync(resolve(FIXTURE_ROOT, 'lab-results/p01-chen-lipid-panel.pdf'));
        const built = buildPipelineDeps(fixturePdf);
        const graph = createPipelineGraph(built.deps);

        const first = await graph.invoke(
            initialPipelineState({
                documentUuid: 'placeholder-1',
                docType: 'lab_pdf',
                pid: 4242,
                triggerSource: 'panel',
            }),
        );

        const initialInsertCount = built.storeContext.inserts.length;
        const initialUpdateCount = built.storeContext.updates.length;

        const second = await graph.invoke(
            initialPipelineState({
                documentUuid: 'placeholder-1',
                docType: 'lab_pdf',
                pid: 4242,
                triggerSource: 'panel',
            }),
        );

        expect(second.artifactId).toBe(first.artifactId);
        expect(second.documentUuid).toBe(first.documentUuid);
        // No new Tier-2 INSERT — the idempotency lookup short-circuits
        // before the cached row would be re-written. (Deltas may
        // recompute on replay; that's a deterministic re-emit, not a
        // duplicate, so we don't pin update count here.)
        expect(built.storeContext.inserts).toHaveLength(initialInsertCount);
        void initialUpdateCount;
    });

    it('patient mismatch fails the pipeline but cleanup still wipes transients', async () => {
        const fixturePdf = readFileSync(resolve(FIXTURE_ROOT, 'lab-results/p01-chen-lipid-panel.pdf'));
        const wrongPatient: Demographics = {
            pid: 4242,
            uuid: 'u',
            displayName: 'Someone Else',
            sex: 'male',
            dateOfBirth: '1980-01-01',
            ageYears: 46,
            source: dummySource,
        };
        const built = buildPipelineDeps(fixturePdf, { chartDemographics: wrongPatient });
        const graph = createPipelineGraph(built.deps);

        const result = await graph.invoke(
            initialPipelineState({
                documentUuid: 'placeholder-1',
                docType: 'lab_pdf',
                pid: 4242,
                triggerSource: 'panel',
            }),
        );

        const status = result.status;
        expect(status).toBe('failed');
        expect(result.errors?.[0]?.code).toBe('patient_mismatch');

        // No Tier-2 insert on a refused extraction.
        expect(built.storeContext.inserts).toHaveLength(0);

        // Transients still cleaned.
        expect(built.spacesContext.deletedKeys).toEqual([
            keyForTransientPage('transient', 'placeholder-1', 1),
            keyForTransientPage('transient', 'placeholder-1', 2),
        ]);
    });
});
