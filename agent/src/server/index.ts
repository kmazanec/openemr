import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import {
    createBearerAuthMiddleware,
    getPrincipal,
    getRawToken,
    type BearerAuthMiddlewareOptions,
} from '../auth/middleware.js';
import { createLocalKeyResolver, createRemoteKeyResolver } from '../auth/jwks.js';
import { createAgentJwtVerifier, type AgentJwtVerifier } from '../auth/verify.js';
import type { RequestEnvelope } from '../graph/types.js';
import { createLogger } from '../observability/logger.js';
import { createCheckpointer } from '../state/checkpointer.js';
import { createPgUnverifiedClaimsLog } from '../verify/unverifiedClaimsLog.js';
import type { JWK } from 'jose';

import { encodeStreamEvent, type BriefingStreamEvent } from './briefingStream.js';
import { buildProductionBriefingRunner, type BriefingRunner } from './briefingRunner.js';
import { classifyBriefingError } from './errorClassifier.js';

const DEFAULT_AUDIENCE = 'openemr-clinical-copilot-agent';

interface AppDeps {
    readonly auth: BearerAuthMiddlewareOptions;
    readonly briefingRunner: BriefingRunner;
}

const briefingRequestSchema = z.object({
    conversationId: z.string().min(1),
    requestId: z.string().min(1),
    siteId: z.string().min(1),
    patient: z.object({
        pid: z.number().int().positive(),
        // Browser callers don't always have the FHIR UUID handy; the
        // snapshot endpoint resolves the patient by pid behind the bearer
        // token, so the uuid travels in the envelope for tracing and
        // future cross-system references but is not load-bearing today.
        uuid: z.string().default(''),
    }),
    task: z.union([z.literal('default_briefing'), z.literal('follow_up')]).default('default_briefing'),
});

export const createApp = ({ auth, briefingRunner }: AppDeps): Hono => {
    const app = new Hono();
    const logger = createLogger('server');

    app.get('/health', (c) => c.json({ status: 'ok' }));

    app.use('/v1/*', createBearerAuthMiddleware(auth));

    app.post('/v1/agent/respond', async (c) => {
        const principal = getPrincipal(c);
        const body: unknown = await c.req.json();
        return c.json({ received: body, fhirUser: principal.fhirUser });
    });

    // The stream-echo route from §1.6 is superseded by /v1/agent/briefing
    // below. Keeping the non-stream /v1/agent/respond echo for legacy
    // smoke-tests until §3.5 lands; the typed briefing path is the only
    // surface the §3.4 UI talks to.

    /**
     * §3.4 default-briefing entry point. The proxy mints a JWT with the
     * acting Practitioner's `fhirUser`; the request body carries the rest
     * of the envelope (conversation/request/patient/site). The runner runs
     * the LangGraph briefing graph and emits the section-by-section SSE
     * sequence defined in `briefingStream.ts`. On any internal failure we
     * still complete the SSE stream with a typed `error` event so the
     * browser's failure-state UI fires instead of seeing a hung connection.
     */
    app.post('/v1/agent/briefing', async (c) => {
        const principal = getPrincipal(c);
        const token = getRawToken(c);
        const rawBody: unknown = await c.req.json().catch(() => null);
        const parsed = briefingRequestSchema.safeParse(rawBody);

        return streamSSE(c, async (stream) => {
            const writeEvent = async (event: BriefingStreamEvent): Promise<void> => {
                await stream.write(encodeStreamEvent(event));
            };

            if (!parsed.success) {
                await writeEvent({ type: 'error', code: 'invalid_envelope' });
                return;
            }

            // Defense-in-depth: the JWT issuer pins which site the
            // physician was authenticated against. The browser-supplied
            // envelope must match — otherwise a stale tab or a bug in the
            // proxy could route a request across sites. The proxy already
            // gates this at mint time; refusing again here keeps the
            // contract local to whichever side reads the envelope last.
            if (parsed.data.siteId !== principal.siteId) {
                logger.warn(
                    {
                        envelopeSite: parsed.data.siteId,
                        principalSite: principal.siteId,
                        requestId: parsed.data.requestId,
                    },
                    'site mismatch between envelope and JWT — rejecting',
                );
                await writeEvent({ type: 'error', code: 'site_mismatch' });
                return;
            }
            const envelope: RequestEnvelope = {
                conversationId: parsed.data.conversationId,
                requestId: parsed.data.requestId,
                siteId: principal.siteId,
                actor: { userId: principal.sub, fhirUser: principal.fhirUser },
                patient: parsed.data.patient,
                task: parsed.data.task,
            };

            try {
                const events = await briefingRunner({ envelope, token });
                for (const event of events) {
                    await writeEvent(event);
                }
            } catch (err) {
                const code = classifyBriefingError(err);
                logger.error(
                    {
                        err,
                        code,
                        requestId: envelope.requestId,
                        conversationId: envelope.conversationId,
                    },
                    'briefing runner failed',
                );
                await writeEvent({ type: 'error', code });
            }
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
    const openEmrBaseUrl = process.env['OPENEMR_BASE_URL'] ?? '';
    if (openEmrBaseUrl.length === 0) {
        logger.error('OPENEMR_BASE_URL is not set; agent cannot reach the snapshot endpoint');
        throw new Error('OPENEMR_BASE_URL is required');
    }
    const verify = buildVerifier();
    const checkpointer = createCheckpointer(databaseUrl);
    await checkpointer.setup();
    logger.info('LangGraph Postgres checkpointer ready');

    const unverifiedClaimsLog = createPgUnverifiedClaimsLog({ connectionString: databaseUrl });
    await unverifiedClaimsLog.setup();
    logger.info('unverified-claims log table ready');

    const briefingRunner = buildProductionBriefingRunner({
        openEmrBaseUrl,
        unverifiedClaimsLog,
    });

    const app = createApp({ auth: { verify }, briefingRunner });
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
