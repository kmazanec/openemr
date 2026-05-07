/**
 * F.5a `POST /v1/agent/accept_fact` route tests.
 *
 * The middleman shape:
 *   panel → /v1/agent/accept_fact (this route)
 *   route → store.findArtifactById   — read the structured fact data
 *   route → promoteClient.promote(...) — POST to OpenEMR's promote.php
 *   route → store.recordDisposition('accepted')
 *   route → return chart_record_uuid + observation_uuids to panel
 *
 * Assertions cover the lab happy path, the type-not-yet-implemented
 * branches (the four non-lab types stay 501 until F.5b–F.5e land),
 * the artifact-not-found branch, schema-shape errors, the
 * promote.php-fails branches (HTTP / network / malformed), and the
 * disposition-fails-after-chart-write branch (chart row already
 * persisted; the panel receives the chart UUID with a warning flag).
 */

import type { KeyLike } from 'jose';
import { describe, expect, it } from 'vitest';

import type {
    ExtractionArtifact,
    ExtractionArtifactStore,
    FactDisposition,
    RecordDispositionInput,
    RecordDispositionResult,
} from '../../src/state/extractionArtifacts.js';
import {
    PromoteHttpError,
    PromoteMalformedResponseError,
    PromoteNetworkError,
    type OpenEmrPromoteClient,
    type PromoteCallInput,
    type PromoteResult,
} from '../../src/storage/openemrPromoteClient.js';
import { mintTestToken } from '../auth/testKeys.js';

import { TEST_AUDIENCE, TEST_ISSUER, buildAuthedApp } from './buildAuthedApp.js';

const baseLabArtifact = (overrides: Partial<ExtractionArtifact> = {}): ExtractionArtifact => ({
    artifactId: 'artifact-1',
    documentUuid: 'doc-uuid-1',
    pid: 4242,
    docType: 'lab_pdf',
    extractorVersion: 'v1.0.0',
    schemaJson: {
        results: [
            {
                analyte_name: 'Hemoglobin A1c',
                value: '5.7',
                unit: '%',
                ref_range_low: '4.0',
                ref_range_high: '5.6',
                abnormal_flag: 'high',
                collection_date: '2026-04-15',
                panel_code: '57021-8',
                page: 1,
                bbox: [40, 200, 380, 220],
                quote: 'HbA1c 5.7 %',
                confidence: 0.94,
            },
        ],
    },
    deltasJson: null,
    confidenceSignal: null,
    status: 'pending_confirmation',
    documentHash: 'hash',
    createdAt: '2026-05-04T12:00:00.000Z',
    confirmedAt: null,
    confirmedByUser: null,
    ...overrides,
});

const baseDisposition = (overrides: Partial<FactDisposition> = {}): FactDisposition => ({
    artifactId: 'artifact-1',
    fieldPath: 'results.0',
    status: 'accepted',
    acceptedAt: '2026-05-07T12:00:00.000Z',
    acceptedByUser: 'Practitioner/dr-patel',
    ...overrides,
});

const basePromoteResult: PromoteResult = {
    chartRecordUuid: 'chart-uuid-1',
    chartRecordType: 'diagnostic_report',
    observationUuids: ['obs-1', 'obs-2'],
    idempotentHit: false,
};

interface RecordingDeps {
    readonly store: Pick<ExtractionArtifactStore, 'findArtifactById' | 'recordDisposition'>;
    readonly promoteClient: OpenEmrPromoteClient;
    readonly findCalls: { artifactId: string }[];
    readonly promoteCalls: PromoteCallInput[];
    readonly dispositionCalls: RecordDispositionInput[];
}

interface RecordingDepsOptions {
    readonly artifact?: ExtractionArtifact | null;
    readonly promoteResponse?: PromoteResult | (() => never);
    readonly dispositionResponse?: RecordDispositionResult | (() => never);
}

