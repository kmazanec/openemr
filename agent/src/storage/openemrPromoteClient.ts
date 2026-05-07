/**
 * Agent-side HTTP client for the OpenEMR Tier-3 promote endpoint
 * (`public/snapshot/promote.php`).
 *
 * F.5a wires this from the new `/v1/agent/accept_fact` route: the
 * panel-facing handler reads the extracted artifact, materializes the
 * per-type promotion body, and posts it here using the panel's bearer
 * token. The token must carry the per-type write scope
 * (`user/DiagnosticReport.cs` for lab); the proxy mints with
 * PolicyGate's `accept_fact` action allowlist, so this client
 * forwards what arrives without further scope manipulation.
 *
 * Mirrors the {@link OpenEmrDocumentReferenceClient} shape: typed error
 * variants for HTTP / network / malformed-body, a single bounded retry
 * on transient 5xx, and no token storage (the caller passes per-call).
 */

import { createLogger } from '../observability/logger.js';

const PROMOTE_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/promote.php';

export type PromoteFactType =
    | 'lab'
    | 'allergy'
    | 'medication_statement'
    | 'past_medical_history'
    | 'family_history'
    | 'demographics';

export interface PromoteResult {
    readonly chartRecordUuid: string;
    readonly chartRecordType: string;
    readonly observationUuids: readonly string[];
    readonly idempotentHit: boolean;
}

export interface PromoteCallInput {
    readonly type: PromoteFactType;
    readonly body: Readonly<Record<string, unknown>>;
    readonly token: string;
    readonly siteId: string;
    readonly conversationId?: string;
}

export interface OpenEmrPromoteClient {
    readonly promote: (input: PromoteCallInput) => Promise<PromoteResult>;
}

export class PromoteHttpError extends Error {
    public override readonly name = 'PromoteHttpError';
    public readonly status: number;
    public readonly errorCode: string;
    public readonly bodyPreview: string;

    public constructor(status: number, errorCode: string, bodyPreview: string) {
        super(`promote.php returned HTTP ${String(status)} (${errorCode})`);
        this.status = status;
        this.errorCode = errorCode;
        this.bodyPreview = bodyPreview;
    }
}

export class PromoteNetworkError extends Error {
    public override readonly name = 'PromoteNetworkError';
    public override readonly cause?: unknown;

    public constructor(message: string, cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export class PromoteMalformedResponseError extends Error {
    public override readonly name = 'PromoteMalformedResponseError';
    public readonly bodyPreview: string;

    public constructor(bodyPreview: string) {
        super('promote.php returned malformed body');
        this.bodyPreview = bodyPreview;
    }
}

export interface OpenEmrPromoteClientOptions {
    readonly baseUrl: string;
    readonly fetchImpl?: typeof fetch;
    readonly retryDelayMs?: number;
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

const parseJsonBody = async (res: Response): Promise<{
    readonly body: Record<string, unknown>;
    readonly raw: string;
}> => {
    const raw = await res.text();
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        throw new PromoteMalformedResponseError(raw.slice(0, 256));
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PromoteMalformedResponseError(raw.slice(0, 256));
    }
    return { body: parsed as Record<string, unknown>, raw };
};

export const createOpenEmrPromoteClient = (
    options: OpenEmrPromoteClientOptions,
): OpenEmrPromoteClient => {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;
    const retryDelayMs = options.retryDelayMs ?? 250;
    const logger = createLogger('openemrPromoteClient');

    const buildUrl = (
        type: PromoteFactType,
        siteId: string,
        conversationId: string | undefined,
    ): string => {
        const params = new URLSearchParams({ type, site: siteId });
        if (conversationId !== undefined && conversationId !== '') {
            params.set('conversation', conversationId);
        }
        return `${baseUrl}${PROMOTE_PATH}?${params.toString()}`;
    };

    return {
        async promote(input: PromoteCallInput): Promise<PromoteResult> {
            if (input.token.length === 0) {
                throw new Error('token is required');
            }
            if (input.siteId.length === 0) {
                throw new Error('siteId is required');
            }

            const url = buildUrl(input.type, input.siteId, input.conversationId);
            const body = JSON.stringify(input.body);

            let lastNetworkError: unknown;
            let res: Response | undefined;

            for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
                try {
                    res = await fetchImpl(url, {
                        method: 'POST',
                        headers: {
                            authorization: `Bearer ${input.token}`,
                            accept: 'application/json',
                            'content-type': 'application/json',
                        },
                        body,
                    });
                } catch (err) {
                    lastNetworkError = err;
                    res = undefined;
                    if (attemptNumber === 1) {
                        logger.warn(
                            { attempt: attemptNumber, err: (err as Error).message },
                            'promote endpoint network error; retrying once',
                        );
                        await sleep(retryDelayMs);
                        continue;
                    }
                    break;
                }

                if (res.ok) break;

                if (isTransientStatus(res.status) && attemptNumber === 1) {
                    logger.warn(
                        { attempt: attemptNumber, status: res.status },
                        'promote endpoint transient failure; retrying once',
                    );
                    await sleep(retryDelayMs);
                    continue;
                }
                break;
            }

            if (res === undefined) {
                throw new PromoteNetworkError(
                    'promote.php endpoint unreachable after retry',
                    lastNetworkError,
                );
            }

            if (!res.ok) {
                const preview = await readBodyPreview(res);
                let errorCode = 'unknown';
                try {
                    const parsed = JSON.parse(preview) as unknown;
                    if (
                        parsed !== null
                        && typeof parsed === 'object'
                        && !Array.isArray(parsed)
                        && typeof (parsed as Record<string, unknown>)['error'] === 'string'
                    ) {
                        errorCode = (parsed as Record<string, unknown>)['error'] as string;
                    }
                } catch {
                    // body wasn't JSON; the preview is good enough
                }
                throw new PromoteHttpError(res.status, errorCode, preview);
            }

            const { body: decoded } = await parseJsonBody(res);

            const chartRecordUuid = decoded['chart_record_uuid'];
            const chartRecordType = decoded['chart_record_type'];
            const observationUuidsRaw = decoded['observation_uuids'];
            const idempotentHit = decoded['idempotent_hit'];
            if (
                typeof chartRecordUuid !== 'string'
                || typeof chartRecordType !== 'string'
                || !Array.isArray(observationUuidsRaw)
                || typeof idempotentHit !== 'boolean'
            ) {
                throw new PromoteMalformedResponseError(JSON.stringify(decoded).slice(0, 256));
            }
            const observationUuids: string[] = [];
            for (const uuid of observationUuidsRaw) {
                if (typeof uuid !== 'string') {
                    throw new PromoteMalformedResponseError(
                        JSON.stringify(decoded).slice(0, 256),
                    );
                }
                observationUuids.push(uuid);
            }

            return {
                chartRecordUuid,
                chartRecordType,
                observationUuids,
                idempotentHit,
            };
        },
    };
};
