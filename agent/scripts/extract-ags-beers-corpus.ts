/**
 * Parses the cached PMC page of the 2023 AGS Beers Criteria into
 * committed chunk files.
 *
 * Reads agent/.corpus-cache/ags-beers/<slug>.html (produced by
 * fetch-ags-beers-corpus.ts). The article shares the same PMC article
 * shape as ADA (a single surface, `pmc-section`):
 *
 *   <main>
 *     <section class="body main-article-body">
 *       <section class="abstract"> <h2>Abstract</h2> ... </section>
 *       <section id="S1"> <h2 class="pmc_sec_title">INTRODUCTION</h2>
 *         ...intro prose...
 *         <section class="tw xbox" id="T2"> <h3 class="obj_head">TABLE 2.</h3>
 *           <div class="caption p"><p>...table caption...</p></div>
 *           ...table body...
 *         </section>
 *         <section class="tw xbox" id="T3"> ... </section>
 *         ...
 *       </section>
 *       <section id="S2"> <h2 class="pmc_sec_title">METHODS</h2> ... </section>
 *       ...
 *       <section id="footnotes"> <h2>Footnotes</h2> ... </section>
 *       <section id="bibliography"> <h2>REFERENCES</h2> ... </section>
 *     </section>
 *   </main>
 *
 * The extractor walks every direct h2 inside the main-article-body and
 * emits one chunk per topic. AGS-specific chrome (REFERENCES,
 * Footnotes, ACKNOWLEDGMENTS, APPENDIX A, FUNDING INFORMATION,
 * Supplementary Material, Associated Data) is filtered out. We keep
 * the abstract and every clinical topic (INTRODUCTION, METHODS,
 * RESULTS, DISCUSSION, CONCLUSION).
 *
 * Body text is the verbatim text content of the topic's section — no
 * rewrites, no summarization, no model authorship.
 *
 * The Beers paper's `INTRODUCTION` section embeds the five Beers
 * criteria tables as PMC table-figures (`<section class="tw xbox"
 * id="T2">` … `id="T6">`) whose headers are `<h3 class="obj_head">`,
 * not `<h3 class="pmc_sec_title">`. The h3-splitter recognizes both
 * classes so an over-threshold INTRODUCTION splits cleanly at the
 * table-figure boundaries. When an h3.obj_head's text is a bare table
 * label ("TABLE 2."), we substitute the immediately-following
 * `<div class="caption p">` content as the section_label so the chunk
 * is retrievably named ("2023 American Geriatrics Society Beers
 * Criteria® …") rather than "TABLE 2.".
 *
 * Pages whose article-body container is missing log a structured
 * warning and emit zero chunks. Empty topics log a per-section warning
 * and skip. Re-running after a fix is the recovery path; we never
 * invent content.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

import type { AgsBeersSurface } from './fetch-ags-beers-corpus.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/ags-beers');
const OUT_DIR = resolve(AGENT_DIR, 'data/corpus/ags-beers');
const INDEX_PATH = join(OUT_DIR, 'index.json');
const FETCH_MANIFEST_PATH = join(OUT_DIR, 'fetch-manifest.json');

// Char-based proxy for the OpenAI embedding model's 8192-token input
// limit. English text averages ~4 chars/token; ~6000 tokens leaves a
// safety margin for variable tokenization (medical terminology, em-
// dashes, evidence-grade glyphs). Sections over this size are split at
// `<h3 class="pmc_sec_title">` or `<h3 class="obj_head">` boundaries
// — the former is PMC's general sub-topic boundary; the latter is the
// table-figure boundary used by the Beers paper for its five criteria
// tables.
const DEFAULT_MAX_CHUNK_CHARS = 24_000;

// Section labels we drop from the article body — bibliography,
// disclosures, contributor lists, panel rosters, funding statements.
// These carry no clinical guidance and would dilute retrieval. The
// match is case-sensitive against the h2's normalized text. The set
// extends ADA's drop list with AGS-specific labels surfaced during
// chunk review against the real Beers article.
const SKIP_SECTION_LABELS: ReadonlySet<string> = new Set([
    // Shared with ADA
    'References',
    'REFERENCES',
    'Footnotes',
    'Contributor Information',
    'Article information',
    'Author Contributions',
    'Funding Statement',
    'Conflict of Interest',
    'Acknowledgments',
    // AGS-specific (case differs in the source HTML)
    'ACKNOWLEDGMENTS',
    'FUNDING INFORMATION',
    'Supplementary Material',
    'Associated Data',
    'APPENDIX A: PANEL MEMBERS AND AFFILIATIONS',
]);

interface ChunkFrontmatter {
    publication: 'AGS-Beers';
    title: string;
    section: string;
    section_label: string;
    year: number;
    url: string;
    publisher_url: string;
    license_tier: 'fair_use_cds';
    slug: string;
    surface: AgsBeersSurface;
    fetched_at: string;
    content_sha256: string;
}

interface RawChunk {
    readonly section: string;
    readonly section_label: string;
    readonly body: string;
}

export interface ExtractResult {
    readonly slug: string;
    readonly chunks: readonly RawChunk[];
    readonly title: string;
    readonly year: number;
    readonly url: string;
    readonly warnings: readonly string[];
}

interface FetchManifestEntry {
    readonly slug: string;
    readonly pmc_id: string;
    readonly url: string;
    readonly publisher_url: string;
    readonly surface: AgsBeersSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

interface FetchManifest {
    readonly source: 'ags-beers';
    readonly fetcher_version: string;
    readonly first_run_at: string;
    readonly last_run_at: string;
    readonly entries: readonly FetchManifestEntry[];
}

interface IndexEntryFile {
    readonly file: string;
    readonly slug: string;
    readonly section: string;
    readonly title: string;
    readonly year: number;
    readonly url: string;
    readonly publisher_url: string;
    readonly surface: AgsBeersSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

interface CorpusIndex {
    readonly source: 'ags-beers';
    readonly publication: 'AGS-Beers';
    readonly license_tier: 'fair_use_cds';
    readonly chunk_count: number;
    readonly chunks: readonly IndexEntryFile[];
}

function normalizeWhitespace(text: string): string {
    return text
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function slugify(label: string): string {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function parseUrl($: cheerio.CheerioAPI): string {
    const canonical = $('link[rel="canonical"]').attr('href');
    if (canonical) return canonical.trim();
    const og = $('meta[property="og:url"]').attr('content');
    return og?.trim() ?? '';
}

function parseTitle($: cheerio.CheerioAPI): string {
    const meta = $('meta[name="citation_title"]').attr('content');
    if (meta) return normalizeWhitespace(meta);
    return normalizeWhitespace($('main h1').first().text());
}

/**
 * PMC carries the article's publication date in
 * `<meta name="citation_publication_date">` as a free-form date
 * (e.g. "2023 Jul"). We pull the leading 4-digit year. This is the
 * year used in chunk frontmatter for ranking / display; it isn't
 * authoritative beyond "the publisher posted this on or after this
 * year."
 */
