/**
 * §B.7 persist node tests.
 *
 * Validates the Tier-1 + Tier-2 atomic write contract:
 *   - Happy path: hashes bytes, calls Tier-1 RPC, inserts Tier-2 row,
 *     returns canonical artifact_id.
 *   - Idempotency: a repeat invocation with identical bytes returns
 *     the cached artifact_id without writing.
 *   - Race-safe re-check under lock: cache miss pre-lock, cache hit
 *     post-lock → returns the racing winner's artifact.
 *   - Failure isolation: upstream `failed`, schema null, Tier-1 RPC
 *     error class branches.
 */

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { persist, type PersistDeps } from '../../src/pipeline/nodes/persist.js';
import {
    initialPipelineState,
    type PipelineError,
    type PipelineState,
} from '../../src/pipeline/state.js';
import {
    DocumentReferenceHttpError,
    DocumentReferenceNetworkError,
    type OpenEmrDocumentReferenceClient,
} from '../../src/storage/openemrDocumentReferenceClient.js';
import { type SpacesClient } from '../../src/storage/spaces.js';
import {
    type DocumentLockHandle,
    type ExtractionArtifact,
    type ExtractionArtifactStore,
    type NewExtractionArtifact,
} from '../../src/state/extractionArtifacts.js';
import { EXTRACTOR_VERSION } from '../../src/pipeline/nodes/vision.js';

const noopLogger = pino({ level: 'silent' });

const labSchemaFixture = (): unknown => ({
    patient_demographics: {
        name: { value: 'Margaret Chen', page: 1, bbox: [0, 0, 10, 10], quote: 'CHEN', confidence: 0.99 },
        dob: { value: '1967-08-14', page: 1, bbox: [0, 10, 10, 20], quote: '1967-08-14', confidence: 0.99 },
        sex: { value: 'female', page: 1, bbox: [0, 20, 10, 30], quote: 'F', confidence: 0.99 },
    },
    results: [
        {
            analyte_name: 'Hemoglobin A1c',
            value: '7.2',
            unit: '%',
            collection_date: '2026-04-30',
            page: 1,
            bbox: [0, 30, 10, 40],
            quote: '7.2',
            confidence: 0.95,
        },
    ],
    ordering_provider: {
        name: 'Dr. Patel',
        page: 1,
        bbox: [0, 40, 10, 50],
        quote: 'Patel',
        confidence: 0.9,
    },
});

const stubSpaces = (canonical: Buffer): SpacesClient => ({
    bucket: 'cdn.test.dev',
    putObject: vi.fn(),
    getObject: vi.fn(() => Promise.resolve({ body: canonical, contentType: 'application/pdf' })),
    deleteObject: vi.fn(),
    presignGetUrl: vi.fn(),
    presignPutUrl: vi.fn(),
    destroy: vi.fn(),
});

const stubArtifactStore = (
    overrides: Partial<ExtractionArtifactStore> = {},
): { store: ExtractionArtifactStore; calls: { findCalls: number; insertCalls: NewExtractionArtifact[]; lockCalls: number; lockReleases: number } } => {
    const calls = { findCalls: 0, insertCalls: [] as NewExtractionArtifact[], lockCalls: 0, lockReleases: 0 };
    const baseStore: ExtractionArtifactStore = {
        claimDocumentLock: vi.fn(() => {
            calls.lockCalls += 1;
            const handle: DocumentLockHandle = {
                release: vi.fn(() => {
                    calls.lockReleases += 1;
                    return Promise.resolve();
                }),
            };
            return Promise.resolve(handle);
        }),
        findArtifactByDocumentHash: vi.fn(() => {
            calls.findCalls += 1;
            return Promise.resolve(null);
        }),
        findArtifactById: vi.fn(() => Promise.resolve(null)),
        insertArtifact: vi.fn((a: NewExtractionArtifact) => {
            calls.insertCalls.push(a);
            return Promise.resolve(toExtractionArtifact(a));
        }),
        updateArtifactStatus: vi.fn(),
        searchArtifacts: vi.fn(),
        recordDisposition: vi.fn(),
        getDispositions: vi.fn(),
    };
    return { store: { ...baseStore, ...overrides }, calls };
};

const toExtractionArtifact = (a: NewExtractionArtifact): ExtractionArtifact => ({
    artifactId: a.artifactId,
    documentUuid: a.documentUuid,
    pid: a.pid,
    docType: a.docType,
    extractorVersion: a.extractorVersion,
    schemaJson: a.schemaJson,
    deltasJson: a.deltasJson,
    confidenceSignal: a.confidenceSignal,
    status: a.status,
    documentHash: a.documentHash,
    createdAt: '2026-05-05T00:00:00Z',
    confirmedAt: null,
    confirmedByUser: null,
});

