import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { app, start } from '../../src/server/index.js';

describe('agent server', () => {
    let originalDatabaseUrl: string | undefined;

    beforeEach(() => {
        originalDatabaseUrl = process.env['DATABASE_URL'];
    });

    afterEach(() => {
        if (originalDatabaseUrl === undefined) {
            delete process.env['DATABASE_URL'];
        } else {
            process.env['DATABASE_URL'] = originalDatabaseUrl;
        }
    });

    it('start() rejects when DATABASE_URL is unset', async () => {
        delete process.env['DATABASE_URL'];
        await expect(start(0)).rejects.toThrow(/DATABASE_URL/);
    });

    it('GET /health returns ok', async () => {
        const res = await app.request('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('POST /v1/agent/respond echoes the body', async () => {
        const body = { conversationId: 'conv-1', message: 'hello' };
        const res = await app.request('/v1/agent/respond', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ received: body });
    });

    it('POST /v1/agent/respond/stream returns an SSE stream that echoes the body', async () => {
        const body = { conversationId: 'conv-1', message: 'hello' };
        const res = await app.request('/v1/agent/respond/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        const text = await res.text();
        expect(text).toContain('data: ');
        const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
        expect(dataLine).toBeDefined();
        const payload: unknown = JSON.parse(dataLine!.slice('data: '.length));
        expect(payload).toEqual({ received: body });
    });
});
