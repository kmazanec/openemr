/**
 * Fallback fetch path for chart documents that aren't in the Spaces
 * canonical bucket — typically because they were uploaded through
 * OpenEMR's legacy Documents UI rather than through the agent's chat
 * panel. Streams the bytes by uuid from `public/snapshot/document-bytes.php`,
 * which is restricted to Clinical-Copilot-categorized documents.
 *
 * The pipeline's rasterize node calls this only when its primary
 * Spaces lookup raises a NotFound — both surfaces remain
 * authoritative; the fallback is purely additive coverage for the
 * legacy-UI path.
 */

import { createLogger } from '../observability/logger.js';

const DOCUMENT_BYTES_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/document-bytes.php';

export class CanonicalDocumentFallbackError extends Error {
    public readonly status: number | null;
    public readonly bodyPreview: string;
    public constructor(message: string, status: number | null, bodyPreview = '') {
        super(message);
        this.name = 'CanonicalDocumentFallbackError';
        this.status = status;
        this.bodyPreview = bodyPreview;
    }
}

export class CanonicalDocumentFallbackNotFound extends CanonicalDocumentFallbackError {
    public constructor(message: string) {
        super(message, 404);
        this.name = 'CanonicalDocumentFallbackNotFound';
    }
}

export class CanonicalDocumentFallbackNetworkError extends CanonicalDocumentFallbackError {
    public constructor(message: string) {
        super(message, null);
        this.name = 'CanonicalDocumentFallbackNetworkError';
    }
}

export interface CanonicalDocumentFallbackInput {
    readonly documentUuid: string;
    readonly pid: number;
    readonly token: string;
    readonly siteId: string;
    readonly conversationId?: string;
}

export interface CanonicalDocumentFallbackClient {
    /**
     * Fetch the canonical bytes for a chart document by uuid.
     * Throws {@link CanonicalDocumentFallbackNotFound} on 404
     * (document missing or not in the Clinical Copilot category
     * subtree), {@link CanonicalDocumentFallbackNetworkError} on a
     * fetch-level failure, and a generic
     * {@link CanonicalDocumentFallbackError} on any other non-2xx.
     */
    readonly readBytes: (input: CanonicalDocumentFallbackInput) => Promise<Buffer>;
}

export interface CanonicalDocumentFallbackClientOptions {
    readonly baseUrl: string;
    /** Injectable for tests; defaults to the global fetch. */
    readonly fetchImpl?: typeof fetch;
}

const buildUrl = (baseUrl: string, input: CanonicalDocumentFallbackInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        uuid: input.documentUuid,
        ...(input.conversationId !== undefined ? { conversation: input.conversationId } : {}),
    });
    return `${baseUrl.replace(/\/+$/, '')}${DOCUMENT_BYTES_PATH}?${params.toString()}`;
};

const readBodyPreview = async (res: Response): Promise<string> => {
    try {
        const text = await res.text();
        return text.slice(0, 256);
    } catch {
        return '';
    }
};

export const createCanonicalDocumentFallbackClient = (
    options: CanonicalDocumentFallbackClientOptions,
): CanonicalDocumentFallbackClient => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const logger = createLogger('canonicalDocumentFallback');

    return {
        async readBytes(input): Promise<Buffer> {
            if (!Number.isInteger(input.pid) || input.pid <= 0) {
                throw new Error('pid must be a positive integer');
            }
            if (input.siteId.length === 0) {
                throw new Error('siteId is required');
            }
            if (input.documentUuid.length === 0) {
                throw new Error('documentUuid is required');
            }

            const url = buildUrl(options.baseUrl, input);
            let res: Response;
            try {
                res = await fetchImpl(url, {
                    method: 'GET',
                    headers: {
                        authorization: `Bearer ${input.token}`,
                        accept: 'application/octet-stream, */*',
                    },
                });
            } catch (err) {
                logger.warn(
                    { err: (err as Error).message },
                    'document-bytes fetch network error',
                );
                throw new CanonicalDocumentFallbackNetworkError(
                    `document-bytes fetch failed: ${(err as Error).message}`,
                );
            }

            if (res.status === 404) {
                throw new CanonicalDocumentFallbackNotFound('document not found');
            }

            if (!res.ok) {
                const preview = await readBodyPreview(res);
                throw new CanonicalDocumentFallbackError(
                    `document-bytes returned non-2xx: ${String(res.status)}`,
                    res.status,
                    preview,
                );
            }

            const arrayBuffer = await res.arrayBuffer();
            return Buffer.from(arrayBuffer);
        },
    };
};
