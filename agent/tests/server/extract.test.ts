import type { KeyLike } from 'jose';
import { describe, expect, it } from 'vitest';

import { eventForNodeUpdate, type PipelineRunner } from '../../src/server/routes/extract.js';
import type { PipelineState } from '../../src/pipeline/state.js';
import { mintTestToken } from '../auth/testKeys.js';
import { TEST_AUDIENCE, TEST_ISSUER, buildAuthedApp } from './buildAuthedApp.js';

const baseRequest = {
    pid: 4242,
    document_uuid: 'doc-uuid-aaaa',
    doc_type: 'lab_pdf' as const,
    trigger_source: 'panel' as const,
};

const baseFinalState = (overrides: Partial<PipelineState> = {}): PipelineState => ({
    documentUuid: baseRequest.document_uuid,
    docType: baseRequest.doc_type,
    pid: baseRequest.pid,
    triggerSource: baseRequest.trigger_source,
    pages: [],
    documentText: null,
    schema: null,
    artifactId: 'artifact-1',
    confidenceSignal: null,
    idempotencyHit: false,
    status: 'persisted',
    errors: [],
    ...overrides,
});

// eslint-disable-next-line @typescript-eslint/require-await
async function* asyncIterableFrom<T>(items: readonly T[]): AsyncIterable<T> {
    for (const item of items) yield item;
}

const stubPipeline = (chunks: readonly (readonly [string, unknown])[]): PipelineRunner => ({
    stream: () => Promise.resolve(asyncIterableFrom(chunks)),
});

const issueToken = async (privateKey: KeyLike): Promise<string> =>
    mintTestToken(privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject: 'Practitioner/dr-patel',
        scopes: [],
    });

const parseSseEvents = (text: string): { event: string; data: unknown }[] => {
    const events: { event: string; data: unknown }[] = [];
    for (const block of text.split('\n\n')) {
        if (block.trim() === '') continue;
        let event = '';
        let data = '';
        for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice('event: '.length);
            else if (line.startsWith('data: ')) data = line.slice('data: '.length);
        }
        if (event === '') continue;
        events.push({ event, data: data === '' ? null : JSON.parse(data) });
    }
    return events;
};

describe('POST /v1/agent/extract — auth', () => {
    it('rejects requests without a bearer token', async () => {
        const { app } = await buildAuthedApp({ pipeline: stubPipeline([]) });
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(baseRequest),
        });
        expect(res.status).toBe(401);
    });

    it('returns 503 when the pipeline dep is not wired', async () => {
        const { app, privateKey } = await buildAuthedApp();
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(baseRequest),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ code: 'pipeline_unavailable' });
    });
});

describe('POST /v1/agent/extract — envelope validation', () => {
    it('emits pipeline.error on a malformed body without invoking the pipeline', async () => {
        let invoked = false;
        const pipeline: PipelineRunner = {
            stream: (_input, _ctx) => {
                invoked = true;
                return Promise.resolve(asyncIterableFrom([]));
            },
        };
        const { app, privateKey } = await buildAuthedApp({ pipeline });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ pid: 'not-a-number' }),
        });
        expect(res.status).toBe(200);
        const events = parseSseEvents(await res.text());
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            event: 'pipeline.error',
            data: { type: 'pipeline.error', code: 'schema_invalid', message: 'invalid_envelope' },
        });
        expect(invoked).toBe(false);
    });

    it.each([
        { field: 'doc_type', value: 'wrong_doc' },
        { field: 'trigger_source', value: 'browser' },
    ])('rejects out-of-range $field', async ({ field, value }) => {
        const { app, privateKey } = await buildAuthedApp({ pipeline: stubPipeline([]) });
        const token = await issueToken(privateKey);
        const body = { ...baseRequest, [field]: value };
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        const events = parseSseEvents(await res.text());
        expect(events[0]?.event).toBe('pipeline.error');
    });
});

describe('POST /v1/agent/extract — happy path', () => {
    it('emits start → rasterize.complete → vision.complete → persist.complete → exit', async () => {
        const finalState = baseFinalState();
        const pipeline = stubPipeline([
            ['updates', { rasterize: { pages: [{ pageNum: 1 }, { pageNum: 2 }, { pageNum: 3 }] } }],
            ['updates', { vision: { schema: {} } }],
            ['updates', { schemaValidate: {} }],
            ['updates', { patientMatch: { confidenceSignal: null } }],
            ['updates', { persist: { artifactId: 'artifact-1' } }],
            ['updates', { emitDeltas: {} }],
            ['updates', { cleanup: {} }],
            ['values', finalState],
        ]);
        const { app, privateKey } = await buildAuthedApp({ pipeline });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(baseRequest),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const events = parseSseEvents(await res.text());
        const types = events.map((e) => e.event);
        expect(types).toEqual([
            'pipeline.start',
            'pipeline.rasterize.complete',
            'pipeline.vision.complete',
            'pipeline.persist.complete',
            'pipeline.exit',
        ]);
        expect(events[0]!.data).toMatchObject({
            documentUuid: 'doc-uuid-aaaa',
            docType: 'lab_pdf',
            triggerSource: 'panel',
        });
        expect(events[1]!.data).toMatchObject({ pageCount: 3 });
        expect(events[3]!.data).toMatchObject({ artifactId: 'artifact-1' });
        expect(events[4]!.data).toMatchObject({ status: 'persisted', artifactId: 'artifact-1' });
    });
});