function parseYear($: cheerio.CheerioAPI): number {
    const date = $('meta[name="citation_publication_date"]').attr('content');
    if (date) {
        const match = /(\d{4})/.exec(date);
        if (match) {
            const y = Number(match[1]);
            if (Number.isFinite(y) && y > 1990) return y;
        }
    }
    return new Date().getUTCFullYear();
}

/**
 * Returns a cheerio object scoped to the article-body element (the
 * PMC `<section class="body main-article-body">` container), or null
 * if the page is missing it.
 */
function getArticleBody($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> | null {
    const body = $('section.body.main-article-body').first();
    if (body.length === 0) return null;
    return body;
}

interface CollectedSection {
    readonly label: string;
    readonly body: string;
    readonly enclosing: cheerio.Cheerio<AnyNode> | null;
}

/**
 * Walks every h2 under the article body and groups the body text by
 * h2 boundary. Each h2 starts a new section; text up to the next h2
 * (in document order) is the section body.
 *
 * The enclosing element is returned alongside the body text so the
 * caller can re-walk sub-headings (h3s) on oversize sections without
 * re-parsing the document.
 */
function collectBySectionH2(
    $: cheerio.CheerioAPI,
    body: cheerio.Cheerio<AnyNode>,
): CollectedSection[] {
    const sections: CollectedSection[] = [];

    const h2s = body.find('h2').toArray();
    if (h2s.length === 0) return sections;

    for (const h2 of h2s) {
        const $h2 = $(h2);
        const label = normalizeWhitespace($h2.text());
        const enclosing = $h2.parent();
        let bodyText: string;
        let sectionEl: cheerio.Cheerio<AnyNode> | null = null;
        if (enclosing.is('section')) {
            sectionEl = enclosing;
            const fullText = normalizeWhitespace(enclosing.text());
            const idx = fullText.indexOf(label);
            bodyText = idx === 0 ? fullText.slice(label.length).trimStart() : fullText;
        } else {
            const parts: string[] = [];
            let cursor = $h2[0]?.next ?? null;
            while (cursor) {
                const $cur = $(cursor);
                if ($cur.is('h2')) break;
                if ('children' in cursor || 'data' in cursor) {
                    const txt = normalizeWhitespace($cur.text?.() ?? '');
                    if (txt.length > 0) parts.push(txt);
                }
                cursor = cursor.next;
            }
            bodyText = normalizeWhitespace(parts.join('\n'));
        }
        sections.push({ label, body: bodyText, enclosing: sectionEl });
    }

    return sections;
}

interface SubChunk {
    readonly section: string;
    readonly section_label: string;
    readonly body: string;
}

/**
 * For an h3.obj_head whose own text is a bare table label
 * ("TABLE 2."), look at the immediately-following
 * `<div class="caption p">` and return its prose. The table caption
 * text is the human-readable description of what the table contains
 * ("2023 American Geriatrics Society Beers Criteria® for potentially
 * inappropriate medication use in older adults") and is far more
 * useful as a chunk's section_label than the bare "TABLE 2." stub.
 *
 * Returns null when the h3 is a regular sub-section header
 * (h3.pmc_sec_title) or when no caption div is present — caller falls
 * back to the h3's own text in those cases.
 */
function tableCaptionLabel(
    $: cheerio.CheerioAPI,
    $h3: cheerio.Cheerio<AnyNode>,
): string | null {
    if (!$h3.hasClass('obj_head')) return null;
    const caption = $h3.next('div.caption');
    if (caption.length === 0) return null;
    const text = normalizeWhitespace(caption.text());
    return text.length > 0 ? text : null;
}

/**
 * Splits an oversize h2 section into one chunk per h3 sub-section,
 * matching either `h3.pmc_sec_title` (PMC's standard sub-topic
 * boundary) or `h3.obj_head` (PMC's table-figure boundary). The Beers
 * paper's `INTRODUCTION` section embeds five table-figures whose
 * headers use `obj_head`, not `pmc_sec_title`; without recognizing
 * `obj_head` the splitter would emit `oversize-no-h3-boundaries` and
 * drop the criteria tables that are the heart of the document.
 *
 * For h3.obj_head whose own text is a bare table label ("TABLE 2."),
 * the section_label substitutes the table's caption text so retrieval
 * has clean topical framing.
 *
 * Returns null when the section has no recognized h3 sub-headings to
 * split at — caller logs an oversize warning and skips. We never
 * silently truncate.
 */
function splitAtH3Boundaries(
    $: cheerio.CheerioAPI,
    h2Label: string,
    h2Slug: string,
    enclosing: cheerio.Cheerio<AnyNode>,
): SubChunk[] | null {
    const h3s = enclosing.find('h3.pmc_sec_title, h3.obj_head').toArray();
    if (h3s.length === 0) return null;

    const sub: SubChunk[] = [];
    for (const h3 of h3s) {
        const $h3 = $(h3);
        const ownText = normalizeWhitespace($h3.text());
        if (!ownText) continue;
        // For Beers table-figures, prefer the caption text over the
        // bare "TABLE 2." stub.
        const captionLabel = tableCaptionLabel($, $h3);
        const subLabel = captionLabel ?? ownText;
        // Each h3 lives inside its own <section> wrapper on PMC pages;
        // we use the h3's direct parent as the body container.
        const subContainer = $h3.parent();
        const fullText = normalizeWhitespace(subContainer.text());
        // Strip the leading h3 text from the body so the chunk doesn't
        // open with "TABLE 2." (or the regular h3 label) restated.
        const idx = fullText.indexOf(ownText);
        const subBodyText = idx === 0 ? fullText.slice(ownText.length).trimStart() : fullText;
        if (!subBodyText) continue;
        const subSlug = slugify(subLabel);
        sub.push({
            section: `${h2Slug}--${subSlug}`,
            section_label: `${h2Label} — ${subLabel}`,
            body: `${h2Label} — ${subLabel}\n\n${subBodyText}`,
        });
    }
    return sub.length > 0 ? sub : null;
}

export interface ExtractOptions {
    readonly maxChunkChars?: number;
}

export function extractPmcSection(
    $: cheerio.CheerioAPI,
    slug: string,
    options: ExtractOptions = {},
): ExtractResult {
    const warnings: string[] = [];
    const url = parseUrl($);
    const title = parseTitle($);
    const year = parseYear($);
    const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;

    const body = getArticleBody($);
    if (!body) {
        warnings.push('missing-article-body');
        return { slug, chunks: [], title, year, url, warnings };
    }
    if (!title) warnings.push('missing-title');

    const sections = collectBySectionH2($, body);
    const chunks: RawChunk[] = [];
    for (const { label, body: sectionBody, enclosing } of sections) {
        if (SKIP_SECTION_LABELS.has(label)) continue;
        if (sectionBody.length === 0) {
            warnings.push(`empty-section:${label}`);
            continue;
        }
        const h2Slug = slugify(label);
        if (sectionBody.length <= maxChunkChars) {
            chunks.push({ section: h2Slug, section_label: label, body: sectionBody });
            continue;
        }
        // Over the embedding-input limit. Try to split at the publisher's
        // own h3 sub-topic or table-figure boundary; if neither exists,
        // refuse to emit (a 24K+-char chunk is guaranteed to fail
        // OpenAI's 8192-token input limit and we never silently
        // truncate verbatim guideline text).
        const sub = enclosing
            ? splitAtH3Boundaries($, label, h2Slug, enclosing)
            : null;
        if (!sub) {
            warnings.push(`oversize-no-h3-boundaries:${label}`);
            continue;
        }
        for (const s of sub) {
            chunks.push({
                section: s.section,
                section_label: s.section_label,
                body: s.body,
            });
        }
    }
    if (chunks.length === 0 && sections.length > 0) warnings.push('no-content-sections');
    return { slug, chunks, title, year, url, warnings };
}

export function extractFromHtml(
    surface: AgsBeersSurface,
    slug: string,
    html: string,
    options: ExtractOptions = {},
): ExtractResult {
    const $ = cheerio.load(html);
    switch (surface) {
        case 'pmc-section':
            return extractPmcSection($, slug, options);
    }
}

// Match the repo's pretty-format-json pre-commit hook output, which
// runs Python's json.dumps with the default ensure_ascii=True and
// escapes every code point ≥ U+0080 to \uXXXX. JSON.stringify by
// default emits the raw UTF-8, so the hook would auto-fix the file
// on every commit — and on PRs touching index.json that drift surfaces
// as a cycle of "stage → hook rewrites → conflict on apply." Pre-encode
// here so the file we write is byte-identical to the hook's expected
// output and the hook is a no-op.
function stringifyAsciiJson(value: unknown): string {
    const raw = JSON.stringify(value, null, 2);
    return raw.replace(/[-￿]/g, (c) => {
        const code = c.charCodeAt(0).toString(16).padStart(4, '0');
        return `\\u${code}`;
    });
}

function frontmatterToYaml(fm: ChunkFrontmatter): string {
    const escape = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return [
        '---',
        `publication: ${fm.publication}`,
        `title: ${escape(fm.title)}`,
        `section: ${fm.section}`,
        `section_label: ${escape(fm.section_label)}`,
        `year: ${fm.year}`,
        `url: ${escape(fm.url)}`,
        `publisher_url: ${escape(fm.publisher_url)}`,
        `license_tier: ${fm.license_tier}`,
        `slug: ${fm.slug}`,
        `surface: ${fm.surface}`,
        `fetched_at: ${escape(fm.fetched_at)}`,
        `content_sha256: ${escape(fm.content_sha256)}`,
        '---',
        '',
    ].join('\n');
}

async function loadFetchManifest(): Promise<FetchManifest | null> {
    try {
        const buf = await readFile(FETCH_MANIFEST_PATH, 'utf8');
        return JSON.parse(buf) as FetchManifest;
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });

    const fetchManifest = await loadFetchManifest();
    if (!fetchManifest) {
        console.error(
            `[extract] fetch-manifest.json not found at ${FETCH_MANIFEST_PATH}; run 'npm run corpus:fetch:ags-beers' first`,
        );
        process.exit(1);
    }
    const provenanceBySlug = new Map<string, FetchManifestEntry>(
        fetchManifest.entries.map((e) => [e.slug, e]),
    );

    let cached: string[];
    try {
        const all = await readdir(CACHE_DIR);
        cached = all.filter((f) => f.endsWith('.html'));
    } catch {
        console.error(
            `[extract] cache not found at ${CACHE_DIR}; run 'npm run corpus:fetch:ags-beers' first`,
        );
        process.exit(1);
    }

    if (cached.length === 0) {
        console.error(`[extract] no cached HTML files in ${CACHE_DIR}`);
        process.exit(1);
    }

    cached.sort();
    console.log(`[extract] processing ${cached.length} cached pages`);

    const indexEntries: IndexEntryFile[] = [];
    let pages = 0;
    let written = 0;
    let pagesWithWarnings = 0;
    const slugsMissingProvenance: string[] = [];

    for (const fname of cached) {
        const slug = fname.replace(/\.html$/, '');
        const provenance = provenanceBySlug.get(slug);
        if (!provenance) {
            slugsMissingProvenance.push(slug);
            continue;
        }
        const html = await readFile(join(CACHE_DIR, fname), 'utf8');
        const result = extractFromHtml(provenance.surface, slug, html);
        pages += 1;

        if (result.warnings.length > 0) {
            pagesWithWarnings += 1;
            for (const w of result.warnings) {
                console.warn(`[extract] ags-beers/${slug}: ${w}`);
            }
        }

        for (const chunk of result.chunks) {
            const fm: ChunkFrontmatter = {
                publication: 'AGS-Beers',
                title: result.title,
                section: chunk.section,
                section_label: chunk.section_label,
                year: result.year,
                url: result.url,
                publisher_url: provenance.publisher_url,
                license_tier: 'fair_use_cds',
                slug,
                surface: provenance.surface,
                fetched_at: provenance.fetched_at,
                content_sha256: provenance.content_sha256,
            };
            const file = `${slug}--${chunk.section}.md`;
            const fullPath = join(OUT_DIR, file);
            const contents = `${frontmatterToYaml(fm)}${chunk.body}\n`;
            await writeFile(fullPath, contents, 'utf8');
            indexEntries.push({
                file,
                slug,
                section: chunk.section,
                title: result.title,
                year: result.year,
                url: result.url,
                publisher_url: provenance.publisher_url,
                surface: provenance.surface,
                fetched_at: provenance.fetched_at,
                content_sha256: provenance.content_sha256,
            });
            written += 1;
        }
    }

    if (slugsMissingProvenance.length > 0) {
        console.warn(
            `[extract] ${slugsMissingProvenance.length} cached slug(s) had no manifest entry and were skipped: ${slugsMissingProvenance.join(', ')}`,
        );
    }

    // Remove stale chunk files that are no longer produced by the
    // current extraction (e.g. when an h2 starts splitting at h3
    // boundaries, the unsplit `<slug>--<h2>.md` should disappear).
    const expectedFiles = new Set(indexEntries.map((e) => e.file));
    const existingFiles = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.md'));
    let removed = 0;
    for (const f of existingFiles) {
        if (!expectedFiles.has(f)) {
            await unlink(join(OUT_DIR, f));
            removed += 1;
        }
    }

    indexEntries.sort((a, b) => a.file.localeCompare(b.file));
    const index: CorpusIndex = {
        source: 'ags-beers',
        publication: 'AGS-Beers',
        license_tier: 'fair_use_cds',
        chunk_count: indexEntries.length,
        chunks: indexEntries,
    };
    await writeFile(INDEX_PATH, `${stringifyAsciiJson(index)}\n`, 'utf8');

    console.log(
        `[extract] done: ${pages} pages processed, ${written} chunks written, ${removed} stale chunks removed, ${pagesWithWarnings} pages with warnings`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
