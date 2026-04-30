import { createRemoteJWKSet, importJWK, type jwtVerify, type JWK, type KeyLike } from 'jose';

/**
 * A key resolver matches the signature `jose` expects for `jwtVerify`'s
 * second argument: it inspects the protected header and returns the
 * verification key. Hand-rolling this seam (instead of always passing
 * `createRemoteJWKSet` directly) lets tests inject a static JWKS without
 * standing up an HTTP server.
 */
export type KeyResolver = Parameters<typeof jwtVerify>[1];

export interface RemoteJwksOptions {
    jwksUri: URL;
    /** Cool-down between refetches when a kid is missing. Default 30s. */
    cooldownDuration?: number;
    /** Time-to-live for cached JWKS. Default 10 minutes. */
    cacheMaxAge?: number;
    /** Per-fetch timeout. Default 5s. */
    timeoutDuration?: number;
}

/**
 * Build a key resolver backed by a remote JWKS endpoint (OpenEMR's
 * `/oauth2/{site}/jwk`). The library handles caching, kid rotation, and
 * refetch on cache miss.
 */
export const createRemoteKeyResolver = (options: RemoteJwksOptions): KeyResolver => {
    return createRemoteJWKSet(options.jwksUri, {
        cooldownDuration: options.cooldownDuration ?? 30_000,
        cacheMaxAge: options.cacheMaxAge ?? 600_000,
        timeoutDuration: options.timeoutDuration ?? 5_000,
    });
};

/**
 * Build a key resolver from a static set of JWKs. Used by tests and by
 * the `AGENT_JWT_PUBLIC_KEY` static-key fallback (a single JWK).
 */
export const createLocalKeyResolver = (jwks: JWK[]): KeyResolver => {
    const cache = new Map<string, Promise<KeyLike | Uint8Array>>();
    return async (header) => {
        const kid = header.kid;
        // Fall back to the first JWK when the token has no kid (e.g. a
        // single-key static-PEM deployment).
        const jwk = kid !== undefined ? jwks.find((k) => k.kid === kid) : jwks[0];
        if (!jwk) {
            throw new Error(`no JWK matches kid="${kid ?? '<unset>'}"`);
        }
        const key = jwk.kid ?? '__default__';
        let cached = cache.get(key);
        if (!cached) {
            cached = importJWK(jwk, jwk.alg ?? header.alg);
            cache.set(key, cached);
        }
        return cached;
    };
};
