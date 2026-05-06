/**
 * §B.3 Rasterizer interface — PDF bytes → page PNG bytes.
 *
 * `WEEK2-PRESEARCH.md` §Q4b lists three realistic options:
 *   - `pdf2pic` — wraps GraphicsMagick (system `gm` binary).
 *   - `pdfjs-dist` + `node-canvas` — manual stitching, more code.
 *   - `pdf-img-convert` — single-call API, depends on `pdfjs-dist` and
 *     `canvas` (both pulled as transitive deps; `canvas` ships prebuilt
 *     binaries for Linux/macOS/Windows on Node ≥ 18).
 *
 * Choice: **`pdf-img-convert`**. Rationale:
 *   - No system-level binary requirement (vs `pdf2pic` → GraphicsMagick),
 *     so CI runners install it from npm with no apt step.
 *   - One-call API matching this interface exactly; thin wrapper.
 *   - Returns Buffer / Uint8Array of PNG bytes per page, which is what
 *     the rasterize node uploads to Spaces verbatim.
 *
 * The `Rasterizer` interface is the seam: tests inject a stub, prod
 * wires `createPdfImgConvertRasterizer()`. A future swap to a different
 * library is a single-file change here.
 *
 * `pageCount(pdfBytes)` is a separate method so the rasterize node can
 * pre-flight the per-document cost cap (`pageCount × estimatedTokens >
 * $1` → refuse) *before* spending CPU on rendering.
 */

export interface RasterizedPage {
    readonly pageNum: number;
    readonly pngBytes: Buffer;
}

export interface Rasterizer {
    /**
     * Cheap page-count probe used by the cost-cap pre-flight. Should
     * not render any pages.
     */
    readonly pageCount: (pdfBytes: Buffer) => Promise<number>;
    /**
     * Render every page to PNG and return them in page order (1-based).
     */
    readonly rasterize: (pdfBytes: Buffer) => Promise<readonly RasterizedPage[]>;
}

import type * as PdfImgConvertNs from 'pdf-img-convert';
import type * as PdfjsLibNs from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfImgConvertModule = typeof PdfImgConvertNs;
type PdfjsLibModule = typeof PdfjsLibNs;

/**
 * Default rasterizer factory. Lazily imports `pdf-img-convert` and
 * `pdfjs-dist` so test environments that only use a stub don't pay the
 * import cost (and don't need `canvas` system deps installed).
 */
export const createPdfImgConvertRasterizer = (): Rasterizer => {
    let pdfImgConvert: PdfImgConvertModule | null = null;
    let pdfjsLib: PdfjsLibModule | null = null;

    const loadPdfImgConvert = async (): Promise<PdfImgConvertModule> => {
        const cached = pdfImgConvert;
        if (cached !== null) return cached;
        const loaded = await import('pdf-img-convert');
        pdfImgConvert = loaded;
        return loaded;
    };

    const loadPdfjs = async (): Promise<PdfjsLibModule> => {
        const cached = pdfjsLib;
        if (cached !== null) return cached;
        const loaded = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjsLib = loaded;
        return loaded;
    };

    return Object.freeze({
        pageCount: async (pdfBytes: Buffer): Promise<number> => {
            const pdfjs = await loadPdfjs();
            const doc = await pdfjs.getDocument({
                data: new Uint8Array(pdfBytes),
                disableFontFace: true,
                useSystemFonts: false,
            }).promise;
            try {
                return doc.numPages;
            } finally {
                await doc.destroy();
            }
        },
        rasterize: async (pdfBytes: Buffer): Promise<readonly RasterizedPage[]> => {
            const lib = await loadPdfImgConvert();
            const images = await lib.convert(pdfBytes, { base64: false });
            return images.map((img: Uint8Array | string, idx: number): RasterizedPage => {
                if (typeof img === 'string') {
                    throw new Error(
                        'pdf-img-convert returned a string; expected Uint8Array (base64:false)',
                    );
                }
                return { pageNum: idx + 1, pngBytes: Buffer.from(img) };
            });
        },
    });
};
