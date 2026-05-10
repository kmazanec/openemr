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
                bbox: [40, 200, 420, 200, 420, 420, 40, 420],
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

describe('POST /v1/agent/accept_fact — happy path (allergy)', () => {
    const baseAllergyArtifact = (
        overrides: Partial<ExtractionArtifact> = {},
    ): ExtractionArtifact => ({
        artifactId: 'artifact-allergy-1',
        documentUuid: 'doc-uuid-allergy',
        pid: 4242,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            allergies: [
                {
                    substance: 'penicillin',
                    reaction: 'rash',
                    severity: 'moderate',
                    page: 1,
                    bbox: [40, 200, 420, 200, 420, 420, 40, 420],
                    quote: 'penicillin — rash',
                    confidence: 0.92,
                },
            ],
            current_medications: [],
            past_medical_history: [],
            family_history: [],
            patient_demographics: {},
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

    it('reads intake_form artifact, posts allergy promote.php, records accepted disposition', async () => {
        const deps = makeDeps({
            artifact: baseAllergyArtifact(),
            promoteResponse: {
                chartRecordUuid: 'chart-allergy-1',
                chartRecordType: 'list_allergy',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-allergy-1',
                fieldPath: 'allergies.0',
                factType: 'allergy',
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            chartRecordUuid: string;
            chartRecordType: string;
            observationUuids: readonly string[];
        };
        expect(body.chartRecordUuid).toBe('chart-allergy-1');
        expect(body.chartRecordType).toBe('list_allergy');
        expect(body.observationUuids).toEqual([]);

        // Promote.php was called with the materialized allergy body.
        expect(deps.promoteCalls).toHaveLength(1);
        const promoteCall = deps.promoteCalls[0]!;
        expect(promoteCall.type).toBe('allergy');
        expect(promoteCall.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-allergy',
            substance: 'penicillin',
            reaction_option_id: 'rash',
            severity: 'moderate',
        });

        // Disposition recorded as accepted with the JWT subject.
        expect(deps.dispositionCalls).toHaveLength(1);
        expect(deps.dispositionCalls[0]).toMatchObject({
            artifactId: 'artifact-allergy-1',
            fieldPath: 'allergies.0',
            status: 'accepted',
            userId: 'Practitioner/dr-patel',
        });
    });

    it('omits optional fields from the body when the intake row lacks them', async () => {
        const minimal = baseAllergyArtifact({
            schemaJson: {
                allergies: [
                    {
                        substance: 'shellfish',
                        page: 2,
                        bbox: [10, 10, 110, 10, 110, 30, 10, 30],
                        quote: 'shellfish',
                        confidence: 0.85,
                    },
                ],
                current_medications: [],
                past_medical_history: [],
                family_history: [],
                patient_demographics: {},
            },
        });
        const deps = makeDeps({
            artifact: minimal,
            promoteResponse: {
                chartRecordUuid: 'chart-2',
                chartRecordType: 'list_allergy',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-allergy-1',
                fieldPath: 'allergies.0',
                factType: 'allergy',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-allergy',
            substance: 'shellfish',
        });
    });

    it('returns 400 fact_type_mismatch when factType=allergy but artifact is lab_pdf', async () => {
        const deps = makeDeps({
            artifact: baseAllergyArtifact({ docType: 'lab_pdf' }),
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
                artifactId: 'artifact-allergy-1',
                fieldPath: 'allergies.0',
                factType: 'allergy',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'fact_type_mismatch' });
    });

    it('returns 400 unsupported_field_path for a fieldPath outside allergies[]', async () => {
        const deps = makeDeps({ artifact: baseAllergyArtifact() });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-allergy-1',
                fieldPath: 'patient_demographics.name',
                factType: 'allergy',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'unsupported_field_path' });
    });
});

describe('POST /v1/agent/accept_fact — happy path (past_medical_history)', () => {
    const baseMedicalProblemArtifact = (
        overrides: Partial<ExtractionArtifact> = {},
    ): ExtractionArtifact => ({
        artifactId: 'artifact-pmh-1',
        documentUuid: 'doc-uuid-pmh',
        pid: 4242,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            allergies: [],
            current_medications: [],
            past_medical_history: [
                {
                    condition: 'Type 2 diabetes',
                    onset_year: '2014',
                    notes: 'patient-reported on intake form',
                    page: 1,
                    bbox: [40, 200, 420, 200, 420, 420, 40, 420],
                    quote: 'T2DM since 2014',
                    confidence: 0.9,
                },
            ],
            family_history: [],
            patient_demographics: {},
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

    it('reads intake_form artifact, posts past_medical_history promote.php, records accepted disposition', async () => {
        const deps = makeDeps({
            artifact: baseMedicalProblemArtifact(),
            promoteResponse: {
                chartRecordUuid: 'chart-pmh-1',
                chartRecordType: 'list_medical_problem',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-pmh-1',
                fieldPath: 'past_medical_history.0',
                factType: 'past_medical_history',
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            chartRecordUuid: string;
            chartRecordType: string;
            observationUuids: readonly string[];
        };
        expect(body.chartRecordUuid).toBe('chart-pmh-1');
        expect(body.chartRecordType).toBe('list_medical_problem');
        expect(body.observationUuids).toEqual([]);

        // Promote.php was called with the materialized medical-problem
        // body. `onset_year='2014'` normalized to `'2014-01-01'`.
        expect(deps.promoteCalls).toHaveLength(1);
        const promoteCall = deps.promoteCalls[0]!;
        expect(promoteCall.type).toBe('past_medical_history');
        expect(promoteCall.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-pmh',
            title: 'Type 2 diabetes',
            comments: 'patient-reported on intake form',
            onset_date: '2014-01-01',
        });

        // Disposition recorded as accepted with the JWT subject.
        expect(deps.dispositionCalls).toHaveLength(1);
        expect(deps.dispositionCalls[0]).toMatchObject({
            artifactId: 'artifact-pmh-1',
            fieldPath: 'past_medical_history.0',
            status: 'accepted',
            userId: 'Practitioner/dr-patel',
        });
    });

    it('omits optional fields (notes, onset_year) when the intake row lacks them', async () => {
        const minimal = baseMedicalProblemArtifact({
            schemaJson: {
                allergies: [],
                current_medications: [],
                past_medical_history: [
                    {
                        condition: 'Hypertension',
                        page: 2,
                        bbox: [10, 10, 110, 10, 110, 30, 10, 30],
                        quote: 'HTN',
                        confidence: 0.85,
                    },
                ],
                family_history: [],
                patient_demographics: {},
            },
        });
        const deps = makeDeps({
            artifact: minimal,
            promoteResponse: {
                chartRecordUuid: 'chart-pmh-2',
                chartRecordType: 'list_medical_problem',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-pmh-1',
                fieldPath: 'past_medical_history.0',
                factType: 'past_medical_history',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-pmh',
            title: 'Hypertension',
        });
    });

    it('returns 400 fact_type_mismatch when factType=past_medical_history but artifact is lab_pdf, and 400 unsupported_field_path for paths outside past_medical_history[]', async () => {
        // Two materialization-error sub-cases for past_medical_history
        // bundled in one vitest case (matches the F.5b allergy block's
        // pair-of-error-modes shape and keeps the new-cases count at
        // the F.5d checklist's stated three).

        // 1. fact_type_mismatch: artifact is lab_pdf.
        const mismatchDeps = makeDeps({
            artifact: baseMedicalProblemArtifact({ docType: 'lab_pdf' }),
        });
        const mismatchApp = await buildAuthedApp({
            extractionArtifactStore: mismatchDeps.store,
            promoteClient: mismatchDeps.promoteClient,
        });
        const mismatchToken = await issueToken(mismatchApp.privateKey);
        const mismatchRes = await mismatchApp.app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${mismatchToken}`,
            },
            body: JSON.stringify({
                artifactId: 'artifact-pmh-1',
                fieldPath: 'past_medical_history.0',
                factType: 'past_medical_history',
            }),
        });
        expect(mismatchRes.status).toBe(400);
        expect(await mismatchRes.json()).toEqual({ error: 'fact_type_mismatch' });

        // 2. unsupported_field_path: fieldPath points outside
        // past_medical_history[].
        const pathDeps = makeDeps({ artifact: baseMedicalProblemArtifact() });
        const pathApp = await buildAuthedApp({
            extractionArtifactStore: pathDeps.store,
            promoteClient: pathDeps.promoteClient,
        });
        const pathToken = await issueToken(pathApp.privateKey);
        const pathRes = await pathApp.app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${pathToken}`,
            },
            body: JSON.stringify({
                artifactId: 'artifact-pmh-1',
                fieldPath: 'patient_demographics.name',
                factType: 'past_medical_history',
            }),
        });
        expect(pathRes.status).toBe(400);
        expect(await pathRes.json()).toEqual({ error: 'unsupported_field_path' });
    });
});

describe('POST /v1/agent/accept_fact — happy path (medication_statement)', () => {
    const baseMedicationArtifact = (
        overrides: Partial<ExtractionArtifact> = {},
    ): ExtractionArtifact => ({
        artifactId: 'artifact-med-1',
        documentUuid: 'doc-uuid-med',
        pid: 4242,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            allergies: [],
            current_medications: [
                {
                    name: 'lisinopril 10mg',
                    dose: '10mg',
                    frequency: 'once daily',
                    route: 'PO',
                    notes: 'patient reports good adherence',
                    page: 1,
                    bbox: [40, 240, 420, 240, 420, 500, 40, 500],
                    quote: 'lisinopril 10mg once daily',
                    confidence: 0.93,
                },
            ],
            past_medical_history: [],
            family_history: [],
            patient_demographics: {},
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

    it('reads intake_form artifact, posts medication_statement promote.php, records accepted disposition', async () => {
        const deps = makeDeps({
            artifact: baseMedicationArtifact(),
            promoteResponse: {
                chartRecordUuid: 'chart-med-1',
                chartRecordType: 'list_medication_statement',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-med-1',
                fieldPath: 'current_medications.0',
                factType: 'medication_statement',
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            chartRecordUuid: string;
            chartRecordType: string;
            observationUuids: readonly string[];
        };
        expect(body.chartRecordUuid).toBe('chart-med-1');
        expect(body.chartRecordType).toBe('list_medication_statement');
        expect(body.observationUuids).toEqual([]);

        // Promote.php was called with the materialized medication body —
        // dose/frequency/route/notes composed into a single
        // free-text dosage_instructions string.
        expect(deps.promoteCalls).toHaveLength(1);
        const promoteCall = deps.promoteCalls[0]!;
        expect(promoteCall.type).toBe('medication_statement');
        expect(promoteCall.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-med',
            drug_name: 'lisinopril 10mg',
            dosage_instructions: '10mg once daily PO patient reports good adherence',
        });

        // Disposition recorded as accepted with the JWT subject.
        expect(deps.dispositionCalls).toHaveLength(1);
        expect(deps.dispositionCalls[0]).toMatchObject({
            artifactId: 'artifact-med-1',
            fieldPath: 'current_medications.0',
            status: 'accepted',
            userId: 'Practitioner/dr-patel',
        });
    });

    it('omits dosage_instructions from the body when the intake row lacks dose/frequency/route/notes', async () => {
        const minimal = baseMedicationArtifact({
            schemaJson: {
                allergies: [],
                current_medications: [
                    {
                        name: 'metformin',
                        page: 2,
                        bbox: [10, 10, 110, 10, 110, 30, 10, 30],
                        quote: 'metformin',
                        confidence: 0.85,
                    },
                ],
                past_medical_history: [],
                family_history: [],
                patient_demographics: {},
            },
        });
        const deps = makeDeps({
            artifact: minimal,
            promoteResponse: {
                chartRecordUuid: 'chart-med-2',
                chartRecordType: 'list_medication_statement',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-med-1',
                fieldPath: 'current_medications.0',
                factType: 'medication_statement',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-med',
            drug_name: 'metformin',
        });
    });

    it('returns 400 fact_type_mismatch / unsupported_field_path for medication_statement against wrong artifact or path', async () => {
        // Mismatched docType: factType=medication_statement but artifact is lab_pdf.
        const mismatchDeps = makeDeps({
            artifact: baseMedicationArtifact({ docType: 'lab_pdf' }),
        });
        {
            const { app, privateKey } = await buildAuthedApp({
                extractionArtifactStore: mismatchDeps.store,
                promoteClient: mismatchDeps.promoteClient,
            });
            const token = await issueToken(privateKey);
            const res = await app.request('/v1/agent/accept_fact', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    artifactId: 'artifact-med-1',
                    fieldPath: 'current_medications.0',
                    factType: 'medication_statement',
                }),
            });
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'fact_type_mismatch' });
        }

        // Right docType but fieldPath outside `current_medications[]`.
        const pathDeps = makeDeps({ artifact: baseMedicationArtifact() });
        {
            const { app, privateKey } = await buildAuthedApp({
                extractionArtifactStore: pathDeps.store,
                promoteClient: pathDeps.promoteClient,
            });
            const token = await issueToken(privateKey);
            const res = await app.request('/v1/agent/accept_fact', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    artifactId: 'artifact-med-1',
                    fieldPath: 'patient_demographics.name',
                    factType: 'medication_statement',
                }),
            });
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'unsupported_field_path' });
        }
    });
});