const stubRpc = (uuid: string): OpenEmrDocumentReferenceClient => ({
    writeDocumentReference: vi.fn(() => Promise.resolve({ documentUuid: uuid })),
});

const buildDeps = (
    overrides: Partial<PersistDeps> = {},
): PersistDeps => {
    const canonical = Buffer.from('canonical pdf bytes');
    const { store } = stubArtifactStore();
    return {
        artifactStore: store,
        openemrSpaces: stubSpaces(canonical),
        documentReferenceClient: stubRpc('canonical-uuid-1'),
        logger: noopLogger,
        artifactIdGenerator: () => 'artifact-1',
        canonicalExt: 'pdf',
        openemrToken: 'JWT',
        openemrSiteId: 'default',
        ...overrides,
    };
};

const buildPostMatchState = (overrides: Partial<PipelineState> = {}): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'placeholder-1',
        docType: 'lab_pdf',
        pid: 4242,
        triggerSource: 'panel',
    }),
    schema: labSchemaFixture(),
    status: 'matched',
    confidenceSignal: {
        patientMatchScore: 1.0,
        patientMatchPartial: false,
        demographicsWarnings: [],
    },
    ...overrides,
});

const requireError = (
    out: Partial<PipelineState>,
): PipelineError => {
    const errs = out.errors;
    expect(errs).toBeDefined();
    expect(errs!.length).toBeGreaterThan(0);
    return errs![errs!.length - 1]!;
};

