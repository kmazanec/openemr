/**
 * §B.7 — agent-side HTTP client for the OpenEMR Tier-1 endpoint
 * (`public/snapshot/document_reference.php`).
 *
 * The persist node calls this once per extraction to record that the
 * canonical document bytes (already in DigitalOcean Spaces) belong to
 * patient `pid` under doc-type `lab_pdf` or `intake_form`. The endpoint
 * inserts a `documents` row + categorizes it, then returns the
 * lowercase 36-char DocumentReference UUID we persist on the
 * `extraction_artifacts.document_uuid` column.
 *
 * The client mirrors `snapshotClient.ts`'s shape — single-call retry
 * on transient errors; the bearer token is supplied by the caller per
 * call (no token storage on the client). Error variants are typed so
 * the persist node can distinguish "OpenEMR refused" from "network
 * blew up" and return the right `PipelineError` code.
 */

import { createLogger } from '../observability/logger.js';

const TIER1_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/document_reference.php';

export interface WriteDocumentReferenceInput {
    readonly pid: number;
    readonly docType: 'lab_pdf' | 'intake_form';
    readonly spacesUrl: string;
    readonly mimeType: string;
    readonly filename: string;
    readonly token: string;
    readonly siteId: string;
    readonly conversationId?: string;
}

export interface WriteDocumentReferenceResult {
    readonly documentUuid: string;
}

export interface OpenEmrDocumentReferenceClient {
    readonly writeDocumentReference: (
        input: WriteDocumentReferenceInput,
    ) => Promise<WriteDocumentReferenceResult>;
}

export class DocumentReferenceHttpError extends Error {
    public override readonly name = 'DocumentReferenceHttpError';
    public readonly status: number;
    public readonly bodyPreview: string;

    public constructor(status: number, bodyPreview: string) {
        super(`OpenEMR document_reference endpoint returned HTTP ${String(status)}`);
        this.status = status;
        this.bodyPreview = bodyPreview;
    }
}

export class DocumentReferenceNetworkError extends Error {
    public override readonly name = 'DocumentReferenceNetworkError';
    public override readonly cause?: unknown;

    public constructor(message: string, cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export class DocumentReferenceMalformedResponseError extends Error {
    public override readonly name = 'DocumentReferenceMalformedResponseError';
    public readonly bodyPreview: string;

    public constructor(bodyPreview: string) {
        super('OpenEMR document_reference endpoint returned malformed body');
        this.bodyPreview = bodyPreview;
    }
}

export interface OpenEmrDocumentReferenceClientOptions {
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

export const createOpenEmrDocumentReferenceClient = (
    options: OpenEmrDocumentReferenceClientOptions,
): OpenEmrDocumentReferenceClient => {
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;
    const retryDelayMs = options.retryDelayMs ?? 250;
    const logger = createLogger('openemrDocumentReferenceClient');

    const buildUrl = (siteId: string, conversationId?: string): string => {
        const params = new URLSearchParams({ site: siteId });
        if (conversationId !== undefined && conversationId !== '') {
            params.set('conversation', conversationId);
        }
        return `${baseUrl}${TIER1_PATH}?${params.toString()}`;
    };

    const buildBody = (input: WriteDocumentReferenceInput): string =>
        JSON.stringify({
            pid: input.pid,
            doc_type: input.docType,
            spaces_url: input.spacesUrl,
            mime_type: input.mimeType,
            filename: input.filename,
        });

    return {
        async writeDocumentReference(
            input: WriteDocumentReferenceInput,
        ): Promise<WriteDocumentReferenceResult> {
            if (!Number.isInteger(input.pid) || input.pid <= 0) {
                throw new Error('pid must be a positive integer');
            }
            if (input.siteId.length === 0) {
                throw new Error('siteId is required');
            }
            if (input.token.length === 0) {
                throw new Error('token is required');
            }

            const url = buildUrl(input.siteId, input.conversationId);
            const body = buildBody(input);

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
                            'document_reference endpoint network error; retrying once',
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
                        'document_reference endpoint transient failure; retrying once',
                    );
                    await sleep(retryDelayMs);
                    continue;
                }
                break;
            }

            if (res === undefined) {
                throw new DocumentReferenceNetworkError(
                    'OpenEMR document_reference endpoint unreachable after retry',
                    lastNetworkError,
                );
            }

            if (!res.ok) {
                const bodyPreview = await readBodyPreview(res);
                throw new DocumentReferenceHttpError(res.status, bodyPreview);
            }

            const parsed: unknown = await res.json();
            if (
                parsed === null
                || typeof parsed !== 'object'
                || !('document_uuid' in parsed)
                || typeof parsed.document_uuid !== 'string'
            ) {
                throw new DocumentReferenceMalformedResponseError(
                    JSON.stringify(parsed).slice(0, 256),
                );
            }
            const documentUuid = parsed.document_uuid;
            if (documentUuid === '') {
                throw new DocumentReferenceMalformedResponseError('empty document_uuid');
            }

            logger.info(
                { pid: input.pid, docType: input.docType, documentUuid },
                'document_reference endpoint ok',
            );
            return { documentUuid };
        },
    };
};