describe('POST /v1/agent/accept_fact — happy path (family_history)', () => {
    const baseFamilyHistoryArtifact = (
        overrides: Partial<ExtractionArtifact> = {},
    ): ExtractionArtifact => ({
        artifactId: 'artifact-family-history-1',
        documentUuid: 'doc-uuid-family-history',
        pid: 4242,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            allergies: [],
            current_medications: [],
            past_medical_history: [],
            family_history: [
                {
                    relation: 'Mother',
                    condition: 'Type 2 diabetes',
                    notes: 'diagnosed in mid-30s',
                    page: 1,
                    bbox: [40, 200, 420, 200, 420, 420, 40, 420],
                    quote: 'Mother — Type 2 diabetes',
                    confidence: 0.91,
                },
            ],
            patient_demographics: {},
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

    it('reads intake_form artifact, posts family_history promote.php, records accepted disposition', async () => {
        const deps = makeDeps({
            artifact: baseFamilyHistoryArtifact(),
            promoteResponse: {
                chartRecordUuid: 'chart-family-history-1',
                chartRecordType: 'list_family_history',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-family-history-1',
                fieldPath: 'family_history.0',
                factType: 'family_history',
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            chartRecordUuid: string;
            chartRecordType: string;
            observationUuids: readonly string[];
        };
        expect(body.chartRecordUuid).toBe('chart-family-history-1');
        expect(body.chartRecordType).toBe('list_family_history');
        expect(body.observationUuids).toEqual([]);

        // Promote.php was called with `relation` + `condition` passed
        // through separately so the PHP service composes the
        // canonical `title` (em-dash form) and owns the idempotency
        // normalization.
        expect(deps.promoteCalls).toHaveLength(1);
        const promoteCall = deps.promoteCalls[0]!;
        expect(promoteCall.type).toBe('family_history');
        expect(promoteCall.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-family-history',
            relation: 'Mother',
            condition: 'Type 2 diabetes',
            comments: 'diagnosed in mid-30s',
        });

        // Disposition recorded as accepted with the JWT subject.
        expect(deps.dispositionCalls).toHaveLength(1);
        expect(deps.dispositionCalls[0]).toMatchObject({
            artifactId: 'artifact-family-history-1',
            fieldPath: 'family_history.0',
            status: 'accepted',
            userId: 'Practitioner/dr-patel',
        });
    });

    it('omits optional fields from the body when the intake row lacks them', async () => {
        const minimal = baseFamilyHistoryArtifact({
            schemaJson: {
                allergies: [],
                current_medications: [],
                past_medical_history: [],
                family_history: [
                    {
                        relation: 'Father',
                        condition: 'Heart disease',
                        page: 2,
                        bbox: [10, 10, 110, 10, 110, 30, 10, 30],
                        quote: 'Father — Heart disease',
                        confidence: 0.85,
                    },
                ],
                patient_demographics: {},
            },
        });
        const deps = makeDeps({
            artifact: minimal,
            promoteResponse: {
                chartRecordUuid: 'chart-family-history-2',
                chartRecordType: 'list_family_history',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-family-history-1',
                fieldPath: 'family_history.0',
                factType: 'family_history',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-family-history',
            relation: 'Father',
            condition: 'Heart disease',
        });
    });

    it('returns 400 fact_type_mismatch when factType=family_history but artifact is lab_pdf', async () => {
        const deps = makeDeps({
            artifact: baseFamilyHistoryArtifact({ docType: 'lab_pdf' }),
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
                artifactId: 'artifact-family-history-1',
                fieldPath: 'family_history.0',
                factType: 'family_history',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'fact_type_mismatch' });
    });

    it('returns 400 unsupported_field_path for a fieldPath outside family_history[]', async () => {
        const deps = makeDeps({ artifact: baseFamilyHistoryArtifact() });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-family-history-1',
                fieldPath: 'allergies.0',
                factType: 'family_history',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'unsupported_field_path' });
    });
});

describe('POST /v1/agent/accept_fact — happy path (demographics)', () => {
    const baseDemographicsArtifact = (
        overrides: Partial<ExtractionArtifact> = {},
    ): ExtractionArtifact => ({
        artifactId: 'artifact-demographics-1',
        documentUuid: 'doc-uuid-demographics',
        pid: 4242,
        docType: 'intake_form',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            allergies: [],
            current_medications: [],
            past_medical_history: [],
            family_history: [],
            patient_demographics: {
                name: { value: 'Patel, Maya', page: 1, bbox: [10, 10, 110, 10, 110, 30, 10, 30], quote: 'Patel, Maya', confidence: 0.99 },
                dob: { value: '1979-03-04', page: 1, bbox: [10, 30, 110, 30, 110, 70, 10, 70], quote: '1979-03-04', confidence: 0.99 },
                sex: { value: 'female', page: 1, bbox: [10, 50, 110, 50, 110, 110, 10, 110], quote: 'female', confidence: 0.99 },
                address: {
                    value: '742 Evergreen Terrace, Springfield IL 62701',
                    page: 1,
                    bbox: [10, 70, 390, 70, 390, 150, 10, 150],
                    quote: '742 Evergreen Terrace, Springfield IL 62701',
                    confidence: 0.95,
                },
                phone: {
                    value: '555-867-5309',
                    page: 1,
                    bbox: [10, 90, 210, 90, 210, 190, 10, 190],
                    quote: '555-867-5309',
                    confidence: 0.94,
                },
                email: {
                    value: 'maya.patel@example.com',
                    page: 1,
                    bbox: [10, 110, 290, 110, 290, 230, 10, 230],
                    quote: 'maya.patel@example.com',
                    confidence: 0.96,
                },
            },
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

    it('reads intake_form artifact, posts demographics promote.php with field=address, records accepted disposition', async () => {
        const deps = makeDeps({
            artifact: baseDemographicsArtifact(),
            promoteResponse: {
                chartRecordUuid: 'patient-uuid-1',
                chartRecordType: 'patient_demographics',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-demographics-1',
                fieldPath: 'patient_demographics.address',
                factType: 'demographics',
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            chartRecordUuid: string;
            chartRecordType: string;
        };
        expect(body.chartRecordUuid).toBe('patient-uuid-1');
        expect(body.chartRecordType).toBe('patient_demographics');

        // Promote.php was called with the closed-set `field` enum and
        // the cited `value` from the demographics envelope. The PHP
        // service writes the value verbatim into the matching
        // `patient_data` column (street/phone_cell/email).
        expect(deps.promoteCalls).toHaveLength(1);
        const promoteCall = deps.promoteCalls[0]!;
        expect(promoteCall.type).toBe('demographics');
        expect(promoteCall.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-demographics',
            field: 'address',
            value: '742 Evergreen Terrace, Springfield IL 62701',
        });

        expect(deps.dispositionCalls).toHaveLength(1);
        expect(deps.dispositionCalls[0]).toMatchObject({
            artifactId: 'artifact-demographics-1',
            fieldPath: 'patient_demographics.address',
            status: 'accepted',
            userId: 'Practitioner/dr-patel',
        });
    });

    it('routes phone deltas through the same path with field=phone', async () => {
        const deps = makeDeps({
            artifact: baseDemographicsArtifact(),
            promoteResponse: {
                chartRecordUuid: 'patient-uuid-1',
                chartRecordType: 'patient_demographics',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-demographics-1',
                fieldPath: 'patient_demographics.phone',
                factType: 'demographics',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-demographics',
            field: 'phone',
            value: '555-867-5309',
        });
    });

    it('returns 400 unsupported_field_path for a non-{address|phone|email} demographics slot', async () => {
        const deps = makeDeps({ artifact: baseDemographicsArtifact() });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-demographics-1',
                fieldPath: 'patient_demographics.name',
                factType: 'demographics',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'unsupported_field_path' });
        expect(deps.promoteCalls).toHaveLength(0);
    });

    it('returns 400 schema_invalid when the cited demographics slot is missing', async () => {
        const stripped = baseDemographicsArtifact({
            schemaJson: {
                allergies: [],
                current_medications: [],
                past_medical_history: [],
                family_history: [],
                patient_demographics: {
                    name: { value: 'Patel, Maya', page: 1, bbox: [10, 10, 110, 10, 110, 30, 10, 30], quote: 'Patel, Maya', confidence: 0.99 },
                    dob: { value: '1979-03-04', page: 1, bbox: [10, 30, 110, 30, 110, 70, 10, 70], quote: '1979-03-04', confidence: 0.99 },
                    sex: { value: 'female', page: 1, bbox: [10, 50, 110, 50, 110, 110, 10, 110], quote: 'female', confidence: 0.99 },
                    // address/phone/email omitted — the cited slot is missing.
                },
            },
        });
        const deps = makeDeps({ artifact: stripped });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-demographics-1',
                fieldPath: 'patient_demographics.address',
                factType: 'demographics',
            }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'schema_invalid' });
    });
});

describe('POST /v1/agent/accept_fact — happy path (referral_letter)', () => {
    const baseReferralArtifact = (
        overrides: Partial<ExtractionArtifact> = {},
    ): ExtractionArtifact => ({
        artifactId: 'artifact-referral-1',
        documentUuid: 'doc-uuid-referral',
        pid: 4242,
        docType: 'referral_letter',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            sender_provider: {
                name: { value: 'Helen Park, MD', page: 1, bbox: [0, 0, 0, 0], quote: 'Helen Park, MD', confidence: 0.95 },
            },
            recipient_provider: {
                name: { value: 'Jonathan Liu, MD', page: 1, bbox: [0, 0, 0, 0], quote: 'Jonathan Liu, MD', confidence: 0.95 },
            },
            patient_identifiers: {
                name: { value: 'Margaret Chen', page: 1, bbox: [0, 0, 0, 0], quote: 'Margaret Chen', confidence: 0.97 },
                dob: { value: '1968-03-12', page: 1, bbox: [0, 0, 0, 0], quote: '03/12/1968', confidence: 0.95 },
            },
            reason_for_referral: { value: 'eval', page: 1, bbox: [0, 0, 0, 0], quote: 'eval', confidence: 0.9 },
            past_medical_history: [
                {
                    condition: 'Hyperlipidemia',
                    icd10: 'E78.5',
                    page: 1,
                    bbox: [800, 818, 0, 0],
                    quote: 'Hyperlipidemia (E78.5)',
                    confidence: 0.92,
                },
            ],
            current_medications: [
                {
                    name: 'atorvastatin',
                    dose: '40 mg',
                    route: 'PO',
                    frequency: 'daily',
                    page: 1,
                    bbox: [900, 928, 0, 0],
                    quote: 'atorvastatin 40 mg PO daily',
                    confidence: 0.92,
                },
            ],
            allergies: [],
            pertinent_labs: [
                {
                    analyte_name: 'LDL-C',
                    value: '142',
                    unit: 'mg/dL',
                    collection_date: '2026-04-12',
                    abnormal_flag: 'high',
                    page: 1,
                    bbox: [1100, 1124, 0, 0],
                    quote: 'LDL-C: 142 mg/dL',
                    confidence: 0.93,
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

    it('promotes pertinent_labs through the lab materializer', async () => {
        const deps = makeDeps({
            artifact: baseReferralArtifact(),
            promoteResponse: {
                chartRecordUuid: 'chart-ref-lab-1',
                chartRecordType: 'diagnostic_report',
                observationUuids: ['obs-ldl'],
                idempotentHit: false,
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
                artifactId: 'artifact-referral-1',
                fieldPath: 'pertinent_labs.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls).toHaveLength(1);
        expect(deps.promoteCalls[0]?.type).toBe('lab');
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-referral',
            panel_code: null,
            collection_date: '2026-04-12',
            results: [
                {
                    analyte_name: 'LDL-C',
                    value: '142',
                    unit: 'mg/dL',
                    abnormal_flag: 'high',
                },
            ],
        });
    });

    it('falls back to the artifact createdAt date when a referral pertinent_lab omits collection_date', async () => {
        const noDate = baseReferralArtifact({
            schemaJson: {
                ...(baseReferralArtifact().schemaJson as Record<string, unknown>),
                pertinent_labs: [
                    {
                        analyte_name: 'LDL-C',
                        value: '142',
                        unit: 'mg/dL',
                        page: 1,
                        bbox: [1100, 1124, 0, 0],
                        quote: 'LDL-C: 142 mg/dL',
                        confidence: 0.93,
                    },
                ],
            },
        });
        const deps = makeDeps({ artifact: noDate });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-referral-1',
                fieldPath: 'pertinent_labs.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.body).toMatchObject({
            collection_date: '2026-05-04',
        });
    });

    it('promotes current_medications through the medication_statement materializer', async () => {
        const deps = makeDeps({
            artifact: baseReferralArtifact(),
            promoteResponse: {
                chartRecordUuid: 'chart-ref-med-1',
                chartRecordType: 'list_medication',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-referral-1',
                fieldPath: 'current_medications.0',
                factType: 'medication_statement',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.type).toBe('medication_statement');
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-referral',
            drug_name: 'atorvastatin',
            dosage_instructions: '40 mg daily PO',
        });
    });

    it('promotes past_medical_history through the medical_problem materializer with ICD-10 pass-through', async () => {
        const deps = makeDeps({
            artifact: baseReferralArtifact(),
            promoteResponse: {
                chartRecordUuid: 'chart-ref-pmh-1',
                chartRecordType: 'list_medical_problem',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-referral-1',
                fieldPath: 'past_medical_history.0',
                factType: 'past_medical_history',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.type).toBe('past_medical_history');
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-referral',
            title: 'Hyperlipidemia',
            diagnosis: 'E78.5',
        });
    });

    it('omits diagnosis when a referral PMH entry has no icd10 code', async () => {
        const noIcd = baseReferralArtifact({
            schemaJson: {
                ...(baseReferralArtifact().schemaJson as Record<string, unknown>),
                past_medical_history: [
                    {
                        condition: 'Hypertension',
                        page: 1,
                        bbox: [820, 832, 0, 0],
                        quote: 'Hypertension',
                        confidence: 0.9,
                    },
                ],
            },
        });
        const deps = makeDeps({ artifact: noIcd });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-referral-1',
                fieldPath: 'past_medical_history.0',
                factType: 'past_medical_history',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-referral',
            title: 'Hypertension',
        });
    });

    it('promotes referral allergies through the allergy materializer', async () => {
        const withAllergy = baseReferralArtifact({
            schemaJson: {
                ...(baseReferralArtifact().schemaJson as Record<string, unknown>),
                allergies: [
                    {
                        substance: 'sulfa',
                        reaction: 'rash',
                        page: 1,
                        bbox: [950, 960, 0, 0],
                        quote: 'sulfa — rash',
                        confidence: 0.91,
                    },
                ],
            },
        });
        const deps = makeDeps({
            artifact: withAllergy,
            promoteResponse: {
                chartRecordUuid: 'chart-ref-allergy-1',
                chartRecordType: 'list_allergy',
                observationUuids: [],
                idempotentHit: false,
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
                artifactId: 'artifact-referral-1',
                fieldPath: 'allergies.0',
                factType: 'allergy',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls[0]?.type).toBe('allergy');
        expect(deps.promoteCalls[0]?.body).toEqual({
            pid: 4242,
            source_document_uuid: 'doc-uuid-referral',
            substance: 'sulfa',
            reaction_option_id: 'rash',
        });
    });
});

describe('POST /v1/agent/accept_fact — patient-match gate', () => {
    const partialMatchArtifact = (): ExtractionArtifact => ({
        artifactId: 'artifact-partial-1',
        documentUuid: 'doc-uuid-partial',
        pid: 4242,
        docType: 'lab_pdf',
        extractorVersion: 'v1.0.0',
        schemaJson: {
            results: [
                {
                    analyte_name: 'HbA1c',
                    value: '6.1',
                    unit: '%',
                    collection_date: '2026-04-15',
                    page: 1,
                    bbox: [0, 0, 0, 0],
                    quote: 'HbA1c 6.1 %',
                    confidence: 0.93,
                },
            ],
        },
        deltasJson: null,
        confidenceSignal: {
            patientMatchScore: 0.8,
            patientMatchPartial: true,
            demographicsWarnings: ['name_partial_match'],
        },
        status: 'pending_confirmation',
        documentHash: 'hash',
        createdAt: '2026-05-04T12:00:00.000Z',
        confirmedAt: null,
        confirmedByUser: null,
    });

    it('refuses promotion with 409 low_match_confidence when patientMatchPartial is true', async () => {
        const deps = makeDeps({ artifact: partialMatchArtifact() });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-partial-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'low_match_confidence' });
        // No promote.php call, no disposition recorded — the gate
        // short-circuits before either side effect.
        expect(deps.promoteCalls).toHaveLength(0);
        expect(deps.dispositionCalls).toHaveLength(0);
    });

    it('allows promotion when patientMatchPartial is false (confident match)', async () => {
        const confident: ExtractionArtifact = {
            ...partialMatchArtifact(),
            confidenceSignal: {
                patientMatchScore: 1.0,
                patientMatchPartial: false,
                demographicsWarnings: [],
            },
        };
        const deps = makeDeps({ artifact: confident });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-partial-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls).toHaveLength(1);
    });

    it('allows promotion when confidenceSignal is null (no signal recorded)', async () => {
        const noSignal: ExtractionArtifact = {
            ...partialMatchArtifact(),
            confidenceSignal: null,
        };
        const deps = makeDeps({ artifact: noSignal });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: deps.store,
            promoteClient: deps.promoteClient,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/accept_fact', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                artifactId: 'artifact-partial-1',
                fieldPath: 'results.0',
                factType: 'lab',
            }),
        });
        expect(res.status).toBe(200);
        expect(deps.promoteCalls).toHaveLength(1);
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
