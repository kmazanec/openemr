/**
 * F.5a `POST /v1/agent/dispositions` route tests.
 *
 * Pins the contract that the panel UI relies on: a JWT-bearer'd POST
 * with `(artifactId, fieldPath, status)` records the disposition
 * through the artifact store, returns the canonical row + any
 * artifact-level rollup, and surfaces typed error envelopes for
 * malformed inputs and store failures.
 *
 * The store is faked here; the real `recordDisposition` semantics
 * (`ON CONFLICT DO NOTHING`, auto-roll on `expectedFactPaths`,
 * already-accepted-stays-accepted) are pinned by the
 * `extractionArtifacts.test.ts` suite and don't belong duplicated
 * here.
 */

import type { KeyLike } from 'jose';
import { describe, expect, it } from 'vitest';

import type {
    ExtractionArtifactStore,
    FactDisposition,
    RecordDispositionInput,
    RecordDispositionResult,
} from '../../src/state/extractionArtifacts.js';
import { mintTestToken } from '../auth/testKeys.js';

import { TEST_AUDIENCE, TEST_ISSUER, buildAuthedApp } from './buildAuthedApp.js';

interface RecordingStore {
    readonly store: Pick<ExtractionArtifactStore, 'recordDisposition'>;
    readonly calls: RecordDispositionInput[];
}

const makeStore = (
    response: RecordDispositionResult | (() => never),
): RecordingStore => {
    const calls: RecordDispositionInput[] = [];
    return {
        calls,
        store: {
            recordDisposition: (input: RecordDispositionInput): Promise<RecordDispositionResult> => {
                calls.push(input);
                if (typeof response === 'function') {
                    response();
                    // unreachable; the throw above terminates execution
                    throw new Error('makeStore: thrower did not throw');
                }
                return Promise.resolve(response);
            },
        },
    };
};

const baseDisposition = (overrides: Partial<FactDisposition> = {}): FactDisposition => ({
    artifactId: 'artifact-1',
    fieldPath: 'results.0.value',
    status: 'accepted',
    acceptedAt: '2026-05-07T12:00:00.000Z',
    acceptedByUser: 'Practitioner/dr-patel',
    ...overrides,
});

const issueToken = (privateKey: KeyLike): Promise<string> =>
    mintTestToken(privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject: 'Practitioner/dr-patel',
        scopes: [],
    });

describe('POST /v1/agent/dispositions — auth + dep wiring', () => {
    it('rejects requests without a bearer token', async () => {
        const { app } = await buildAuthedApp({
            extractionArtifactStore: makeStore({
                disposition: baseDisposition(),
                artifactStatusRolledTo: null,
            }).store,
        });
        const res = await app.request('/v1/agent/dispositions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0.value',
                status: 'accepted',
            }),
        });
        expect(res.status).toBe(401);
    });

    it('returns 503 when the artifact store is not wired', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/dispositions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0.value',
                status: 'accepted',
            }),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'dispositions_unavailable' });
    });
});

describe('POST /v1/agent/dispositions — envelope validation', () => {
    it.each([
        { name: 'missing artifactId', body: { fieldPath: 'a', status: 'accepted' } },
        { name: 'missing fieldPath', body: { artifactId: 'a', status: 'accepted' } },
        { name: 'missing status', body: { artifactId: 'a', fieldPath: 'a' } },
        { name: 'invalid status', body: { artifactId: 'a', fieldPath: 'a', status: 'pending' } },
        { name: 'empty artifactId', body: { artifactId: '', fieldPath: 'a', status: 'accepted' } },
        { name: 'empty fieldPath', body: { artifactId: 'a', fieldPath: '', status: 'accepted' } },
    ])('rejects $name with 400 invalid_body', async ({ body }) => {
        const recorder = makeStore({
            disposition: baseDisposition(),
            artifactStatusRolledTo: null,
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: recorder.store,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/dispositions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_body' });
        expect(recorder.calls).toHaveLength(0);
    });

    it('rejects a non-JSON body with 400', async () => {
        const recorder = makeStore({
            disposition: baseDisposition(),
            artifactStatusRolledTo: null,
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: recorder.store,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/dispositions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: 'not json',
        });
        expect(res.status).toBe(400);
        expect(recorder.calls).toHaveLength(0);
    });
});

describe('POST /v1/agent/dispositions — happy path', () => {
    it('accept records with userId from JWT subject and returns the row', async () => {
        const recorder = makeStore({
            disposition: baseDisposition({ status: 'accepted' }),
            artifactStatusRolledTo: null,
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: recorder.store,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/dispositions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0.value',
                status: 'accepted',
            }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            disposition: {
                artifactId: 'artifact-1',
                fieldPath: 'results.0.value',
                status: 'accepted',
                acceptedAt: '2026-05-07T12:00:00.000Z',
            },
            artifactStatusRolledTo: null,
        });
        expect(recorder.calls).toHaveLength(1);
        expect(recorder.calls[0]).toMatchObject({
            artifactId: 'artifact-1',
            fieldPath: 'results.0.value',
            status: 'accepted',
            userId: 'Practitioner/dr-patel',
        });
    });

    it('reject records with status="rejected" and surfaces a rolled artifact status', async () => {
        const recorder = makeStore({
            disposition: baseDisposition({ status: 'rejected' }),
            artifactStatusRolledTo: 'rejected',
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: recorder.store,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/dispositions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0.value',
                status: 'rejected',
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { artifactStatusRolledTo: string | null };
        expect(body.artifactStatusRolledTo).toBe('rejected');
        expect(recorder.calls[0]?.status).toBe('rejected');
    });
});

describe('POST /v1/agent/dispositions — store failure', () => {
    it('surfaces 500 disposition_failed when the store throws', async () => {
        const recorder = makeStore(() => {
            throw new Error('simulated DB failure');
        });
        const { app, privateKey } = await buildAuthedApp({
            extractionArtifactStore: recorder.store,
        });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/dispositions', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                artifactId: 'artifact-1',
                fieldPath: 'results.0.value',
                status: 'accepted',
            }),
        });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'disposition_failed' });
    });
});
