import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/v1/agent/respond', async (c) => {
    const body: unknown = await c.req.json();
    return c.json({ received: body });
});

app.post('/v1/agent/respond/stream', async (c) => {
    const body: unknown = await c.req.json();
    return streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: JSON.stringify({ received: body }) });
    });
});

export const start = (port: number): void => {
    serve({ fetch: app.fetch, port });
};

const entry = process.argv[1] ?? '';
if (import.meta.url === `file://${entry}` || entry.endsWith('/src/server/index.ts')) {
    const port = Number(process.env['PORT'] ?? 8080);
    start(port);
}
