/**
 * §B.3 Rasterizer wrapper tests.
 *
 * Exercises the page-count probe against real fixture PDFs from
 * `agent/evals/fixtures/document-extraction/source/`. The render path
 * (`rasterize`) is gated on the `canvas` native module — the wrapper
 * lazily imports `pdf-img-convert`, which transitively requires
 * `canvas`'s prebuilt binaries. CI runners that have not built canvas
 * skip those cases via `RUN_RASTERIZER_RENDER_TESTS=1`. The page-count
 * probe uses only `pdfjs-dist` (no native deps) and runs unconditionally.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createPdfImgConvertRasterizer } from '../../src/pipeline/rasterizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = resolve(__dirname, '../../evals/fixtures/document-extraction/source');

const readFixture = (relpath: string): Buffer => readFileSync(resolve(FIXTURE_ROOT, relpath));

describe('createPdfImgConvertRasterizer().pageCount', () => {
    it('reports 3 pages for the Chen intake fixture', async () => {
        const r = createPdfImgConvertRasterizer();
        const count = await r.pageCount(readFixture('intake-forms/p01-chen-intake-typed.pdf'));
        expect(count).toBe(3);
    });

    it('reports 2 pages for the Chen lipid panel and Whitaker intake', async () => {
        const r = createPdfImgConvertRasterizer();
        expect(await r.pageCount(readFixture('lab-results/p01-chen-lipid-panel.pdf'))).toBe(2);
        expect(await r.pageCount(readFixture('intake-forms/p02-whitaker-intake.pdf'))).toBe(2);
    });

    it('reports 1 page for single-page lab PDFs (CBC, CMP)', async () => {
        const r = createPdfImgConvertRasterizer();
        expect(await r.pageCount(readFixture('lab-results/p02-whitaker-cbc.pdf'))).toBe(1);
        expect(await r.pageCount(readFixture('lab-results/p04-kowalski-cmp.pdf'))).toBe(1);
    });

    it('rejects bytes that do not parse as a PDF', async () => {
        const r = createPdfImgConvertRasterizer();
        await expect(r.pageCount(Buffer.from('not-a-pdf'))).rejects.toThrow();
    });
});

const renderTestsEnabled = process.env['RUN_RASTERIZER_RENDER_TESTS'] === '1';

describe.skipIf(!renderTestsEnabled)(
    'createPdfImgConvertRasterizer().rasterize (gated on RUN_RASTERIZER_RENDER_TESTS=1)',
    () => {
        it('renders one PNG per page in page-number order', async () => {
            const r = createPdfImgConvertRasterizer();
            const pages = await r.rasterize(readFixture('lab-results/p02-whitaker-cbc.pdf'));
            expect(pages).toHaveLength(1);
            const first = pages[0];
            if (first === undefined) throw new Error('expected one page');
            expect(first.pageNum).toBe(1);
            // PNG magic bytes — first 8 bytes are 89 50 4E 47 0D 0A 1A 0A.
            const header = first.pngBytes.subarray(0, 8);
            expect(header[0]).toBe(0x89);
            expect(header.toString('ascii', 1, 4)).toBe('PNG');
        });
    },
);
