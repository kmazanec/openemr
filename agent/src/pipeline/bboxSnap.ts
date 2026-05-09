/**
 * §B.4b Bbox-snap post-processing.
 *
 * The vision model returns approximate bboxes — empirically, bbox
 * accuracy is the weakest part of the extraction even when the field
 * value, page, quote, and confidence are all correct. The error
 * pattern is systematic (rows shifted up/down by half-a-row, boxes
 * extending too far when the model emits `[x1,y1,x2,y2]` corners
 * instead of the prompted `[x,y,w,h]` shape) and can be eliminated
 * post-hoc by re-running OCR on the same rasterized page and snapping
 * each cited bbox to the actual text position.
 *
 * Why this is a separate node rather than tighter prompt engineering:
 *   - The model emits both `xywh` and `xyxy` shapes inconsistently
 *     across documents. Detecting the shape per call is cheaper and
 *     more reliable than convincing the model to commit.
 *   - Even the correctly-shaped bboxes are off by a row on dense
 *     tables. OCR is the ground truth — we already have the bytes.
 *   - The model's `quote` is reliable. If we trust the quote and use
 *     it to find the text in OCR output, the resulting bbox is
 *     pixel-perfect on the rasterized page and the rendering layer
 *     stays untouched.
 *
 * Tesseract is shelled out as `tesseract <input> stdout -l eng --psm 6
 * tsv` matching the existing Poppler pattern (`rasterizer.ts`). The
 * Dockerfile installs `tesseract-ocr` next to `poppler-utils`.
 *
 * @package OpenEMR
 * @link    https://www.open-emr.org
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GPL-3.0
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

import type { PageImage } from './state.js';

const execFileAsync = promisify(execFile) as (
    file: string,
    args: readonly string[],
    options?: ExecFileOptions,
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const TESSERACT_TIMEOUT_MS = 60_000;

/** A bbox on the same 0..1000 grid the vision schema uses. */
export type GridBbox = readonly [number, number, number, number];

/** Pixel-space corners on a rasterized page image. */
export interface PixelRect {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
}

/** One OCR'd word with its pixel-space corners and Tesseract line group. */
export interface OcrWord {
    readonly text: string;
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly block: number;
    readonly line: number;
}

export interface PageOcr {
    readonly pageNum: number;
    /** Pixel dimensions of the rasterized page. */
    readonly width: number;
    readonly height: number;
    readonly words: readonly OcrWord[];
}

/**
 * Run `tesseract` on PNG bytes and return word-level OCR output. The
 * tsv output uses level=5 for words; we discard line/paragraph/block
 * level rows but keep the block_num and line_num for line grouping.
 */
