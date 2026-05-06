/**
 * Parses cached PMC pages of the ADA Standards of Care into committed
 * chunk files.
 *
 * Reads agent/.corpus-cache/ada/<slug>.html (produced by
 * fetch-ada-corpus.ts). Every ADA target shares the same PMC article
 * shape (a single surface, `pmc-section`):
 *
 *   <main>
 *     <section class="body main-article-body">
 *       <section class="abstract"> <h2>Abstract</h2> ... </section>
 *       <section id="s1"> <h2 class="pmc_sec_title">Topic 1</h2> ... </section>
 *       <section id="s2"> <h2 class="pmc_sec_title">Topic 2</h2> ... </section>
 *       ...
 *       <section id="footnotes"> <h2>Footnotes</h2> ... </section>
 *       <section id="contributors"> <h2>Contributor Information</h2> ... </section>
 *       <section id="references"> <h2>References</h2> ... </section>
 *     </section>
 *   </main>
 *
 * The extractor walks every direct h2 inside the main-article-body and
 * emits one chunk per topic. Chrome topics (Footnotes, Contributor
 * Information, References, plus a small label-drop set) are filtered
 * out — we keep the abstract and every clinical topic.
 *
 * Body text is the verbatim text content of the topic's section — no
 * rewrites, no summarization, no model authorship.
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

import type { AdaSurface } from './fetch-ada-corpus.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/ada');
const OUT_DIR = resolve(AGENT_DIR, 'data/corpus/ada');
const INDEX_PATH = join(OUT_DIR, 'index.json');
const FETCH_MANIFEST_PATH = join(OUT_DIR, 'fetch-manifest.json');

// Char-based proxy for the OpenAI embedding model's 8192-token input
// limit. English text averages ~4 chars/token; we set the threshold at
// ~6000 tokens to leave a safety margin for variable tokenization
// (medical terminology, em-dashes, evidence-grade glyphs). Sections
// over this size are split at <h3 class="pmc_sec_title"> boundaries —
// the publisher's natural sub-topic boundary, mirroring I.1's CDC
// accordion split.
const DEFAULT_MAX_CHUNK_CHARS = 24_000;

// Section labels we drop from any PMC article — bibliography,
// disclosures, contributor lists. These carry no clinical guidance and
// would dilute retrieval. The match is case-sensitive against the
// h2's normalized text.
const SKIP_SECTION_LABELS: ReadonlySet<string> = new Set([
    'References',
    'Footnotes',
    'Contributor Information',
    'Article information',
    'Author Contributions',
    'Funding Statement',
    'Conflict of Interest',
    'Acknowledgments',
]);

interface ChunkFrontmatter {
    publication: 'ADA';
    title: string;
    section: string;
    section_label: string;
    year: number;
    url: string;
    publisher_url: string;
    license_tier: 'fair_use_cds';
    slug: string;
    surface: AdaSurface;
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
    readonly surface: AdaSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

interface FetchManifest {
    readonly source: 'ada';
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
    readonly surface: AdaSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

interface CorpusIndex {
    readonly source: 'ada';
    readonly publication: 'ADA';
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
 * (e.g. "2025 Dec 8"). We pull the leading 4-digit year. This is the
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
 * Walks every direct-or-nested h2 under the article body and groups
 * the body text by h2 boundary. Each h2 starts a new section; text
 * up to the next h2 (in document order) is the section body.
 *
 * PMC nests each topic in its own `<section id="sN">` wrapper, but we
 * walk h2s rather than sections so the abstract (which is often a
 * peer `<section class="abstract">` rather than a numbered `sN`)
 * groups correctly into one chunk by its leading h2.
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

    // h2 elements in document order under the body, regardless of how
    // deeply they're nested.
    const h2s = body.find('h2').toArray();
    if (h2s.length === 0) return sections;

    for (const h2 of h2s) {
        const $h2 = $(h2);
        const label = normalizeWhitespace($h2.text());
        // The section that contains this h2. The h2 itself starts the
        // section; any prose-bearing siblings of the h2 (or descendants
        // of those siblings) belong to it. We use the h2's enclosing
        // <section> if present; otherwise we walk forward sibling-by-
        // sibling until the next h2.
        const enclosing = $h2.parent();
        let bodyText: string;
        let sectionEl: cheerio.Cheerio<AnyNode> | null = null;
        if (enclosing.is('section')) {
            sectionEl = enclosing;
            // Take the enclosing section's text minus the h2's own text.
            const fullText = normalizeWhitespace(enclosing.text());
            // Remove the leading h2 label so the body reads cleanly.
            const idx = fullText.indexOf(label);
            bodyText = idx === 0 ? fullText.slice(label.length).trimStart() : fullText;
        } else {
            // Fallback: walk siblings forward until the next h2.
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
 * Splits an oversize h2 section into one chunk per `<h3 class="pmc_sec_title">`
 * sub-section. Returns the sub-chunks in document order, or null if
 * the section has no h3s to split at (caller logs an oversize warning
 * and skips — we never silently truncate).
 *
 * Each sub-chunk's section_label uses the convention `<h2-label> — <h3-label>`
 * (em-dash separator, mirroring I.1's CDC accordion-split convention),
 * and the body opens with the same labels so retrieval has clean topical
 * framing even when chunks are surfaced in isolation.
 */
function splitAtH3Boundaries(
    $: cheerio.CheerioAPI,
    h2Label: string,
    h2Slug: string,
    enclosing: cheerio.Cheerio<AnyNode>,
): SubChunk[] | null {
    const h3s = enclosing.find('h3.pmc_sec_title').toArray();
    if (h3s.length === 0) return null;

    const sub: SubChunk[] = [];
    for (const h3 of h3s) {
        const $h3 = $(h3);
        const subLabel = normalizeWhitespace($h3.text());
        if (!subLabel) continue;
        // Each h3 lives inside its own <section> wrapper on PMC pages;
        // we use the h3's direct parent as the body container.
        const subContainer = $h3.parent();
        const fullText = normalizeWhitespace(subContainer.text());
        const idx = fullText.indexOf(subLabel);
        const subBodyText =
            idx === 0 ? fullText.slice(subLabel.length).trimStart() : fullText;
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
        // own h3 sub-topic boundary; if that fails, refuse to emit (a
        // 24K+-char chunk is guaranteed to fail OpenAI's 8192-token
        // input limit and we never silently truncate verbatim guideline
        // text).
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
    surface: AdaSurface,
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
            `[extract] fetch-manifest.json not found at ${FETCH_MANIFEST_PATH}; run 'npm run corpus:fetch:ada' first`,
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
            `[extract] cache not found at ${CACHE_DIR}; run 'npm run corpus:fetch:ada' first`,
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
                console.warn(`[extract] ada/${slug}: ${w}`);
            }
        }

        for (const chunk of result.chunks) {
            const fm: ChunkFrontmatter = {
                publication: 'ADA',
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
    // boundaries, the unsplit `<slug>--<h2>.md` should disappear). Without
    // this, the chunk dir accumulates ghost files across re-runs and the
    // reindex script ends up upserting orphan vectors with no fresh
    // provenance.
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
        source: 'ada',
        publication: 'ADA',
        license_tier: 'fair_use_cds',
        chunk_count: indexEntries.length,
        chunks: indexEntries,
    };
    await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

    console.log(
        `[extract] done: ${pages} pages processed, ${written} chunks written, ${removed} stale chunks removed, ${pagesWithWarnings} pages with warnings`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
