/**
 * Bbox accuracy harness — calls the real Anthropic vision API on a
 * document from `docs/example-documents/`, runs the production
 * `snapExtractionBboxes` post-processor over the result, and renders
 * model-only / snapped / both overlays as PNGs in `.bbox-debug/`.
 *
 * This is the iteration substrate for the §B.4b bbox-snap pass and
 * exercises the production module (`src/pipeline/bboxSnap.ts`) end-to-
 * end without booting the full Spaces/LangGraph wiring. It is also
 * the demonstration target for the user-facing requirement that every
 * cited bbox precisely outline its source line item.
 *
 * Usage:
 *   tsx agent/scripts/bbox-debug.ts <doc-path>
 *
 * `<doc-path>` is a PDF, PNG, or JPG; PDFs are rasterized via the
 * production Poppler `Rasterizer` so the page DPI matches what the
 * real pipeline ships to Anthropic.
 *
 * @package OpenEMR
 * @link    https://www.open-emr.org
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GPL-3.0
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';

import {
    detectBboxFormat,
    ocrPage,
    snapExtractionBboxes,
    toXywh,
    type GridBbox,
    type PageOcr,
} from '../src/pipeline/bboxSnap.js';
import {
    VISION_SYSTEM_PROMPT,
    userInstruction,
    type DocType,
} from '../src/pipeline/nodes/vision.js';

const exec = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(REPO_ROOT, '.bbox-debug');
const RENDER_DPI = 150;

interface PagePng {
    readonly pageNum: number;
    readonly pngPath: string;
    readonly width: number;
    readonly height: number;
}

const guessDocType = (path: string): DocType => {
    const lower = path.toLowerCase();
    if (lower.includes('intake')) return 'intake_form';
    return 'lab_pdf';
};

const isPdf = (path: string): boolean => path.toLowerCase().endsWith('.pdf');

const probeDimensions = async (
    pngPath: string,
): Promise<{ width: number; height: number }> => {
    const { stdout } = await exec('identify', ['-format', '%w %h', pngPath]);
    const text = String(stdout).trim();
    const parts = text.split(/\s+/);
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
        throw new Error(`identify produced unparsable dimensions: ${text}`);
    }
    return { width: w, height: h };
};

const rasterizePdf = async (pdfPath: string): Promise<PagePng[]> => {
    const dir = await mkdtemp(join(tmpdir(), 'bbox-debug-'));
    const prefix = join(dir, 'page');
    await exec('pdftoppm', ['-r', String(RENDER_DPI), '-png', pdfPath, prefix], {
        maxBuffer: 1024 * 1024 * 64,
    });
    const entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const pages: PagePng[] = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry === undefined) continue;
        const pngPath = join(dir, entry);
        const { width, height } = await probeDimensions(pngPath);
        pages.push({ pageNum: i + 1, pngPath, width, height });
    }
    return pages;
};

const loadImageAsPage = async (imgPath: string): Promise<PagePng[]> => {
    const { width, height } = await probeDimensions(imgPath);
    return [{ pageNum: 1, pngPath: imgPath, width, height }];
};

const callVision = async (
    client: Anthropic,
    pages: readonly PagePng[],
    docType: DocType,
): Promise<unknown> => {
    const userBlocks: Anthropic.MessageParam['content'] = [];
    userBlocks.push({ type: 'text', text: userInstruction(docType) });
    for (const page of pages) {
        userBlocks.push({ type: 'text', text: `<DOCUMENT_PAGE_${page.pageNum}>` });
        const bytes = await fs.readFile(page.pngPath);
        userBlocks.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/png',
                data: bytes.toString('base64'),
            },
        });
        userBlocks.push({ type: 'text', text: `</DOCUMENT_PAGE_${page.pageNum}>` });
    }

    const response = await client.messages.create({
        model: process.env['ANTHROPIC_MODEL_VISION'] ?? 'claude-sonnet-4-5',
        max_tokens: 8192,
        temperature: 0,
        system:
            VISION_SYSTEM_PROMPT +
            '\n\nReturn ONLY a JSON object matching the requested schema. Do not wrap it in markdown.',
        messages: [{ role: 'user', content: userBlocks }],
    });
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) throw new Error('no text block in response');
    let raw = textBlock.text.trim();
    raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    return JSON.parse(raw);
};

interface BboxRow {
    readonly page: number;
    readonly bbox: GridBbox;
    readonly quote: string;
    readonly label: string;
    readonly confidence: number | undefined;
}

/**
 * Walk the extraction tree and pull out every bbox/page citation.
 * Mirrors `snapExtractionBboxes` traversal but returns the raw bbox
 * tuples (post-snap) for the renderer to draw.
 */