export const ocrPage = async (
    pageNum: number,
    pngBytes: Buffer,
    pageWidth: number,
    pageHeight: number,
): Promise<PageOcr> => {
    const dir = await mkdtemp(join(tmpdir(), 'bbox-snap-'));
    const inputPath = join(dir, `page-${pageNum}.png`);
    try {
        await writeFile(inputPath, pngBytes);
        const { stdout } = await execFileAsync(
            'tesseract',
            [inputPath, 'stdout', '-l', 'eng', '--psm', '6', 'tsv'],
            { timeout: TESSERACT_TIMEOUT_MS, maxBuffer: 1 << 24, encoding: 'utf8' },
        );
        const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
        const words = parseTesseractTsv(text);
        return { pageNum, width: pageWidth, height: pageHeight, words };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

const parseTesseractTsv = (tsv: string): OcrWord[] => {
    const out: OcrWord[] = [];
    const lines = tsv.split(/\r?\n/);
    const headerLine = lines[0];
    if (headerLine === undefined) return out;
    const header = headerLine.split('\t');
    const idx = (k: string): number => header.indexOf(k);
    const iLevel = idx('level');
    const iBlock = idx('block_num');
    const iLine = idx('line_num');
    const iLeft = idx('left');
    const iTop = idx('top');
    const iWidth = idx('width');
    const iHeight = idx('height');
    const iText = idx('text');
    if (iLevel < 0 || iLeft < 0 || iText < 0) return out;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const cols = line.split('\t');
        if (cols.length < header.length) continue;
        if (Number(cols[iLevel]) !== 5) continue;
        const text = (cols[iText] ?? '').trim();
        if (text.length === 0) continue;
        const left = Number(cols[iLeft]);
        const top = Number(cols[iTop]);
        const w = Number(cols[iWidth]);
        const h = Number(cols[iHeight]);
        if (![left, top, w, h].every(Number.isFinite)) continue;
        out.push({
            text,
            x1: left,
            y1: top,
            x2: left + w,
            y2: top + h,
            block: Number(cols[iBlock]),
            line: Number(cols[iLine]),
        });
    }
    return out;
};

/**
 * Decide whether a list of grid bboxes is encoded as `[x, y, w, h]`
 * (the prompt's intended shape) or `[x1, y1, x2, y2]` (corners — what
 * the model emits roughly half the time on lab tables).
 *
 * Discriminator: a `[x, y, w, h]` bbox MUST satisfy `x + w <= 1000`
 * and `y + h <= 1000` because the schema clamps each component to
 * 0..1000 individually. A `[x1, y1, x2, y2]` bbox satisfies `x2 > x1`
 * and `y2 > y1`. We count which interpretation produces more valid
 * boxes; the majority wins.
 */
export const detectBboxFormat = (boxes: readonly GridBbox[]): 'xywh' | 'xyxy' => {
    let xywhValid = 0;
    let xyxyValid = 0;
    for (const b of boxes) {
        if (b[0] + b[2] <= 1000 && b[1] + b[3] <= 1000) xywhValid++;
        if (b[2] > b[0] && b[3] > b[1] && b[2] <= 1000 && b[3] <= 1000) xyxyValid++;
    }
    return xyxyValid > xywhValid ? 'xyxy' : 'xywh';
};

/** Convert a bbox in either format to canonical xywh. */
export const toXywh = (b: GridBbox, format: 'xywh' | 'xyxy'): GridBbox => {
    if (format === 'xywh') return b;
    return [b[0], b[1], Math.max(0, b[2] - b[0]), Math.max(0, b[3] - b[1])];
};

const normalize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

const tokenize = (s: string): string[] =>
    normalize(s).split(' ').filter((t) => t.length > 0);

/**
 * Levenshtein-based fuzzy token similarity. Returns 1.0 for exact
 * match, scaled down by edit distance, with a 0.6 floor below which
 * we treat as no-match. We bail early when the token lengths differ
 * dramatically — "ml" vs "milligrams" should never match.
 */
const tokenSimilarity = (a: string, b: string): number => {
    if (a === b) return 1;
    const m = a.length;
    const n = b.length;
    if (m === 0 || n === 0) return 0;
    if (Math.abs(m - n) > Math.max(2, Math.floor(Math.max(m, n) * 0.3))) return 0;
    // Single flat-array DP (size (m+1)*(n+1)) so TS strict-index
    // checking doesn't have to chase 2D `[][]` lookups.
    const stride = n + 1;
    const dp = new Uint16Array((m + 1) * stride);
    for (let i = 0; i <= m; i++) dp[i * stride] = i;
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            const up = dp[(i - 1) * stride + j]! + 1;
            const left = dp[i * stride + (j - 1)]! + 1;
            const diag = dp[(i - 1) * stride + (j - 1)]! + cost;
            dp[i * stride + j] = Math.min(up, left, diag);
        }
    }
    const dist = dp[m * stride + n]!;
    const maxLen = Math.max(m, n);
    const sim = 1 - dist / maxLen;
    return sim >= 0.6 ? sim : 0;
};

interface SnapResult {
    readonly score: number;
    readonly rect: PixelRect;
}

/**
 * Snap a quoted span to the actual text position on a page by
 * searching the OCR output. Returns pixel-space corners on success,
 * or null if no acceptable match exists. The model's bbox center
 * (`hint`) breaks ties when the same quote appears multiple times.
 */