describe('POST /v1/agent/extract — failure paths', () => {
    it('emits pipeline.error + exit:failed when the pipeline reports a typed error', async () => {
        const finalState = baseFinalState({
            status: 'failed',
            artifactId: null,
            errors: [{ code: 'patient_mismatch', message: 'name_dob_mismatch' }],
        });
        const pipeline = stubPipeline([
            ['updates', { rasterize: { pages: [{ pageNum: 1 }] } }],
            ['updates', { vision: { schema: {} } }],
            ['updates', { schemaValidate: {} }],
            ['updates', { patientMatch: {} }],
            ['updates', { cleanup: {} }],
            ['values', finalState],
        ]);
        const { app, privateKey } = await buildAuthedApp({ pipeline });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(baseRequest),
        });
        const events = parseSseEvents(await res.text());
        const errorEvt = events.find((e) => e.event === 'pipeline.error');
        const exitEvt = events.find((e) => e.event === 'pipeline.exit');
        expect(errorEvt?.data).toMatchObject({ code: 'patient_mismatch', message: 'name_dob_mismatch' });
        expect(exitEvt?.data).toMatchObject({ status: 'failed', artifactId: null });
    });

    it('emits pipeline.error when the stream throws mid-flight', async () => {
        // eslint-disable-next-line @typescript-eslint/require-await
        async function* throwingStream(): AsyncIterable<unknown> {
            yield ['updates', { rasterize: { pages: [{ pageNum: 1 }] } }];
            throw new Error('boom');
        }
        const pipeline: PipelineRunner = {
            stream: (_input, _ctx) => Promise.resolve(throwingStream()),
        };
        const { app, privateKey } = await buildAuthedApp({ pipeline });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(baseRequest),
        });
        const events = parseSseEvents(await res.text());
        expect(events.at(-1)?.event).toBe('pipeline.error');
        expect(events.at(-1)?.data).toMatchObject({ code: 'persist_failed' });
    });

    it('emits pipeline.error when the pipeline produces no terminal values chunk', async () => {
        const pipeline = stubPipeline([
            ['updates', { rasterize: { pages: [{ pageNum: 1 }] } }],
        ]);
        const { app, privateKey } = await buildAuthedApp({ pipeline });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(baseRequest),
        });
        const events = parseSseEvents(await res.text());
        expect(events.at(-1)?.event).toBe('pipeline.error');
        expect(events.at(-1)?.data).toMatchObject({ code: 'persist_failed', message: 'pipeline_no_terminal_state' });
    });
});

describe('POST /v1/agent/extract — call context', () => {
    it('forwards token, siteId, canonical_ext, conversation_id to pipeline.stream', async () => {
        const calls: { ctx: unknown }[] = [];
        const finalState = baseFinalState();
        const pipeline: PipelineRunner = {
            stream: (_input, ctx) => {
                calls.push({ ctx });
                return Promise.resolve(asyncIterableFrom([['values', finalState]]));
            },
        };
        const { app, privateKey } = await buildAuthedApp({ pipeline });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                ...baseRequest,
                canonical_ext: 'png',
                conversation_id: 'conv-xyz',
            }),
        });
        expect(res.status).toBe(200);
        await res.text();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.ctx).toMatchObject({
            openemrToken: token,
            canonicalExt: 'png',
            conversationId: 'conv-xyz',
        });
    });

    it('defaults canonical_ext to pdf and omits conversation_id when not supplied', async () => {
        const calls: { ctx: unknown }[] = [];
        const finalState = baseFinalState();
        const pipeline: PipelineRunner = {
            stream: (_input, ctx) => {
                calls.push({ ctx });
                return Promise.resolve(asyncIterableFrom([['values', finalState]]));
            },
        };
        const { app, privateKey } = await buildAuthedApp({ pipeline });
        const token = await issueToken(privateKey);
        const res = await app.request('/v1/agent/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(baseRequest),
        });
        await res.text();
        expect(calls[0]!.ctx).toMatchObject({ canonicalExt: 'pdf' });
        expect(calls[0]!.ctx).not.toHaveProperty('conversationId');
    });
});

describe('eventForNodeUpdate — translation contract', () => {
    it('emits pipeline.rasterize.complete with the page count', () => {
        const evt = eventForNodeUpdate('rasterize', { pages: [{ pageNum: 1 }, { pageNum: 2 }] });
        expect(evt).toEqual({ type: 'pipeline.rasterize.complete', pageCount: 2 });
    });

    it('skips rasterize updates that do not carry a pages array', () => {
        expect(eventForNodeUpdate('rasterize', {})).toBeNull();
    });

    it('emits pipeline.vision.complete on any vision update', () => {
        expect(eventForNodeUpdate('vision', { schema: {} })).toEqual({ type: 'pipeline.vision.complete' });
    });

    it('emits pipeline.persist.complete with artifactId', () => {
        const evt = eventForNodeUpdate('persist', { artifactId: 'artifact-99' });
        expect(evt).toEqual({ type: 'pipeline.persist.complete', artifactId: 'artifact-99' });
    });

    it('skips persist updates that do not carry an artifactId', () => {
        expect(eventForNodeUpdate('persist', { artifactId: null })).toBeNull();
    });

    it.each(['cleanup', 'schemaValidate', 'patientMatch', 'emitDeltas', 'unknown'])(
        'skips node %s — not user-visible',
        (nodeName) => {
            expect(eventForNodeUpdate(nodeName, {})).toBeNull();
        },
    );
});
