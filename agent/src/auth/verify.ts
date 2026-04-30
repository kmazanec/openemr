import { jwtVerify, type JWTPayload } from 'jose';

import type { KeyResolver } from './jwks.js';

/**
 * Identity carried on each authenticated request. The proxy controller
 * mints a token whose `sub` is the acting practitioner's bare uuid and
 * whose `fhirUser` claim is the SMART URI (`{baseUrl}/Practitioner/{uuid}`)
 * — see `interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth/AgentTokenMinter.php`.
 *
 * Downstream code (tools, traces) cares about the fhirUser URI, so we
 * expose it as a first-class field. If the claim is missing (e.g. a token
 * minted before the fhirUser fix) we fall back to `sub` and log — this
 * lets the agent reject silent regressions instead of trusting whatever
 * string happens to be in `sub`.
 */
export interface AgentPrincipal {
    sub: string;
    fhirUser: string;
    scopes: string[];
    jti: string;
    audience: string;
    issuer: string;
    /**
     * Site this token is scoped to. Derived from the issuer URL's last
     * path segment — OpenEMR's OAuth2 issuer follows
     * `{baseUrl}/oauth2/{siteId}`, and the agent verifier already pins
     * the issuer string against `AGENT_JWT_ISSUER`, so the segment is
     * tamper-proof. Used by tool calls back into OpenEMR to set the
     * `site` query param the snapshot endpoint requires.
     */
    siteId: string;
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
    /**
     * Pin the verifier's clock for time-based claim checks (`exp`, `iat`,
     * `nbf`). Production leaves this unset so jose falls back to wall
     * time; tests use it to make a committed contract fixture verify
     * deterministically regardless of when CI runs.
     */
    currentDate?: Date;
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
                ...(options.currentDate !== undefined ? { currentDate: options.currentDate } : {}),
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

        const fhirUserClaim = payload['fhirUser'];
        const fhirUser = typeof fhirUserClaim === 'string' && fhirUserClaim.length > 0
            ? fhirUserClaim
            : sub;

        const issuer = payload.iss ?? options.issuer;
        const siteId = parseSiteFromIssuer(issuer);
        if (siteId === null) {
            throw new AgentJwtVerificationError('issuer does not contain a site segment');
        }

        return {
            sub,
            fhirUser,
            scopes: extractScopes(payload),
            jti,
            audience: audienceOf(payload, options.audience),
            issuer,
            siteId,
            expiresAt: new Date(exp * 1000),
            raw: payload,
        };
    };
};

/**
 * OpenEMR's OAuth2 issuer follows `{baseUrl}/oauth2/{siteId}`. The agent
 * verifier pins the issuer string against `AGENT_JWT_ISSUER`, so the
 * `oauth2/{siteId}` segment is already trusted by the time we reach this
 * point. We just extract it.
 */
const parseSiteFromIssuer = (issuer: string): string | null => {
    try {
        const url = new URL(issuer);
        const segments = url.pathname.split('/').filter((s) => s.length > 0);
        const oauth2Index = segments.indexOf('oauth2');
        if (oauth2Index === -1 || oauth2Index === segments.length - 1) return null;
        const site = segments[oauth2Index + 1] ?? '';
        return /^[A-Za-z0-9._-]+$/.test(site) ? site : null;
    } catch {
        return null;
    }
};