export const snapQuoteToOcr = (
    quote: string,
    hint: { readonly x: number; readonly y: number },
    page: PageOcr,
): PixelRect | null => {
    const needle = tokenize(quote);
    if (needle.length === 0) return null;
    // Drop trivial 1-char tokens unless the whole quote is one char.
    const filtered = needle.length === 1 ? needle : needle.filter((t) => t.length > 1);
    const probe = filtered.length > 0 ? filtered : needle;
    const minCoverage = probe.length === 1 ? 1.0 : 0.5;
    const pageDiag = Math.hypot(page.width, page.height);
    const maxAllowedDistance = Math.max(page.width, page.height) * 0.5;

    // Group words by (block, line). Multi-line quotes (addresses,
    // reference ranges) need to walk consecutive lines, so we also
    // build line-groups within each block keyed by integer line
    // index so we can iterate them in document order.
    const lineMap = new Map<string, OcrWord[]>();
    const blockLineIdx = new Map<number, number[]>();
    for (const w of page.words) {
        const key = `${w.block}::${w.line}`;
        if (!lineMap.has(key)) {
            lineMap.set(key, []);
            const idxList = blockLineIdx.get(w.block) ?? [];
            if (!idxList.includes(w.line)) {
                idxList.push(w.line);
                idxList.sort((a, b) => a - b);
                blockLineIdx.set(w.block, idxList);
            }
        }
        lineMap.get(key)!.push(w);
    }

    let best: SnapResult | null = null;

    /**
     * Concatenate `groupSize` consecutive lines from a block into a
     * single ordered token list. Used so a multi-line quote can match
     * across line breaks instead of falling back to the model's raw
     * bbox.
     */
    const buildLineGroup = (block: number, startLineIdx: number, groupSize: number): OcrWord[] => {
        const idxList = blockLineIdx.get(block) ?? [];
        if (startLineIdx + groupSize > idxList.length) return [];
        const out: OcrWord[] = [];
        for (let k = 0; k < groupSize; k++) {
            const lineNum = idxList[startLineIdx + k];
            if (lineNum === undefined) return [];
            const words = lineMap.get(`${block}::${lineNum}`);
            if (words === undefined) return [];
            out.push(...[...words].sort((a, b) => a.x1 - b.x1));
        }
        return out;
    };

    // Build the search set: per-line groups plus, for needles with
    // ≥4 tokens, 2-line and 3-line groups within the same block. The
    // 3-line cap matches how multi-line quotes wrap in practice
    // (street + city/state, or a 3-line reference range).
    type SearchUnit = OcrWord[];
    const searchUnits: SearchUnit[] = [];
    for (const lineWords of lineMap.values()) {
        searchUnits.push([...lineWords].sort((a, b) => a.x1 - b.x1));
    }
    if (probe.length >= 4) {
        for (const [block, idxList] of blockLineIdx.entries()) {
            for (let i = 0; i < idxList.length; i++) {
                for (const groupSize of [2, 3]) {
                    const grp = buildLineGroup(block, i, groupSize);
                    if (grp.length > 0) searchUnits.push(grp);
                }
            }
        }
    }

    for (const sorted of searchUnits) {
        const tokenized = sorted.map((w) => tokenize(w.text)[0] ?? '');

        for (let startIdx = 0; startIdx < tokenized.length; startIdx++) {
            let nIdx = 0;
            let lineIdx = startIdx;
            let firstMatched = -1;
            let lastMatched = -1;
            let matched = 0;
            let totalSim = 0;
            while (nIdx < probe.length && lineIdx < tokenized.length) {
                const probeTok = probe[nIdx];
                const lineTok = tokenized[lineIdx];
                if (probeTok === undefined || lineTok === undefined) break;
                const sim = tokenSimilarity(probeTok, lineTok);
                if (sim > 0) {
                    if (firstMatched < 0) firstMatched = lineIdx;
                    lastMatched = lineIdx;
                    matched++;
                    totalSim += sim;
                    nIdx++;
                    lineIdx++;
                    continue;
                }
                if (firstMatched >= 0 && lineIdx - lastMatched <= 2) {
                    lineIdx++;
                    continue;
                }
                break;
            }
            const coverage = matched / probe.length;
            if (coverage < minCoverage || firstMatched < 0 || lastMatched < 0) continue;

            const span = sorted.slice(firstMatched, lastMatched + 1);
            const firstWord = span[0];
            if (firstWord === undefined) continue;
            let x1 = firstWord.x1;
            let y1 = firstWord.y1;
            let x2 = firstWord.x2;
            let y2 = firstWord.y2;
            for (const w of span) {
                if (w.x1 < x1) x1 = w.x1;
                if (w.y1 < y1) y1 = w.y1;
                if (w.x2 > x2) x2 = w.x2;
                if (w.y2 > y2) y2 = w.y2;
            }
            const cx = (x1 + x2) / 2;
            const cy = (y1 + y2) / 2;
            const distance = Math.hypot(cx - hint.x, cy - hint.y);
            // Reject far matches outright — when the quote text
            // appears multiple times on the page, the model's hint
            // tells us which instance is meant.
            if (distance > maxAllowedDistance) continue;
            const proximity = 1 - Math.min(1, distance / pageDiag);
            const avgSim = totalSim / matched;
            const score = coverage * 100 + avgSim * 20 + proximity * 30;
            if (best === null || score > best.score) {
                best = { score, rect: { x1, y1, x2, y2 } };
            }
        }
    }
    return best ? best.rect : null;
};