const collectBboxes = (extraction: unknown): BboxRow[] => {
    const out: BboxRow[] = [];
    const visit = (node: unknown, path: string[]): void => {
        if (node === null || node === undefined) return;
        if (Array.isArray(node)) {
            node.forEach((item, i) => visit(item, [...path, `[${i}]`]));
            return;
        }
        if (typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        const bbox = obj['bbox'];
        const page = obj['page'];
        if (
            Array.isArray(bbox) &&
            bbox.length === 4 &&
            bbox.every((n): n is number => typeof n === 'number') &&
            typeof page === 'number'
        ) {
            const label =
                typeof obj['analyte_name'] === 'string'
                    ? obj['analyte_name']
                    : path[path.length - 1] ?? 'field';
            const quote = typeof obj['quote'] === 'string' ? obj['quote'] : '';
            const confidence =
                typeof obj['confidence'] === 'number' ? obj['confidence'] : undefined;
            out.push({
                page,
                bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] as GridBbox,
                quote,
                label,
                confidence,
            });
        }
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'bbox' || k === 'page' || k === 'quote' || k === 'confidence') continue;
            visit(v, [...path, k]);
        }
    };
    visit(extraction, []);
    return out;
};

const COLORS = [
    'red', 'blue', 'green', 'orange', 'purple', 'magenta', 'cyan',
    'yellow', 'lime', 'pink', 'brown', 'navy', 'teal',
];

const FILL_RGBA: Record<string, string> = {
    red: '#ff000022',
    blue: '#0066ff22',
    green: '#00cc0022',
    orange: '#ff990022',
    purple: '#9900ff22',
    magenta: '#ff00ff22',
    cyan: '#00ccff22',
    yellow: '#ffcc0022',
    lime: '#88ff0022',
    pink: '#ff66cc22',
    brown: '#88440022',
    navy: '#00006622',
    teal: '#00666622',
};

