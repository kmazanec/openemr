import { createLogger } from '../observability/logger.js';

/**
 * Shared HTTP client for agent → OpenEMR snapshot calls.
 *
 * Every tool that calls back into OpenEMR (the briefing-path
 * `loadChartSnapshot` plus the four narrow tools `getPrescriptions`,
 * `getRecentLabs`, `getRecentEncounters`, `getPatientContext`) goes
 * through this helper. Each tool maps 1:1 to a dedicated OpenEMR
 * endpoint, so this module owns the request/retry/error mechanics
 * once and the tools stay focused on URL construction and decoding.
 *
 * Auth failures (401/403) are NOT retried — they signal a
 * misconfigured trust boundary, and a second attempt would just hide
 * the misconfiguration. 5xx and network errors retry once with a
 * short backoff.
 */

export class AgentHttpError extends Error {
    public override readonly name = 'AgentHttpError';
    public readonly status: number;
    public readonly bodyPreview: string;

    public constructor(status: number, bodyPreview: string) {
        super(`OpenEMR endpoint returned HTTP ${String(status)}`);
        this.status = status;
        this.bodyPreview = bodyPreview;
    }
}

export class AgentNetworkError extends Error {
    public override readonly name = 'AgentNetworkError';
    public override readonly cause?: unknown;

    public constructor(message: string, cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export interface AgentHttpClientOptions {
    /** Injectable for tests; defaults to the global fetch. */
    readonly fetchImpl?: typeof fetch;
    /** Sleep between the failed attempt and the retry. Default 250ms. */
    readonly retryDelayMs?: number;
    /** Logger component name. Lets each tool tag its own log lines. */
    readonly loggerName?: string;
}

export interface AgentHttpGetInput {
    readonly url: string;
    readonly token: string;
}

export interface AgentHttpClient {
    /**
     * GET `input.url` with a bearer token. Returns the parsed JSON
     * body on success. Throws {@link AgentHttpError} on a non-OK
     * status (after retrying once on 5xx) and
     * {@link AgentNetworkError} on a fetch-level failure (after
     * retrying once).
     */
    get(input: AgentHttpGetInput): Promise<unknown>;
}

const isTransientStatus = (status: number): boolean => status >= 500 && status < 600;

const sleep = (ms: number): Promise<void> =>
    ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const readBodyPreview = async (res: Response): Promise<string> => {
    try {
        const text = await res.text();
        return text.slice(0, 256);
    } catch {
        return '';
    }
};

export const createAgentHttpClient = (options: AgentHttpClientOptions = {}): AgentHttpClient => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const retryDelayMs = options.retryDelayMs ?? 250;
    const logger = createLogger(options.loggerName ?? 'agentHttp');

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
        async get(input: AgentHttpGetInput): Promise<unknown> {
            const startedAt = Date.now();

            let lastNetworkError: unknown;
            let res: Response | undefined;

            for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
                try {
                    res = await attempt(input.url, input.token);
                } catch (err) {
                    lastNetworkError = err;
                    res = undefined;
                    if (attemptNumber === 1) {
                        logger.warn(
                            { attempt: attemptNumber, err: (err as Error).message },
                            'agent endpoint network error; retrying once',
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
                        'agent endpoint transient failure; retrying once',
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
                    'agent endpoint network error after retry',
                );
                throw new AgentNetworkError(
                    'OpenEMR endpoint unreachable after retry',
                    lastNetworkError,
                );
            }

            if (!res.ok) {
                const bodyPreview = await readBodyPreview(res);
                logger.error(
                    { latencyMs, status: res.status },
                    'agent endpoint returned error status',
                );
                throw new AgentHttpError(res.status, bodyPreview);
            }

            logger.info(
                { latencyMs, status: res.status },
                'agent endpoint ok',
            );
            return await res.json();
        },
    };
};
