/**
 * §B.3 Pipeline node 1 — `rasterize`.
 *
 * Read canonical document bytes from DigitalOcean Spaces; if PDF, render
 * each page to PNG and upload to the transient prefix; mint single-call
 * ≤5-min-TTL signed-GET URLs the next node (`vision`) consumes.
 *
 * Pre-flight cost-cap: per `W2_ARCHITECTURE.md` §"Failure Modes" row
 * "Document over $1 cost cap", refuse before rendering when
 * `pageCount × estimatedDollarsPerPage > 1.00 USD`. Cheap probe via
 * `Rasterizer.pageCount` so we do not spend CPU on a doc we will not
 * extract from.
 *
 * Image-typed canonical objects (PNG/JPEG/TIFF, per W2 §"MIME
 * enforcement") skip rendering — the canonical object itself is already
 * a single page. We mint a signed-GET URL on the canonical key directly
 * rather than uploading a transient duplicate. The transient prefix and
 * 24h-lifecycle backstop only matter for re-rendered PDFs.
 *
 * Cleanup of transient PNGs is the EXIT node's responsibility (§B.7);
 * Spaces' 24h transient-prefix lifecycle policy is the backstop.
 */

import type { Logger } from 'pino';

import { keyForCanonical, keyForTransientPage, type SpacesClient } from '../../storage/spaces.js';
import { type PageImage, type PipelineError, type PipelineState } from '../state.js';
import { type Rasterizer } from '../rasterizer.js';

/**
 * Vision-call cost estimate per page. Sonnet 4.x charges per input
 * image based on tokens-equivalent; at ~1.6k input tokens per page at
 * default vision resolution and $3/MTok input, a page is ≈ $0.005. We
 * use $0.005/page for the pre-flight pessimistic ceiling — the real
 * post-call cost lands in the per-extraction trace metadata.
 *
 * At $0.005/page and a $1.00/doc cap, pre-flight allows up to 200 pages.
 */
export const ESTIMATED_DOLLARS_PER_PAGE = 0.005;
export const PER_DOCUMENT_DOLLAR_CAP = 1.0;

/**
 * Signed-URL TTL we ask Spaces for. Stays ≤ 5 min per `WEEK2-PRESEARCH.md`
 * §W2-4 single-call/short-TTL rule.
 */
export const SIGNED_URL_TTL_SEC = 300;

export interface RasterizeDeps {
    /** Read canonical document bytes; mints transient signed URLs. */
    readonly openemrSpaces: SpacesClient;
    /** Mints signed-GET URLs the vision call dereferences. */
    readonly agentSpaces: SpacesClient;
    readonly rasterizer: Rasterizer;
    readonly transientPrefix: string;
    readonly logger: Logger;
    /**
     * The file extension of the canonical object as stored in Spaces.
     * `keyForCanonical` requires it; passed in from the pipeline
     * envelope (the upload endpoint records it on Tier-1 write).
     * `pdf` triggers rendering; `png` / `jpg` / `jpeg` / `tiff` pass
     * through as a single page.
     */
    readonly canonicalExt: string;
    /**
     * Clock injection per `CLAUDE.md` "Clock injection (PSR-20)".
     * Used to stamp `expiresAt` on each PageImage for audit/debug.
     */
    readonly now?: () => Date;
}

const fail = (state: PipelineState, error: PipelineError): Partial<PipelineState> => ({
    status: 'failed',
    errors: [...state.errors, error],
});

const isImageExt = (ext: string): boolean => {
    const e = ext.replace(/^\.+/, '').toLowerCase();
    return e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'tiff' || e === 'tif';
};

const isPdfExt = (ext: string): boolean => ext.replace(/^\.+/, '').toLowerCase() === 'pdf';

