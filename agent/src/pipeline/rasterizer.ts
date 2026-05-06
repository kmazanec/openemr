/**
 * §B.3 Rasterizer interface — PDF bytes → page PNG bytes.
 *
 * Backed by Poppler (`pdftoppm` + `pdfinfo`). Poppler is the reference
 * Linux PDF renderer and the only option in the realistic shortlist
 * that handles modern PDF features the agent receives in the wild —
 * transparency groups, blend modes, gradients, form XObjects, optional
 * content layers — without dropping content. The pdfjs + node-canvas
 * stack we used initially silently rendered some clinical PDFs as a
 * solid-color wash with only a few text fragments visible, which the
 * vision model then "extracted" as `<UNKNOWN>` placeholders and the
 * patient-match node refused as a confident mismatch.
 *
 * Design notes:
 *   - Both `pageCount` and `rasterize` shell out to Poppler; we don't
 *     keep a second renderer for metadata. One source of truth means
 *     page-count and rendering can never disagree on a tricky PDF.
 *   - `pdftoppm` writes one PNG per page to disk. We use a per-call
 *     tmpdir under `os.tmpdir()` and delete it in `finally`; the
 *     PNG bytes are read into Buffers and returned in page order.
 *   - Each subprocess has a per-page timeout (60s). The `nodes/rasterize`
 *     cost cap already refuses absurdly large documents up-front, so
 *     this timeout is a defense-in-depth against a maliciously-crafted
 *     PDF that hangs the renderer.
 *   - The `Rasterizer` interface is the seam: tests inject a stub,
 *     prod wires `createPopplerRasterizer()`. A future swap to a
 *     different backend is a single-file change here.
 *
 * System dependency: `poppler-utils` must be on PATH. The agent
 * Dockerfile installs it via `apk add poppler-utils`. For host-side
 * tests on darwin: `brew install poppler`. On debian/ubuntu:
 * `apt install poppler-utils`.
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile) as (
    file: string,
    args: readonly string[],
    options?: ExecFileOptions,
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

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

/**
 * Render DPI for `pdftoppm -r`. 150 DPI on letter-size produces
 * ~1275×1650 px, comfortably above the ~1024px-long-edge threshold
 * Anthropic recommends for vision OCR-quality reading and well below
 * the 8000×8000 px hard cap. Image bytes are roughly proportional to
 * (DPI/72)² so going higher pays for itself only on very small text.
 */
const RENDER_DPI = 150;

/** Per-page subprocess timeout. */
const PER_PAGE_TIMEOUT_MS = 60_000;

const TMP_PREFIX = 'agent-rasterize-';

const writePdfToTmpFile = async (
    pdfBytes: Buffer,
): Promise<{ readonly dir: string; readonly path: string }> => {
    const dir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
    const path = join(dir, 'input.pdf');
    await writeFile(path, pdfBytes);
    return { dir, path };
};

const cleanupTmpDir = async (dir: string): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
};

/**
 * Parse `Pages: N` out of pdfinfo's stdout. pdfinfo emits a series of
 * `Key: value` lines; we don't bind to ordering and we tolerate extra
 * keys we don't care about.
 */
const parsePageCount = (stdout: string): number => {
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^Pages:\s+(\d+)\s*$/.exec(line);
        if (match !== null) {
            const n = Number(match[1]);
            if (Number.isInteger(n) && n > 0) return n;
        }
    }
    throw new Error('pdfinfo output did not contain a positive Pages: line');
};

/**
 * `pdftoppm -png -r <DPI> <input.pdf> <prefix>` writes one PNG per
 * page named `<prefix>-N.png` (zero-padded for ≥10 pages). Read them
 * all back, sort numerically, return.
 */
const collectRasterizedPages = async (
    dir: string,
    prefix: string,
): Promise<readonly RasterizedPage[]> => {
    const entries = await readdir(dir);
    const matcher = new RegExp(`^${prefix}-(\\d+)\\.png$`);
    const matches: { pageNum: number; filename: string }[] = [];
    for (const entry of entries) {
        const m = matcher.exec(entry);
        if (m === null) continue;
        const pageNum = Number(m[1]);
        if (!Number.isInteger(pageNum) || pageNum <= 0) continue;
        matches.push({ pageNum, filename: entry });
    }
    matches.sort((a, b) => a.pageNum - b.pageNum);
    const pages: RasterizedPage[] = [];
    for (const { pageNum, filename } of matches) {
        const pngBytes = await readFile(join(dir, filename));
        pages.push({ pageNum, pngBytes });
    }
    return pages;
};

export const createPopplerRasterizer = (): Rasterizer => {
    return Object.freeze({
        pageCount: async (pdfBytes: Buffer): Promise<number> => {
            const { dir, path } = await writePdfToTmpFile(pdfBytes);
            try {
                const { stdout } = await execFileAsync('pdfinfo', [path], {
                    timeout: PER_PAGE_TIMEOUT_MS,
                    maxBuffer: 1 << 20,
                    encoding: 'utf8',
                });
                return parsePageCount(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
            } finally {
                await cleanupTmpDir(dir);
            }
        },
        rasterize: async (pdfBytes: Buffer): Promise<readonly RasterizedPage[]> => {
            const { dir, path } = await writePdfToTmpFile(pdfBytes);
            try {
                const outPrefix = 'page';
                await execFileAsync(
                    'pdftoppm',
                    ['-png', '-r', String(RENDER_DPI), path, join(dir, outPrefix)],
                    {
                        // Cap total render time at PER_PAGE_TIMEOUT_MS × 50 ≈ 50 min,
                        // not per-page — `pdftoppm` renders all pages in one
                        // invocation and the cost cap upstream already refuses
                        // documents large enough that this would matter.
                        timeout: PER_PAGE_TIMEOUT_MS * 50,
                        // PNG bytes go to disk, not stdout — we just need to
                        // tolerate progress messages.
                        maxBuffer: 1 << 20,
                    },
                );
                const pages = await collectRasterizedPages(dir, outPrefix);
                if (pages.length === 0) {
                    throw new Error('pdftoppm produced no output PNGs');
                }
                return pages;
            } finally {
                await cleanupTmpDir(dir);
            }
        },
    });
};