describe('persist node', () => {
    it('happy path writes Tier 1 + Tier 2 and returns canonical artifact_id', async () => {
        const canonical = Buffer.from('canonical pdf bytes');
        const spaces = stubSpaces(canonical);
        const { store, calls } = stubArtifactStore();
        const rpc = stubRpc('canonical-uuid-1');

        const out = await persist(
            buildPostMatchState(),
            buildDeps({
                openemrSpaces: spaces,
                artifactStore: store,
                documentReferenceClient: rpc,
            }),
        );

        expect(out.status).toBe('persisted');
        expect(out.artifactId).toBe('artifact-1');
        expect(out.documentUuid).toBe('canonical-uuid-1');
        expect(calls.findCalls).toBe(2); // pre-lock + under-lock
        expect(calls.lockCalls).toBe(1);
        expect(calls.lockReleases).toBe(1);
        expect(calls.insertCalls).toHaveLength(1);
        expect(calls.insertCalls[0]).toMatchObject({
            artifactId: 'artifact-1',
            documentUuid: 'canonical-uuid-1',
            pid: 4242,
            docType: 'lab_pdf',
            extractorVersion: EXTRACTOR_VERSION,
            status: 'pending_confirmation',
            deltasJson: null,
        });
        // SHA-256 hash of "canonical pdf bytes"
        expect(calls.insertCalls[0]!.documentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('idempotency: cache hit pre-lock returns cached artifact without writing', async () => {
        const canonical = Buffer.from('canonical pdf bytes');
        const cached: ExtractionArtifact = toExtractionArtifact({
            artifactId: 'cached-artifact',
            documentUuid: 'cached-uuid',
            pid: 4242,
            docType: 'lab_pdf',
            extractorVersion: EXTRACTOR_VERSION,
            schemaJson: {},
            deltasJson: null,
            confidenceSignal: null,
            status: 'pending_confirmation',
            documentHash: 'whatever',
        });
        const { store, calls } = stubArtifactStore({
            findArtifactByDocumentHash: vi.fn(() => Promise.resolve(cached)),
        });
        const rpc = stubRpc('should-not-be-called');

        const out = await persist(
            buildPostMatchState(),
            buildDeps({
                openemrSpaces: stubSpaces(canonical),
                artifactStore: store,
                documentReferenceClient: rpc,
            }),
        );

        expect(out.artifactId).toBe('cached-artifact');
        expect(out.documentUuid).toBe('cached-uuid');
        expect(out.status).toBe('persisted');
        expect(calls.lockCalls).toBe(0);
        expect(rpc.writeDocumentReference).not.toHaveBeenCalled();
    });

    it('race-safe under-lock re-check returns the racing winner', async () => {
        const canonical = Buffer.from('canonical pdf bytes');
        const racingWinner: ExtractionArtifact = toExtractionArtifact({
            artifactId: 'racing-winner',
            documentUuid: 'racing-uuid',
            pid: 4242,
            docType: 'lab_pdf',
            extractorVersion: EXTRACTOR_VERSION,
            schemaJson: {},
            deltasJson: null,
            confidenceSignal: null,
            status: 'pending_confirmation',
            documentHash: 'whatever',
        });
        let calls = 0;
        const findFn = vi.fn(() => {
            calls += 1;
            return Promise.resolve(calls === 1 ? null : racingWinner);
        });
        const { store, calls: storeCalls } = stubArtifactStore({
            findArtifactByDocumentHash: findFn,
        });
        const rpc = stubRpc('should-not-be-called');

        const out = await persist(
            buildPostMatchState(),
            buildDeps({
                openemrSpaces: stubSpaces(canonical),
                artifactStore: store,
                documentReferenceClient: rpc,
            }),
        );

        expect(out.artifactId).toBe('racing-winner');
        expect(out.documentUuid).toBe('racing-uuid');
        expect(storeCalls.lockCalls).toBe(1);
        expect(storeCalls.lockReleases).toBe(1);
        expect(storeCalls.insertCalls).toHaveLength(0);
        expect(rpc.writeDocumentReference).not.toHaveBeenCalled();
    });

    it('upstream failed short-circuits without I/O', async () => {
        const canonical = Buffer.from('x');
        const spaces = stubSpaces(canonical);
        const { store, calls } = stubArtifactStore();
        const rpc = stubRpc('x');

        const out = await persist(
            buildPostMatchState({ status: 'failed' }),
            buildDeps({ openemrSpaces: spaces, artifactStore: store, documentReferenceClient: rpc }),
        );

        expect(out).toEqual({});
        expect(spaces.getObject).not.toHaveBeenCalled();
        expect(calls.findCalls).toBe(0);
        expect(calls.lockCalls).toBe(0);
    });

    it('null schema with non-failed upstream is a structural failure', async () => {
        const out = await persist(
            buildPostMatchState({ schema: null }),
            buildDeps(),
        );
        expect(out.status).toBe('failed');
        const err = requireError(out);
        expect(err.code).toBe('persist_failed');
        expect(err.message).toContain('schema is null');
    });

    it('Tier-1 HTTP error → persist_failed', async () => {
        const canonical = Buffer.from('canonical pdf bytes');
        const rpc: OpenEmrDocumentReferenceClient = {
            writeDocumentReference: vi.fn(() =>
                Promise.reject(new DocumentReferenceHttpError(403, '{"error":"scope_not_permitted"}')),
            ),
        };
        const out = await persist(
            buildPostMatchState(),
            buildDeps({ openemrSpaces: stubSpaces(canonical), documentReferenceClient: rpc }),
        );
        expect(out.status).toBe('failed');
        const err = requireError(out);
        expect(err.code).toBe('persist_failed');
        expect(err.message).toContain('HTTP 403');
    });

    it('Tier-1 network error → storage-unreachable', async () => {
        const canonical = Buffer.from('canonical pdf bytes');
        const rpc: OpenEmrDocumentReferenceClient = {
            writeDocumentReference: vi.fn(() =>
                Promise.reject(new DocumentReferenceNetworkError('boom')),
            ),
        };
        const out = await persist(
            buildPostMatchState(),
            buildDeps({ openemrSpaces: stubSpaces(canonical), documentReferenceClient: rpc }),
        );
        expect(out.status).toBe('failed');
        const err = requireError(out);
        expect(err.code).toBe('storage-unreachable');
    });

    it('canonical bytes fetch error → storage-unreachable', async () => {
        const spaces: SpacesClient = {
            ...stubSpaces(Buffer.from('')),
            getObject: vi.fn(() => Promise.reject(new Error('S3 down'))),
        };
        const out = await persist(buildPostMatchState(), buildDeps({ openemrSpaces: spaces }));
        expect(out.status).toBe('failed');
        const err = requireError(out);
        expect(err.code).toBe('storage-unreachable');
    });

    it('Tier-2 insert failure → persist_failed and lock released', async () => {
        const canonical = Buffer.from('canonical pdf bytes');
        const { store, calls } = stubArtifactStore({
            insertArtifact: vi.fn(() => Promise.reject(new Error('UNIQUE violation'))),
        });
        const out = await persist(
            buildPostMatchState(),
            buildDeps({
                openemrSpaces: stubSpaces(canonical),
                artifactStore: store,
            }),
        );
        expect(out.status).toBe('failed');
        const err = requireError(out);
        expect(err.code).toBe('persist_failed');
        expect(calls.lockReleases).toBe(1); // released even on failure
    });

    it('passes the placeholder uuid through to the confirm RPC', async () => {
        const canonical = Buffer.from('canonical pdf bytes');
        const rpc = stubRpc('canonical-uuid-1');
        await persist(
            buildPostMatchState({ pid: 7, documentUuid: 'placeholder-XYZ' }),
            buildDeps({
                openemrSpaces: stubSpaces(canonical),
                documentReferenceClient: rpc,
            }),
        );
        expect(rpc.writeDocumentReference).toHaveBeenCalledWith(
            expect.objectContaining({
                documentUuid: 'placeholder-XYZ',
                docType: 'lab_pdf',
                pid: 7,
                token: 'JWT',
                siteId: 'default',
            }),
        );
    });
});