/** Convert a pixel-space rect on a page to the 0..1000 grid as xywh. */
export const pixelRectToGrid = (rect: PixelRect, page: { width: number; height: number }): GridBbox => {
    const gx = Math.round((rect.x1 / page.width) * 1000);
    const gy = Math.round((rect.y1 / page.height) * 1000);
    const gw = Math.round(((rect.x2 - rect.x1) / page.width) * 1000);
    const gh = Math.round(((rect.y2 - rect.y1) / page.height) * 1000);
    // Clamp to schema bounds; small overshoots from rounding up at the
    // page edge are common and the schema rejects out-of-range ints.
    const cx = Math.max(0, Math.min(1000, gx));
    const cy = Math.max(0, Math.min(1000, gy));
    const cw = Math.max(0, Math.min(1000 - cx, gw));
    const ch = Math.max(0, Math.min(1000 - cy, gh));
    return [cx, cy, cw, ch];
};

/**
 * Walk the extraction tree and snap every `bbox` field to OCR text.
 * The `extraction` is mutated in place — Zod-parsed objects are plain
 * JS objects so this is safe; the output of structured-output is
 * disposable. Returns counters useful for trace metadata.
 *
 * Traversal mirrors the rule used in the panel's bbox renderer: any
 * object that carries both a `bbox` (4-tuple of numbers) AND a `page`
 * (positive int) is treated as a citation. Other keys are recursed
 * into.
 */
export interface SnapSummary {
    readonly totalBboxes: number;
    readonly snappedBboxes: number;
    readonly formatDetected: 'xywh' | 'xyxy';
}

/**
 * Read a page's PNG via its short-TTL signed URL and feed it to
 * Tesseract. The signed URL was minted ≤5 min before vision returned,
 * so it should still be valid; if Spaces has revoked it (clock skew,
 * lifecycle policy), the fetch fails and the snapper returns no OCR
 * for that page — the snap pass treats that as "skipped" and the
 * bbox stays unsnapped.
 *
 * `dimensions` is filled in from the PNG header (the IHDR chunk's
 * width/height are at fixed offsets 16-23 of any well-formed PNG)
 * rather than via an image library; we keep agent dependencies tight
 * and the IHDR layout has been stable since 1996.
 */
const readPngDimensions = (bytes: Buffer): { width: number; height: number } | null => {
    if (bytes.length < 24) return null;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
        bytes[0] !== 0x89 ||
        bytes[1] !== 0x50 ||
        bytes[2] !== 0x4e ||
        bytes[3] !== 0x47 ||
        bytes[4] !== 0x0d ||
        bytes[5] !== 0x0a ||
        bytes[6] !== 0x1a ||
        bytes[7] !== 0x0a
    ) {
        return null;
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0)
        return null;
    return { width, height };
};

export interface ProductionBboxSnapperDeps {
    /**
     * Fetch the PNG bytes for a rasterized page via its signed URL.
     * Production wires `globalThis.fetch`; tests stub a deterministic
     * fixture map.
     */
    readonly fetchBytes: (signedUrl: string) => Promise<Buffer>;
    readonly logger: Logger;
}

export interface BboxSnapperLike {
    readonly snap: (pages: readonly PageImage[]) => Promise<readonly PageOcr[]>;
}

/**
 * Build a production-ready snapper that fetches each page's PNG via
 * its signed URL and runs Tesseract on the bytes. Failures on a
 * single page are logged and skipped — the rest of the pages still
 * snap. Returns the empty array (not throwing) when ALL pages fail
 * so the vision node can treat that as "snap unavailable" without a
 * pipeline failure.
 */
export const createBboxSnapper = (deps: ProductionBboxSnapperDeps): BboxSnapperLike => ({
    snap: async (pages) => {
        const out: PageOcr[] = [];
        for (const page of pages) {
            try {
                const bytes = await deps.fetchBytes(page.signedUrl);
                const dims = readPngDimensions(bytes);
                if (dims === null) {
                    deps.logger.warn(
                        { pageNum: page.pageNum, byteCount: bytes.length },
                        'bboxSnap: page bytes are not a recognizable PNG; skipping OCR',
                    );
                    continue;
                }
                const ocr = await ocrPage(page.pageNum, bytes, dims.width, dims.height);
                out.push(ocr);
            } catch (err) {
                deps.logger.warn(
                    { pageNum: page.pageNum, err: String(err) },
                    'bboxSnap: per-page OCR failed; skipping',
                );
            }
        }
        return out;
    },
});

/**
 * Default `fetchBytes` for production: uses `globalThis.fetch`. Pulled
 * out so tests can stub it with a synchronous map of url → bytes.
 */
export const defaultFetchPageBytes = async (signedUrl: string): Promise<Buffer> => {
    const res = await fetch(signedUrl);
    if (!res.ok) {
        throw new Error(`fetch ${signedUrl} returned ${res.status} ${res.statusText}`);
    }
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
};

