import type { Context, MiddlewareHandler } from 'hono';

import { createLogger } from '../observability/logger.js';
import { AgentJwtVerificationError, type AgentJwtVerifier, type AgentPrincipal } from './verify.js';

const PRINCIPAL_KEY = 'agentPrincipal' as const;
const RAW_TOKEN_KEY = 'agentRawToken' as const;

declare module 'hono' {
    interface ContextVariableMap {
        [PRINCIPAL_KEY]: AgentPrincipal;
        [RAW_TOKEN_KEY]: string;
    }
}

export interface BearerAuthMiddlewareOptions {
    verify: AgentJwtVerifier;
}

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

const unauthorized = (c: Context): Response =>
    c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer realm="agent"',
    });

/**
 * Hono middleware that requires a verifiable Bearer JWT on every request.
 * Even though the agent service listens on a private Docker network, the
 * proxy controller is the only legitimate caller — refusing unauthenticated
 * traffic is defense in depth (PRESEARCH §18; plan §1.5).
 */
export const createBearerAuthMiddleware = (
    options: BearerAuthMiddlewareOptions,
): MiddlewareHandler => {
    const logger = createLogger('auth');
    return async (c, next) => {
        const header = c.req.header('authorization');
        const match = header !== undefined ? BEARER_PREFIX.exec(header) : null;
        const token = match?.[1]?.trim() ?? '';
        if (token.length === 0) {
            return unauthorized(c);
        }

        try {
            const principal = await options.verify(token);
            c.set(PRINCIPAL_KEY, principal);
            // Stash the raw token so routes that need to forward the
            // physician's bearer (e.g. snapshot fetch) don't re-parse the
            // Authorization header. Treated as sensitive — never logged.
            c.set(RAW_TOKEN_KEY, token);
            logger.debug(
                {
                    fhirUser: principal.fhirUser,
                    jti: principal.jti,
                    scopes: principal.scopes,
                },
                'authenticated agent request',
            );
        } catch (err) {
            if (err instanceof AgentJwtVerificationError) {
                logger.debug({ err: err.message }, 'rejected agent request');
                return unauthorized(c);
            }
            throw err;
        }
        await next();
    };
};

/**
 * Read the authenticated principal off a Hono context. Throws if called
 * from a route the auth middleware does not cover — using it as a runtime
 * guard against accidentally exposing an unauthenticated handler.
 */
export const getPrincipal = (c: Context): AgentPrincipal => {
    const principal = c.get(PRINCIPAL_KEY);
    if (!principal) {
        throw new Error('agent principal missing — route is not behind bearer auth');
    }
    return principal;
};

/**
 * Read the raw bearer token off a Hono context. Used by routes that need
 * to forward the physician's identity to OpenEMR (e.g. snapshot fetch).
 * Throws if the auth middleware did not run — same guard as getPrincipal.
 */
export const getRawToken = (c: Context): string => {
    const token = c.get(RAW_TOKEN_KEY);
    if (!token) {
        throw new Error('agent raw token missing — route is not behind bearer auth');
    }
    return token;
};
