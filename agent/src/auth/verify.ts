import { jwtVerify, type JWTPayload } from 'jose';

import type { KeyResolver } from './jwks.js';

/**
 * Identity carried on each authenticated request. The proxy controller
 * mints a token whose `sub` is the acting practitioner's fhirUser uuid
 * (`Practitioner/{uuid}` when known, else the legacy auth_user id) — see
 * `interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentTokenMinter.php`.
 *
 * Downstream code (tools, traces) cares about the fhirUser, so we expose
 * it as a first-class field aliased from `sub`.
 */
export interface AgentPrincipal {
    sub: string;
    fhirUser: string;
    scopes: string[];
    jti: string;
    audience: string;
    issuer: string;
    expiresAt: Date;
    /** Raw decoded payload — for diagnostics, not for routing logic. */
    raw: JWTPayload;
}

export class AgentJwtVerificationError extends Error {
    public override readonly name = 'AgentJwtVerificationError';
    public override readonly cause?: unknown;

    public constructor(message: string, cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export interface AgentJwtVerifierOptions {
    keyResolver: KeyResolver;
    issuer: string;
    audience: string;
    /** Allowed signing algorithms. Default: League OAuth2 signs with RS256. */
    algorithms?: string[];
    /** Clock skew tolerance in seconds. Default: 30. */
    clockToleranceSeconds?: number;
}

export type AgentJwtVerifier = (token: string) => Promise<AgentPrincipal>;

const extractScopes = (payload: JWTPayload): string[] => {
    // League OAuth2 emits `scopes: string[]` (see AccessTokenEntity::convertToJWT).
    // Be defensive in case a future minter switches to space-separated `scope`.
    const scopesClaim = payload['scopes'];
    if (Array.isArray(scopesClaim)) {
        return scopesClaim.filter((s): s is string => typeof s === 'string');
    }
    const scopeClaim = payload['scope'];
    if (typeof scopeClaim === 'string' && scopeClaim.length > 0) {
        return scopeClaim.split(' ').filter((s) => s.length > 0);
    }
    return [];
};

// jwtVerify enforces audience; we just record the canonical string the
// caller asked for on the principal.
const audienceOf = (payload: JWTPayload, expected: string): string =>
    typeof payload.aud === 'string' ? payload.aud : expected;

export const createAgentJwtVerifier = (options: AgentJwtVerifierOptions): AgentJwtVerifier => {
    const algorithms = options.algorithms ?? ['RS256'];
    const clockTolerance = options.clockToleranceSeconds ?? 30;

    return async (token: string): Promise<AgentPrincipal> => {
        if (typeof token !== 'string' || token.length === 0) {
            throw new AgentJwtVerificationError('empty bearer token');
        }
        let result;
        try {
            result = await jwtVerify(token, options.keyResolver, {
                issuer: options.issuer,
                audience: options.audience,
                algorithms,
                clockTolerance,
                requiredClaims: ['sub', 'exp', 'iat', 'jti'],
            });
        } catch (err) {
            throw new AgentJwtVerificationError('JWT verification failed', err);
        }

        const payload = result.payload;
        const sub = payload.sub;
        if (typeof sub !== 'string' || sub.length === 0) {
            throw new AgentJwtVerificationError('token missing subject');
        }
        const jti = payload.jti;
        if (typeof jti !== 'string' || jti.length === 0) {
            throw new AgentJwtVerificationError('token missing jti');
        }
        const exp = payload.exp;
        if (typeof exp !== 'number') {
            throw new AgentJwtVerificationError('token missing exp');
        }

        return {
            sub,
            fhirUser: sub,
            scopes: extractScopes(payload),
            jti,
            audience: audienceOf(payload, options.audience),
            issuer: payload.iss ?? options.issuer,
            expiresAt: new Date(exp * 1000),
            raw: payload,
        };
    };
};
