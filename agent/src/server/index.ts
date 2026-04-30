import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import {
    createBearerAuthMiddleware,
    getPrincipal,
    type BearerAuthMiddlewareOptions,
} from '../auth/middleware.js';
import { createLocalKeyResolver, createRemoteKeyResolver } from '../auth/jwks.js';
import { createAgentJwtVerifier, type AgentJwtVerifier } from '../auth/verify.js';
import { createLogger } from '../observability/logger.js';
import { createCheckpointer } from '../state/checkpointer.js';
import type { JWK } from 'jose';

const DEFAULT_AUDIENCE = 'openemr-clinical-copilot-agent';

interface AppDeps {
    auth: BearerAuthMiddlewareOptions;
}

export const createApp = ({ auth }: AppDeps): Hono => {
    const app = new Hono();

    app.get('/health', (c) => c.json({ status: 'ok' }));

    app.use('/v1/*', createBearerAuthMiddleware(auth));

    app.post('/v1/agent/respond', async (c) => {
        const principal = getPrincipal(c);
        const body: unknown = await c.req.json();
        return c.json({ received: body, fhirUser: principal.fhirUser });
    });

    app.post('/v1/agent/respond/stream', async (c) => {
        const principal = getPrincipal(c);
        const body: unknown = await c.req.json();
        return streamSSE(c, async (stream) => {
            await stream.writeSSE({
                data: JSON.stringify({ received: body, fhirUser: principal.fhirUser }),
            });
        });
    });

    // Smoke-test endpoint paired with the proxy's `echo` action. End-to-end
    // smoke verifies the trust boundary works before any real LLM lands.
    app.post('/v1/agent/echo', async (c) => {
        const principal = getPrincipal(c);
        let received: unknown = null;
        const raw = await c.req.text();
        if (raw.length > 0) {
            try {
                received = JSON.parse(raw);
            } catch {
                received = raw;
            }
        }
        return streamSSE(c, async (stream) => {
            await stream.writeSSE({
                data: JSON.stringify({
                    ok: true,
                    action: 'echo',
                    fhirUser: principal.fhirUser,
                    received,
                }),
            });
        });
    });

    return app;
};

const buildVerifier = (): AgentJwtVerifier => {
    const issuer = process.env['AGENT_JWT_ISSUER'] ?? '';
    if (issuer.length === 0) {
        throw new Error('AGENT_JWT_ISSUER is required');
    }
    const audience = process.env['AGENT_JWT_AUDIENCE'] ?? DEFAULT_AUDIENCE;

    const jwksUri = process.env['OPENEMR_JWKS_URL'] ?? '';
    const staticJwk = process.env['AGENT_JWT_PUBLIC_KEY'] ?? '';

    if (jwksUri.length > 0) {
        return createAgentJwtVerifier({
            keyResolver: createRemoteKeyResolver({ jwksUri: new URL(jwksUri) }),
            issuer,
            audience,
        });
    }
    if (staticJwk.length > 0) {
        const jwk = JSON.parse(staticJwk) as JWK;
        return createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([jwk]),
            issuer,
            audience,
        });
    }
    throw new Error('one of OPENEMR_JWKS_URL or AGENT_JWT_PUBLIC_KEY must be set');
};

export const start = async (port: number): Promise<void> => {
    const logger = createLogger('server');
    const databaseUrl = process.env['DATABASE_URL'] ?? '';
    if (databaseUrl.length === 0) {
        logger.error('DATABASE_URL is not set; cannot boot agent state store');
        throw new Error('DATABASE_URL is required');
    }
    const verify = buildVerifier();
    const checkpointer = createCheckpointer(databaseUrl);
    await checkpointer.setup();
    logger.info('LangGraph Postgres checkpointer ready');

    const app = createApp({ auth: { verify } });
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