const makeDeps = (options: RecordingDepsOptions = {}): RecordingDeps => {
    const findCalls: { artifactId: string }[] = [];
    const promoteCalls: PromoteCallInput[] = [];
    const dispositionCalls: RecordDispositionInput[] = [];
    const artifact = options.artifact === undefined ? baseLabArtifact() : options.artifact;
    const promoteResponse = options.promoteResponse ?? basePromoteResult;
    const dispositionResponse = options.dispositionResponse ?? {
        disposition: baseDisposition(),
        artifactStatusRolledTo: null,
    };
    return {
        findCalls,
        promoteCalls,
        dispositionCalls,
        store: {
            findArtifactById: (artifactId): Promise<ExtractionArtifact | null> => {
                findCalls.push({ artifactId });
                return Promise.resolve(artifact);
            },
            recordDisposition: (
                input: RecordDispositionInput,
            ): Promise<RecordDispositionResult> => {
                dispositionCalls.push(input);
                if (typeof dispositionResponse === 'function') {
                    dispositionResponse();
                    throw new Error('unreachable');
                }
                return Promise.resolve(dispositionResponse);
            },
        },
        promoteClient: {
            promote: (input: PromoteCallInput): Promise<PromoteResult> => {
                promoteCalls.push(input);
                if (typeof promoteResponse === 'function') {
                    promoteResponse();
                    throw new Error('unreachable');
                }
                return Promise.resolve(promoteResponse);
            },
        },
    };
};

const issueToken = (privateKey: KeyLike): Promise<string> =>
    mintTestToken(privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject: 'Practitioner/dr-patel',
        scopes: ['user/DiagnosticReport.cs'],
    });

describe('POST /v1/agent/accept_fact — auth + dep wiring', () => {
    it('rejects requests without a bearer token', async () => {
        const deps = makeDeps();
        const { app } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ artifactId: 'a', fieldPath: 'b', factType: 'lab' }),
        });
        expect(res.status).toBe(401);
    });

    it('returns 503 when the artifact store is not wired', async () => {
        const deps = makeDeps();
        const { app, privateKey } = await buildAuthedApp({
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ artifactId: 'a', fieldPath: 'b', factType: 'lab' }),
        });
        expect(res.status).toBe(503);
    });

    it('returns 503 when the promote client is not wired', async () => {
        const deps = makeDeps();
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ artifactId: 'a', fieldPath: 'b', factType: 'lab' }),
        });
        expect(res.status).toBe(503);
    });
});

describe('POST /v1/agent/accept_fact — envelope validation', () => {
    it.each([
        { name: 'missing artifactId', body: { fieldPath: 'a', factType: 'lab' } },
        { name: 'missing fieldPath', body: { artifactId: 'a', factType: 'lab' } },
        { name: 'missing factType', body: { artifactId: 'a', fieldPath: 'a' } },
        {
            name: 'unknown factType',
            body: { artifactId: 'a', fieldPath: 'a', factType: 'mystery' },
        },
    ])('rejects $name with 400 invalid_body', async ({ body }) => {
        const deps = makeDeps();
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_body' });
        expect(deps.findCalls).toHaveLength(0);
    });
});

describe('POST /v1/agent/accept_fact — happy path (lab)', () => {
    it('reads artifact, posts promote.php, records accepted disposition, returns chart record', async () => {
        const deps = makeDeps();
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
                conversationId: 'conv-1',
            }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            chartRecordUuid: 'chart-uuid-1',
            chartRecordType: 'diagnostic_report',
            observationUuids: ['obs-1', 'obs-2'],
            idempotentHit: false,
            dispositionRolledTo: null,
        });

        // Read happened with the right id.
        expect(deps.findCalls).toEqual([{ artifactId: 'artifact-1' }]);

        // Promote.php was called with the materialized lab body.
        expect(deps.promoteCalls).toHaveLength(1);
        const promoteCall = deps.promoteCalls[0]!;
        expect(promoteCall.type).toBe('lab');
        expect(promoteCall.token).toBe(token);
        expect(promoteCall.conversationId).toBe('conv-1');
        expect(promoteCall.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-1',
            panel_code: '57021-8',
            collection_date: '2026-04-15',
            results: [
                {
                    analyte_name: 'Hemoglobin A1c',
                    value: '5.7',
                    unit: '%',
                    ref_range_low: '4.0',
                    ref_range_high: '5.6',
                    abnormal_flag: 'high',
                },
            ],
        });

        // Disposition recorded as accepted, with the JWT subject as userId.
        expect(deps.dispositionCalls).toHaveLength(1);
        expect(deps.dispositionCalls[0]).toMatchObject({
            artifactId: 'artifact-1',
            fieldPath: 'results.0',
            status: 'accepted',
            userId: 'Practitioner/dr-patel',
        });
    });

    it('forwards idempotent_hit=true through to the panel', async () => {
        const deps = makeDeps({
            promoteResponse: {
                ...basePromoteResult,
                idempotentHit: true,
            },
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        const json = (await res.json()) as { idempotentHit: boolean };
        expect(json.idempotentHit).toBe(true);
    });
});