export const rasterize = async (
    state: PipelineState,
    deps: RasterizeDeps,
): Promise<Partial<PipelineState>> => {
    const { openemrSpaces, agentSpaces, rasterizer, transientPrefix, logger, canonicalExt } = deps;
    const now = deps.now ?? ((): Date => new Date());

    const canonicalKey = keyForCanonical(state.pid, state.documentUuid, canonicalExt);

    let canonicalBytes: Buffer;
    try {
        const obj = await openemrSpaces.getObject({ key: canonicalKey });
        canonicalBytes = obj.body;
    } catch (err) {
        logger.error(
            { documentUuid: state.documentUuid, canonicalKey, err: String(err) },
            'rasterize: failed to fetch canonical document bytes',
        );
        return fail(state, {
            code: 'storage-unreachable',
            message: 'failed to read canonical document bytes from Spaces',
        });
    }

    if (isImageExt(canonicalExt)) {
        // Pre-flight: a single image counts as one page; never trips the cap.
        try {
            const signedUrl = await agentSpaces.presignGetUrl(canonicalKey, SIGNED_URL_TTL_SEC);
            const expiresAt = new Date(now().getTime() + SIGNED_URL_TTL_SEC * 1_000).toISOString();
            const page: PageImage = { pageNum: 1, key: canonicalKey, signedUrl, expiresAt };
            logger.info(
                { documentUuid: state.documentUuid, pageCount: 1, mode: 'image-passthrough' },
                'rasterize: image canonical object passed through as single page',
            );
            return { pages: [page], status: 'rasterized' };
        } catch (err) {
            logger.error(
                { documentUuid: state.documentUuid, err: String(err) },
                'rasterize: failed to mint signed URL for image canonical object',
            );
            return fail(state, {
                code: 'storage-unreachable',
                message: 'failed to mint signed URL for canonical image',
            });
        }
    }

    if (!isPdfExt(canonicalExt)) {
        return fail(state, {
            code: 'rasterize_failed',
            message: `unsupported canonical extension '${canonicalExt}'`,
        });
    }

    let pageCount: number;
    try {
        pageCount = await rasterizer.pageCount(canonicalBytes);
    } catch (err) {
        logger.error(
            { documentUuid: state.documentUuid, err: String(err) },
            'rasterize: failed to read PDF page count',
        );
        return fail(state, {
            code: 'rasterize_failed',
            message: 'unable to read PDF page count (corrupted bytes?)',
        });
    }

    if (pageCount <= 0) {
        return fail(state, {
            code: 'rasterize_failed',
            message: 'PDF contains zero pages',
        });
    }

    const estimatedCost = pageCount * ESTIMATED_DOLLARS_PER_PAGE;
    if (estimatedCost > PER_DOCUMENT_DOLLAR_CAP) {
        logger.warn(
            {
                documentUuid: state.documentUuid,
                pageCount,
                estimatedCost,
                cap: PER_DOCUMENT_DOLLAR_CAP,
            },
            'rasterize: per-document cost cap would be exceeded; refusing',
        );
        return fail(state, {
            code: 'cost-cap-exceeded',
            message: `document too large for automatic extraction (${pageCount} pages × $${ESTIMATED_DOLLARS_PER_PAGE.toFixed(3)}/page > $${PER_DOCUMENT_DOLLAR_CAP.toFixed(2)} cap)`,
            details: { pageCount, estimatedCost, cap: PER_DOCUMENT_DOLLAR_CAP },
        });
    }

    let pngs: readonly { pageNum: number; pngBytes: Buffer }[];
    try {
        pngs = await rasterizer.rasterize(canonicalBytes);
    } catch (err) {
        logger.error(
            { documentUuid: state.documentUuid, pageCount, err: String(err) },
            'rasterize: rasterizer threw',
        );
        return fail(state, {
            code: 'rasterize_failed',
            message: 'PDF rasterization failed',
        });
    }

    const pages: PageImage[] = [];
    for (const { pageNum, pngBytes } of pngs) {
        const key = keyForTransientPage(transientPrefix, state.documentUuid, pageNum);
        try {
            await openemrSpaces.putObject({ key, body: pngBytes, contentType: 'image/png' });
        } catch (err) {
            logger.error(
                { documentUuid: state.documentUuid, key, err: String(err) },
                'rasterize: failed to upload page PNG',
            );
            return fail(state, {
                code: 'storage-unreachable',
                message: 'failed to upload rasterized page to transient prefix',
            });
        }

        let signedUrl: string;
        try {
            signedUrl = await agentSpaces.presignGetUrl(key, SIGNED_URL_TTL_SEC);
        } catch (err) {
            logger.error(
                { documentUuid: state.documentUuid, key, err: String(err) },
                'rasterize: failed to mint signed URL for page',
            );
            return fail(state, {
                code: 'storage-unreachable',
                message: 'failed to mint signed URL for rasterized page',
            });
        }

        const expiresAt = new Date(now().getTime() + SIGNED_URL_TTL_SEC * 1_000).toISOString();
        pages.push({ pageNum, key, signedUrl, expiresAt });
    }

    logger.info(
        {
            documentUuid: state.documentUuid,
            pageCount,
            estimatedCost,
        },
        'rasterize: PDF rasterized + uploaded to transient prefix',
    );
    return { pages, status: 'rasterized' };
};