export const snapExtractionBboxes = (
    extraction: unknown,
    pages: readonly PageOcr[],
): SnapSummary => {
    const allBboxes: { obj: Record<string, unknown>; page: number }[] = [];
    const visit = (node: unknown): void => {
        if (node === null || node === undefined) return;
        if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
        }
        if (typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        const bbox = obj['bbox'];
        const page = obj['page'];
        if (
            Array.isArray(bbox) &&
            bbox.length === 4 &&
            bbox.every((n) => typeof n === 'number') &&
            typeof page === 'number'
        ) {
            allBboxes.push({ obj, page });
        }
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'bbox' || k === 'page' || k === 'quote' || k === 'confidence') continue;
            visit(v);
        }
    };
    visit(extraction);

    const bboxes = allBboxes.map((e) => e.obj['bbox'] as GridBbox);
    const format = detectBboxFormat(bboxes);

    interface AnnotatedBbox {
        readonly obj: Record<string, unknown>;
        readonly pageNum: number;
        /** Always xywh on the 0..1000 grid. */
        readonly modelXywh: GridBbox;
        snapped: boolean;
    }

    const annotated: AnnotatedBbox[] = allBboxes.map(({ obj, page: pageNum }) => ({
        obj,
        pageNum,
        modelXywh: toXywh(obj['bbox'] as GridBbox, format),
        snapped: false,
    }));

    let snapped = 0;
    // Pass 1 — direct OCR-quote snapping. The lion's share of bboxes
    // resolve here.
    for (const a of annotated) {
        const page = pages.find((p) => p.pageNum === a.pageNum);
        if (!page) continue;
        const quote = typeof a.obj['quote'] === 'string' ? a.obj['quote'] : '';
        if (quote.length === 0) continue;
        const cx = ((a.modelXywh[0] + a.modelXywh[2] / 2) / 1000) * page.width;
        const cy = ((a.modelXywh[1] + a.modelXywh[3] / 2) / 1000) * page.height;
        const snap = snapQuoteToOcr(quote, { x: cx, y: cy }, page);
        if (snap) {
            (a.obj as { bbox: GridBbox }).bbox = pixelRectToGrid(snap, page);
            a.snapped = true;
            snapped++;
        }
    }

    // Pass 2 — row-neighbor fallback. Single-character flags ("H" / "L"
    // / "F"), short single-token fields ("Yes" / "Mild" / "Unsure"),
    // and other quotes too ambiguous to snap on their own quote text
    // alone almost always live in the same OCR row as a longer field
    // that DID snap (a result_value, a test_name, an analyte). Find a
    // snapped neighbor on the same page whose model y-band overlaps
    // ours and copy its snapped y-band onto our box, keeping our
    // model x as the column anchor.
    const rowNeighborMatchY = 25; // grid units of y-overlap tolerance.
    for (const a of annotated) {
        if (a.snapped) continue;
        const page = pages.find((p) => p.pageNum === a.pageNum);
        if (!page) continue;
        const myYmid = a.modelXywh[1] + a.modelXywh[3] / 2;
        let neighborSnapped: GridBbox | null = null;
        let neighborDelta = Number.POSITIVE_INFINITY;
        for (const n of annotated) {
            if (!n.snapped || n.pageNum !== a.pageNum) continue;
            const nYmid = n.modelXywh[1] + n.modelXywh[3] / 2;
            const delta = Math.abs(nYmid - myYmid);
            if (delta > rowNeighborMatchY) continue;
            if (delta < neighborDelta) {
                neighborDelta = delta;
                neighborSnapped = n.obj['bbox'] as GridBbox;
            }
        }
        if (neighborSnapped !== null) {
            // Borrow the neighbor's snapped y/h; keep our model's
            // x/w. The result is a tight row-aligned box at our
            // column position.
            const [, ny, , nh] = neighborSnapped;
            const [mx, , mw] = a.modelXywh;
            const cx = Math.max(0, Math.min(1000, mx));
            const cw = Math.max(0, Math.min(1000 - cx, mw));
            (a.obj as { bbox: GridBbox }).bbox = [cx, ny, cw, nh];
            a.snapped = true;
            snapped++;
        } else if (format === 'xyxy') {
            // Last-resort: when corners couldn't snap and we don't
            // have a row-neighbor either, normalize the bbox shape
            // so the renderer (which assumes xywh) doesn't draw a
            // box stretching to the bottom-right.
            (a.obj as { bbox: GridBbox }).bbox = a.modelXywh;
        }
    }

    return { totalBboxes: allBboxes.length, snappedBboxes: snapped, formatDetected: format };
};