describe('POST /v1/agent/accept_fact — non-lab fact types stay 501 (until F.5b–F.5e)', () => {
    it.each([
        ['allergy'],
        ['medication_statement'],
        ['past_medical_history'],
        ['family_history'],
    ])('returns 501 not_yet_implemented for factType=%s', async (factType) => {
        const deps = makeDeps();
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ artifactId: 'artifact-1', fieldPath: 'a', factType }),
        });
        expect(res.status).toBe(501);
        expect(await res.json()).toEqual({ error: 'not_yet_implemented' });
        // Does not call promote.php or recordDisposition for unimplemented types.
        expect(deps.promoteCalls).toHaveLength(0);
        expect(deps.dispositionCalls).toHaveLength(0);
    });
});

describe('POST /v1/agent/accept_fact — artifact + materialization errors', () => {
    it('returns 404 artifact_not_found when the store has no such id', async () => {
        const deps = makeDeps({ artifact: null });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'missing',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'artifact_not_found' });
        expect(deps.promoteCalls).toHaveLength(0);
    });

    it('returns 400 fact_type_mismatch when factType=lab but artifact is intake_form', async () => {
        const deps = makeDeps({
            artifact: baseLabArtifact({ docType: 'intake_form' }),
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'fact_type_mismatch' });
    });

    it('returns 400 unsupported_field_path for a fieldPath outside results[]', async () => {
        const deps = makeDeps();
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'patient_demographics.name',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'unsupported_field_path' });
    });

    it('returns 400 schema_invalid when the artifact has an empty results array', async () => {
        const deps = makeDeps({
            artifact: baseLabArtifact({ schemaJson: { results: [] } }),
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'schema_invalid' });
    });
});

describe('POST /v1/agent/accept_fact — promote.php failure paths', () => {
    it('forwards 501 from promote.php to the panel', async () => {
        const deps = makeDeps({
            promoteResponse: () => {
                throw new PromoteHttpError(501, 'not_yet_implemented', '');
            },
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(501);
        expect(await res.json()).toEqual({ error: 'not_yet_implemented' });
        expect(deps.dispositionCalls).toHaveLength(0);
    });

    it('returns 502 promote_failed for non-501 promote errors', async () => {
        const deps = makeDeps({
            promoteResponse: () => {
                throw new PromoteHttpError(503, 'write_unavailable', '');
            },
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(502);
        const json = (await res.json()) as { error: string };
        expect(json.error).toBe('promote_failed');
        expect(deps.dispositionCalls).toHaveLength(0);
    });

    it('returns 502 promote_unreachable on PromoteNetworkError', async () => {
        const deps = makeDeps({
            promoteResponse: () => {
                throw new PromoteNetworkError('connect failed');
            },
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'promote_unreachable' });
    });

    it('returns 502 promote_malformed on PromoteMalformedResponseError', async () => {
        const deps = makeDeps({
            promoteResponse: () => {
                throw new PromoteMalformedResponseError('garbage');
            },
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'promote_malformed' });
    });
});

describe('POST /v1/agent/accept_fact — disposition write fails after chart row persisted', () => {
    it('returns 200 with dispositionWriteFailed=true so the panel sees the chart UUID', async () => {
        const deps = makeDeps({
            dispositionResponse: () => {
                throw new Error('disposition store down');
            },
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
            chartRecordUuid: string;
            dispositionRolledTo: unknown;
            dispositionWriteFailed: boolean;
        };
        expect(json.chartRecordUuid).toBe('chart-uuid-1');
        expect(json.dispositionRolledTo).toBeNull();
        expect(json.dispositionWriteFailed).toBe(true);
    });
});
