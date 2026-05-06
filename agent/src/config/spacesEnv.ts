/**
 * §B.2 DigitalOcean Spaces env parser. Two IAM identities flow through
 * here — OpenEMR (read+write across the bucket prefix) and the agent
 * service (read-only on the transient prefix). Both must be present at
 * boot; the pipeline cannot run with one half configured.
 *
 * Per `CLAUDE.md` "Parse, don't validate": this is the system boundary
 * where raw `process.env` becomes a typed, frozen `SpacesEnv` DTO. After
 * `parseSpacesEnv` returns, the rest of the agent works with the DTO
 * and never re-reads the env directly.
 */

export const DEFAULT_TRANSIENT_PREFIX = 'transient';

export interface SpacesCredentials {
    readonly accessKey: string;
    readonly secretKey: string;
}

export interface SpacesEnv {
    readonly bucket: string;
    readonly region: string;
    /** Computed from `region`: `https://<region>.digitaloceanspaces.com`. */
    readonly endpoint: string;
    readonly openemr: SpacesCredentials;
    readonly agent: SpacesCredentials;
    readonly transientPrefix: string;
}

export class SpacesEnvError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'SpacesEnvError';
    }
}

const requireString = (raw: Record<string, string | undefined>, key: string): string => {
    const value = raw[key];
    if (value === undefined || value.trim().length === 0) {
        throw new SpacesEnvError(`${key} is required and must be non-empty`);
    }
    return value.trim();
};

const optionalString = (
    raw: Record<string, string | undefined>,
    key: string,
    fallback: string,
): string => {
    const value = raw[key];
    if (value === undefined || value.trim().length === 0) return fallback;
    return value.trim();
};

export const parseSpacesEnv = (
    raw: Record<string, string | undefined> = process.env,
): SpacesEnv => {
    const bucket = requireString(raw, 'SPACES_BUCKET');
    const region = requireString(raw, 'SPACES_REGION');
    const transientPrefix = optionalString(raw, 'SPACES_TRANSIENT_PREFIX', DEFAULT_TRANSIENT_PREFIX);
    if (transientPrefix.includes('/')) {
        throw new SpacesEnvError(
            "SPACES_TRANSIENT_PREFIX must not contain '/'; key helpers add the separator",
        );
    }

    const openemr: SpacesCredentials = Object.freeze({
        accessKey: requireString(raw, 'SPACES_OPENEMR_KEY'),
        secretKey: requireString(raw, 'SPACES_OPENEMR_SECRET'),
    });
    const agent: SpacesCredentials = Object.freeze({
        accessKey: requireString(raw, 'SPACES_AGENT_KEY'),
        secretKey: requireString(raw, 'SPACES_AGENT_SECRET'),
    });

    return Object.freeze({
        bucket,
        region,
        endpoint: `https://${region}.digitaloceanspaces.com`,
        openemr,
        agent,
        transientPrefix,
    });
};

/**
 * Optional-mode parser for boot paths that should tolerate a missing
 * Spaces config — primarily the deploy-time migration runner, where
 * the agent boots only to apply schema changes and exit. Returns:
 *
 *  - `null` when ALL required keys (`SPACES_BUCKET`, `SPACES_REGION`,
 *    `SPACES_OPENEMR_KEY`, `SPACES_OPENEMR_SECRET`, `SPACES_AGENT_KEY`,
 *    `SPACES_AGENT_SECRET`) are absent or empty.
 *  - The parsed DTO when ALL required keys are present.
 *  - Throws via `parseSpacesEnv` when SOME but not all are set —
 *    half-configured Spaces is almost always a typo or a missing
 *    secret in the deploy environment, and silently disabling
 *    uploads on a partial config would mask that bug.
 */
const SPACES_REQUIRED_KEYS = [
    'SPACES_BUCKET',
    'SPACES_REGION',
    'SPACES_OPENEMR_KEY',
    'SPACES_OPENEMR_SECRET',
    'SPACES_AGENT_KEY',
    'SPACES_AGENT_SECRET',
] as const;

export const tryParseSpacesEnv = (
    raw: Record<string, string | undefined> = process.env,
): SpacesEnv | null => {
    const presence = SPACES_REQUIRED_KEYS.map((k) => {
        const v = raw[k];
        return v !== undefined && v.trim().length > 0;
    });
    if (presence.every((p) => !p)) return null;
    return parseSpacesEnv(raw);
};
