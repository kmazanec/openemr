import { createLogger } from '../observability/logger.js';

/**
 * HTTP client that calls the OpenEMR-side agent-callback snapshot endpoint
 * (Phase 2.6 / `public/snapshot.php`). The trust direction is "agent → OpenEMR
 * with the JWT the agent already holds", so the bearer token is supplied by
 * the caller per request, not stored on the client.
 *
 * The client intentionally returns the raw decoded JSON body — the typed
 * decoder lives in `src/snapshot/` and runs once per request, not once per
 * tool, so we can fan out four tools without paying parse cost N times.
 */

const SNAPSHOT_PATH = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot.php';

export type SnapshotCategory = 'diagnosis' | 'medication' | 'allergy' | 'lab' | 'encounter' | 'appointment';

export interface SnapshotFetchInput {
    readonly pid: number;
    readonly categories: readonly SnapshotCategory[];
    readonly token: string;
    /**
     * Site the snapshot endpoint must run against. Becomes `?site=…` on
     * the request URL — OpenEMR's `globals.php` resolves the site from
     * that query param when no session cookie is present (the agent has
     * no session). Comes from the verified JWT issuer in production.
     */
    readonly siteId: string;
}

export interface SnapshotClient {
    fetchSnapshot(input: SnapshotFetchInput): Promise<unknown>;
}

export interface SnapshotClientOptions {
    readonly baseUrl: string;
    /** Injectable for tests; defaults to the global fetch. */
    readonly fetchImpl?: typeof fetch;
    /** Sleep between the failed attempt and the retry. Default 250ms. */
    readonly retryDelayMs?: number;
}

export class SnapshotHttpError extends Error {
    public override readonly name = 'SnapshotHttpError';
    public readonly status: number;
    public readonly bodyPreview: string;

    public constructor(status: number, bodyPreview: string) {
        super(`OpenEMR snapshot endpoint returned HTTP ${String(status)}`);
        this.status = status;
        this.bodyPreview = bodyPreview;
    }
}

export class SnapshotNetworkError extends Error {
    public override readonly name = 'SnapshotNetworkError';
    public override readonly cause?: unknown;

    public constructor(message: string, cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

const isTransientStatus = (status: number): boolean => status >= 500 && status < 600;

const sleep = (ms: number): Promise<void> =>
    ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const readBodyPreview = async (res: Response): Promise<string> => {
    try {
        const text = await res.text();
        // Cap to keep error logs sane; PHI shouldn't appear in error bodies, but
        // even error-shaped JSON can echo identifiers we'd rather not amplify.
        return text.slice(0, 256);
    } catch {
        return '';
    }
};

export const createSnapshotClient = (options: SnapshotClientOptions): SnapshotClient => {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;
    const retryDelayMs = options.retryDelayMs ?? 250;
    const logger = createLogger('snapshotClient');

    const buildUrl = (
        pid: number,
        categories: readonly SnapshotCategory[],
        siteId: string,
    ): string => {
        const params = new URLSearchParams({
            site: siteId,
            pid: String(pid),
            categories: categories.join(','),
        });
        return `${baseUrl}${SNAPSHOT_PATH}?${params.toString()}`;
    };

    const attempt = async (url: string, token: string): Promise<Response> => {
        return await fetchImpl(url, {
            method: 'GET',
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/json',
            },
        });
    };

    return {
        async fetchSnapshot(input: SnapshotFetchInput): Promise<unknown> {
            if (!Number.isInteger(input.pid) || input.pid <= 0) {
                throw new Error('pid must be a positive integer');
            }
            if (input.categories.length === 0) {
                throw new Error('categories list is required');
            }
            if (input.siteId.length === 0) {
                throw new Error('siteId is required');
            }

            const url = buildUrl(input.pid, input.categories, input.siteId);
            const startedAt = Date.now();

            let lastNetworkError: unknown;
            let res: Response | undefined;

            for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
                try {
                    res = await attempt(url, input.token);
                } catch (err) {
                    lastNetworkError = err;
                    res = undefined;
                    if (attemptNumber === 1) {
                        logger.warn(
                            { attempt: attemptNumber, err: (err as Error).message },
                            'snapshot endpoint network error; retrying once',
                        );
                        await sleep(retryDelayMs);
                        continue;
                    }
                    break;
                }

                if (res.ok) {
                    break;
                }

                if (isTransientStatus(res.status) && attemptNumber === 1) {
                    logger.warn(
                        { attempt: attemptNumber, status: res.status },
                        'snapshot endpoint transient failure; retrying once',
                    );
                    await sleep(retryDelayMs);
                    continue;
                }

                // Non-transient failure: stop here and report.
                break;
            }

            const latencyMs = Date.now() - startedAt;

            if (res === undefined) {
                logger.error(
                    { latencyMs, err: (lastNetworkError as Error | undefined)?.message },
                    'snapshot endpoint network error after retry',
                );
                throw new SnapshotNetworkError(
                    'OpenEMR snapshot endpoint unreachable after retry',
                    lastNetworkError,
                );
            }

            if (!res.ok) {
                const bodyPreview = await readBodyPreview(res);
                logger.error(
                    { latencyMs, status: res.status },
                    'snapshot endpoint returned error status',
                );
                throw new SnapshotHttpError(res.status, bodyPreview);
            }

            const body: unknown = await res.json();
            logger.info(
                {
                    latencyMs,
                    status: res.status,
                    pid: input.pid,
                    categories: input.categories,
                },
                'snapshot endpoint ok',
            );
            return body;
        },
    };
};
