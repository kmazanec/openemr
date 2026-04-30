import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { createLogger } from '../observability/logger.js';
import { createCheckpointer } from '../state/checkpointer.js';

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

export const start = async (port: number): Promise<void> => {
    const logger = createLogger('server');
    const databaseUrl = process.env['DATABASE_URL'] ?? '';
    if (databaseUrl.length === 0) {
        logger.error('DATABASE_URL is not set; cannot boot agent state store');
        throw new Error('DATABASE_URL is required');
    }
    const checkpointer = createCheckpointer(databaseUrl);
    await checkpointer.setup();
    logger.info('LangGraph Postgres checkpointer ready');

    serve({ fetch: app.fetch, port });
    logger.info({ port }, 'agent service listening');
};

const entry = process.argv[1] ?? '';
if (import.meta.url === `file://${entry}` || entry.endsWith('/src/server/index.ts')) {
    const port = Number(process.env['PORT'] ?? 8080);
    start(port).catch((err: unknown) => {
        createLogger('server').error({ err }, 'failed to start agent service');
        process.exit(1);
    });
}