const renderOverlay = async (
    page: PagePng,
    bboxes: readonly BboxRow[],
    outPath: string,
    format: 'xywh' | 'xyxy',
): Promise<void> => {
    const draws: string[] = [];
    bboxes.forEach((b, i) => {
        const color = COLORS[i % COLORS.length] ?? 'red';
        const xywh = toXywh(b.bbox, format);
        const x1 = Math.round((xywh[0] / 1000) * page.width);
        const y1 = Math.round((xywh[1] / 1000) * page.height);
        const x2 = Math.round(((xywh[0] + xywh[2]) / 1000) * page.width);
        const y2 = Math.round(((xywh[1] + xywh[3]) / 1000) * page.height);
        draws.push('-fill', FILL_RGBA[color] ?? '#00000022');
        draws.push('-stroke', color, '-strokewidth', '2');
        draws.push('-draw', `rectangle ${x1},${y1} ${x2},${y2}`);
        draws.push('-fill', color, '-stroke', 'none');
        draws.push('-font', '/System/Library/Fonts/Geneva.ttf', '-pointsize', '18');
        draws.push('-draw', `text ${x1 + 2},${Math.max(y1 - 3, 14)} '${i + 1}'`);
    });
    await exec('magick', [page.pngPath, ...draws, outPath], {
        maxBuffer: 1024 * 1024 * 128,
    });
};

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const docArg = args[0];
    if (docArg === undefined) {
        console.error('usage: tsx agent/scripts/bbox-debug.ts <doc-path>');
        process.exit(1);
    }
    const docPath = resolve(docArg);

    if (!process.env['ANTHROPIC_API_KEY']) {
        console.error('ANTHROPIC_API_KEY is not set in env. Source agent/.env first.');
        process.exit(1);
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    const docName = basename(docPath).replace(/\.[^.]+$/, '');

    console.log(`[bbox-debug] doc: ${docPath}`);

    const pages = isPdf(docPath) ? await rasterizePdf(docPath) : await loadImageAsPage(docPath);
    console.log(`[bbox-debug] rasterized ${pages.length} page(s):`);
    for (const p of pages) console.log(`  page ${p.pageNum}: ${p.width}x${p.height}px`);

    const docType = guessDocType(docPath);
    console.log(`[bbox-debug] docType: ${docType}`);

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined) throw new Error('ANTHROPIC_API_KEY missing');
    const client = new Anthropic({ apiKey });
    console.log('[bbox-debug] calling Anthropic…');
    const extraction = await callVision(client, pages, docType);

    // Render the model's raw bboxes first.
    const modelRows = collectBboxes(extraction);
    const modelFormat = detectBboxFormat(modelRows.map((r) => r.bbox));
    console.log(
        `[bbox-debug] model returned ${modelRows.length} bboxes, format=${modelFormat}` +
            (modelFormat === 'xyxy' ? ' (CORNERS — model is ignoring the prompt)' : ''),
    );

    await writeFile(
        join(OUT_DIR, `${docName}.model.extraction.json`),
        JSON.stringify(extraction, null, 2),
        'utf8',
    );

    for (const page of pages) {
        const onPage = modelRows.filter((r) => r.page === page.pageNum);
        await renderOverlay(
            page,
            onPage,
            join(OUT_DIR, `${docName}.page${page.pageNum}.model.png`),
            modelFormat,
        );
    }

    // Run OCR + snap (mirrors the production pipeline post-vision step).
    console.log('[bbox-debug] OCRing pages and snapping…');
    const ocrPages: PageOcr[] = [];
    for (const page of pages) {
        const bytes = await fs.readFile(page.pngPath);
        const ocr = await ocrPage(page.pageNum, bytes, page.width, page.height);
        ocrPages.push(ocr);
        console.log(`  page ${page.pageNum}: ${ocr.words.length} OCR words`);
    }
    const summary = snapExtractionBboxes(extraction, ocrPages);
    console.log(
        `[bbox-debug] snap: ${summary.snappedBboxes}/${summary.totalBboxes} bboxes snapped` +
            ` (format=${summary.formatDetected})`,
    );

    await writeFile(
        join(OUT_DIR, `${docName}.snapped.extraction.json`),
        JSON.stringify(extraction, null, 2),
        'utf8',
    );

    // Render the snapped bboxes — these are now canonical xywh because
    // `snapExtractionBboxes` normalizes corners → xywh in place.
    const snappedRows = collectBboxes(extraction);
    for (const page of pages) {
        const onPage = snappedRows.filter((r) => r.page === page.pageNum);
        await renderOverlay(
            page,
            onPage,
            join(OUT_DIR, `${docName}.page${page.pageNum}.snapped.png`),
            'xywh',
        );
        if (isPdf(docPath)) {
            const sidecar = join(OUT_DIR, `${docName}.page${page.pageNum}.source.png`);
            await fs.copyFile(page.pngPath, sidecar);
        }
        console.log(`[bbox-debug] wrote ${docName}.page${page.pageNum}.{model,snapped}.png`);
    }
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
