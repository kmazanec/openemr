/**
 * Parses cached CDC HTML pages into committed chunk files.
 *
 * Reads agent/.corpus-cache/cdc/<slug>.html (produced by
 * fetch-cdc-corpus.ts). For each page, dispatches on the surface
 * recorded in the fetch manifest:
 *
 *  - acip-notes:           one chunk per per-vaccine `note-*` anchor.
 *  - acip-schedule:        Purpose + How-to-use chunks.
 *  - opioid-landing:       one chunk per top-level <h2> section under <main>.
 *  - sti-clinical-guidance: one chunk per top-level <h2> section under <main>.
 *
 * Body text is the verbatim text content of the corresponding DOM
 * region — no rewrites, no summarization, no model authorship.
 *
 * Pages or sections whose selectors fail are logged as structured
 * warnings and skipped. Re-running after a selector fix is the recovery
 * path; we never invent content.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

import type { CdcSurface } from './fetch-cdc-corpus.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/cdc');
const OUT_DIR = resolve(AGENT_DIR, 'data/corpus/cdc');
const INDEX_PATH = join(OUT_DIR, 'index.json');
const FETCH_MANIFEST_PATH = join(OUT_DIR, 'fetch-manifest.json');

// Section labels we keep on the schedule pages. Ages-by-age sections
// are mostly tabular-with-PDF-link ("Table 1 — By Age") and don't carry
// actionable narrative text without the table; skipping them keeps the
// chunks meaningfully retrievable.
const ACIP_SCHEDULE_SECTIONS: ReadonlyMap<string, string> = new Map([
    ['Purpose', 'purpose'],
    ['How to use the schedule', 'how-to-use'],
]);

// Sections we drop from any landing/index page — pure navigation chrome.
const SKIP_SECTION_LABELS = new Set<string>([
    'On This Page',
    'Additional Information',
    'Download the Schedule',
    'Sources',
    'Print',
    'Share',
]);

interface ChunkFrontmatter {
    publication: 'CDC';
    title: string;
    section: string;
    section_label: string;
    year: number;
    url: string;
    license_tier: 'public_domain';
    slug: string;
    surface: CdcSurface;
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
    readonly url: string;
    readonly surface: CdcSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

interface FetchManifest {
    readonly source: 'cdc';
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
    readonly surface: CdcSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

interface CorpusIndex {
    readonly source: 'cdc';
    readonly publication: 'CDC';
    readonly license_tier: 'public_domain';
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
    return normalizeWhitespace($('main h1').first().text());
}

/**
 * CDC pages don't expose a structured publication-year field. We do a
 * conservative lookup: the page-title-bar `<time>` (a maintained "last
 * updated" date) → meta tag → fall through to current year. This is the
 * year used in chunk frontmatter for ranking / display; it isn't
 * authoritative beyond "the publisher had this state on or before this
 * year."
 */
function parseYear($: cheerio.CheerioAPI): number {
    const dt = $('main time[datetime]').first().attr('datetime');
    if (dt) {
        const y = Number(dt.slice(0, 4));
        if (Number.isFinite(y) && y > 1990) return y;
    }
    const meta = $('meta[name="cdc:last_updated"]').attr('content');
    if (meta) {
        const y = Number(meta.slice(0, 4));
        if (Number.isFinite(y) && y > 1990) return y;
    }
    return new Date().getUTCFullYear();
}

/**
 * Returns a cheerio object scoped to the `<main>` element, or null if
 * the page has no `<main>` (CDC has shipped the same template for
 * years, but we fail loudly if a page deviates rather than silently
 * picking up nav chrome).
 */
function getMainScope($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> | null {
    const main = $('main').first();
    if (main.length === 0) return null;
    return main;
}

/**
 * Walks the children of `main` and groups text by top-level <h2>
 * boundary. Returns one entry per <h2> with the section's collected
 * text (verbatim, whitespace-normalized).
 *
 * We use children-of-main rather than a CSS selector because CDC's
 * pages put each section's body in mixed sibling DOM (paragraphs,
 * div.cdc-textblock, accordions, lists), and an h2-rooted
 * "until-next-h2" walk is more robust than per-section selectors.
 */
function collectBySectionH2(
    $: cheerio.CheerioAPI,
    main: cheerio.Cheerio<AnyNode>,
): { label: string; body: string }[] {
    const sections: { label: string; body: string }[] = [];
    let currentLabel: string | null = null;
    let currentParts: string[] = [];

    const flush = (): void => {
        if (currentLabel === null) return;
        const body = normalizeWhitespace(currentParts.join('\n'));
        sections.push({ label: currentLabel, body });
        currentLabel = null;
        currentParts = [];
    };

    main.children().each((_i, child) => {
        const node = $(child);
        if (node.is('h2')) {
            flush();
            currentLabel = normalizeWhitespace(node.text());
            return;
        }
        // CDC wraps mid-document sections in containers
        // (`<div class="cdc-textblock"><h2>...</h2>...</div>`); split by
        // any h2s the container holds so each section's body is bounded
        // even when boundaries aren't direct children of <main>.
        const innerH2s = node.find('h2').toArray();
        if (innerH2s.length === 0) {
            if (currentLabel !== null) {
                const txt = normalizeWhitespace(node.text());
                if (txt.length > 0) currentParts.push(txt);
            }
            return;
        }
        // Container with one or more h2s — split by them.
        const html = $.html(node);
        const parts = html.split(/<h2\b[^>]*>/i);
        // First piece is pre-h2 content (belongs to whatever section is
        // currently open).
        const preLead = cheerio.load(parts[0] ?? '', null, false).root().text();
        const pre = normalizeWhitespace(preLead);
        if (currentLabel !== null && pre.length > 0) currentParts.push(pre);

        for (let i = 1; i < parts.length; i++) {
            const segment = parts[i];
            if (segment === undefined) continue;
            // Each segment starts with the h2's inner text + closing tag +
            // the rest of the section. Split off the closing </h2>.
            const closeIdx = segment.search(/<\/h2>/i);
            if (closeIdx < 0) continue;
            const labelHtml = segment.slice(0, closeIdx);
            const rest = segment.slice(closeIdx + '</h2>'.length);
            const label = normalizeWhitespace(
                cheerio.load(labelHtml, null, false).root().text(),
            );
            const bodyText = normalizeWhitespace(
                cheerio.load(rest, null, false).root().text(),
            );
            flush();
            currentLabel = label;
            if (bodyText.length > 0) currentParts.push(bodyText);
        }
    });
    flush();

    return sections;
}

function dropChromeSections(
    sections: readonly { label: string; body: string }[],
): { label: string; body: string }[] {
    return sections.filter((s) => !SKIP_SECTION_LABELS.has(s.label) && s.body.length > 0);
}

export function extractAcipSchedule($: cheerio.CheerioAPI, slug: string): ExtractResult {
    const warnings: string[] = [];
    const main = getMainScope($);
    const url = parseUrl($);
    const title = parseTitle($);
    const year = parseYear($);
    if (!main) {
        warnings.push('missing-main');
        return { slug, chunks: [], title, year, url, warnings };
    }
    if (!title) warnings.push('missing-title');

    const sections = dropChromeSections(collectBySectionH2($, main));
    const chunks: RawChunk[] = [];
    for (const { label, body } of sections) {
        const sectionSlug = ACIP_SCHEDULE_SECTIONS.get(label);
        if (!sectionSlug) continue;
        chunks.push({ section: sectionSlug, section_label: label, body });
    }
    if (chunks.length === 0) warnings.push('no-recognized-sections');
    return { slug, chunks, title, year, url, warnings };
}

/**
 * ACIP notes pages: one chunk per per-vaccine note, sub-divided by the
 * publisher's accordion sections when present.
 *
 * Each note is announced by an `<a id="note-<vaccine>">` anchor inside
 * an `<h3>` inside a `<div class="cdc-textblock">`. Most notes contain
 * an `<div class="accordions">` with 2–4 `accordion-button` headers
 * (Routine vaccination, Special situations, Catch-up vaccination,
 * Contraindications and Precautions, etc.) — those headers are the
 * publisher's natural sub-section boundaries and we emit one chunk per
 * accordion section. The COVID-19 notes in particular cascade all
 * manufacturer × age × prior-dose combinations into one note section
 * and exceed OpenAI's 8192-token embedding limit if kept whole;
 * splitting at the accordion boundary keeps every chunk under the
 * limit and matches the publisher's own clinical structure.
 *
 * Notes without accordions stay a single chunk (the small ones).
 */
export function extractAcipNotes($: cheerio.CheerioAPI, slug: string): ExtractResult {
    const warnings: string[] = [];
    const main = getMainScope($);
    const url = parseUrl($);
    const title = parseTitle($);
    const year = parseYear($);
    if (!main) {
        warnings.push('missing-main');
        return { slug, chunks: [], title, year, url, warnings };
    }
    if (!title) warnings.push('missing-title');

    const chunks: RawChunk[] = [];
    const seen = new Set<string>();

    // The DOM is heterogeneous between the adult-notes and
    // child-adolescent-notes pages: adult puts each note's heading and
    // accordions in their own `cdc-textblock`, while child wraps all 19
    // vaccine notes in a single shared `cdc-textblock` with anchors and
    // accordion-items intermixed. Closest-textblock-as-boundary doesn't
    // work for the child-page shape. Instead, walk every `note-*` anchor
    // and every `accordion-item` in document order: each accordion-item
    // belongs to the most recently seen note anchor.
    const anchors = main.find('a[id^="note-"]').toArray();
    const items = main.find('div.accordion-item').toArray();

    interface Event {
        readonly kind: 'anchor' | 'item';
        readonly node: AnyNode;
    }
    // We need an order on AnyNode. cheerio gives us this via the
    // dom-serializer position fields, but the simplest cross-version
    // approach is to re-derive order by walking `main` once and
    // assigning indices.
    const order = new Map<AnyNode, number>();
    let counter = 0;
    const indexAll = (node: AnyNode): void => {
        order.set(node, counter);
        counter += 1;
        const children = (node as { children?: AnyNode[] }).children ?? [];
        for (const c of children) indexAll(c);
    };
    indexAll(main.get(0)!);

    const events: Event[] = [
        ...anchors.map<Event>((node) => ({ kind: 'anchor' as const, node })),
        ...items.map<Event>((node) => ({ kind: 'item' as const, node })),
    ].sort((a, b) => (order.get(a.node) ?? 0) - (order.get(b.node) ?? 0));

    interface NoteState {
        readonly id: string;
        readonly heading: string;
        readonly accordionItems: AnyNode[];
    }
    const notes = new Map<string, NoteState>();
    const noteOrder: string[] = [];
    let currentId: string | null = null;
    for (const ev of events) {
        if (ev.kind === 'anchor') {
            const id = $(ev.node).attr('id');
            if (!id || seen.has(id)) {
                currentId = id ?? null;
                continue;
            }
            seen.add(id);
            // Heading is the closest h3 containing this anchor (or the anchor's
            // parent h3, since the publisher puts <a id="note-*"> inside <h3>).
            const heading = normalizeWhitespace($(ev.node).closest('h3').first().text());
            if (!heading) {
                warnings.push(`missing-heading:${id}`);
                currentId = null;
                continue;
            }
            notes.set(id, { id, heading, accordionItems: [] });
            noteOrder.push(id);
            currentId = id;
        } else {
            if (!currentId) continue;
            const state = notes.get(currentId);
            if (state) state.accordionItems.push(ev.node);
        }
    }

    // Emit chunks per note. Notes with accordion-items get one chunk per
    // accordion section (each titled "<vaccine> — <sub-label>"); notes
    // without accordion-items get one whole-textblock chunk. Splitting at
    // accordion boundaries keeps every chunk under OpenAI's 8192-token
    // embedding limit; the unsplit COVID note exceeds it (see commit log).
    for (const id of noteOrder) {
        const state = notes.get(id);
        if (!state) continue;
        const { heading, accordionItems } = state;
        if (accordionItems.length === 0) {
            // Fall back to the heading's containing textblock for the body.
            // The adult-page pattern: heading-only-textblock is rare on the
            // adult page (most notes are accordion-bearing); this branch
            // catches only the very small notes with no sub-structure.
            const headingBlock = $(`a#${id}`).closest('div.cdc-textblock').first();
            const body = normalizeWhitespace(headingBlock.text());
            const trailing = normalizeWhitespace(
                body.slice(body.indexOf(heading) + heading.length),
            );
            if (!trailing) {
                warnings.push(`empty-section:${id}`);
                continue;
            }
            chunks.push({ section: id, section_label: heading, body });
            continue;
        }
        let emitted = 0;
        for (const item of accordionItems) {
            const itemNode = $(item);
            const subLabel = normalizeWhitespace(
                itemNode.find('button.accordion-button').first().text(),
            );
            if (!subLabel) {
                warnings.push(`missing-accordion-label:${id}`);
                continue;
            }
            const itemText = normalizeWhitespace(itemNode.text());
            const subBody = normalizeWhitespace(
                itemText.slice(itemText.indexOf(subLabel) + subLabel.length),
            );
            if (!subBody) {
                warnings.push(`empty-accordion:${id}/${subLabel}`);
                continue;
            }
            const subSlug = slugify(subLabel);
            const body = `${heading} — ${subLabel}\n\n${subBody}`;
            chunks.push({
                section: `${id}--${subSlug}`,
                section_label: `${heading} — ${subLabel}`,
                body,
            });
            emitted += 1;
        }
        if (emitted === 0) {
            warnings.push(`no-emitted-accordions:${id}`);
        }
    }

    if (chunks.length === 0 && seen.size === 0) warnings.push('no-note-anchors');
    return { slug, chunks, title, year, url, warnings };
}

/**
 * Generic h2-section extractor for landing/index pages where each h2
 * is a coherent unit (CDC opioid landing, STI clinical-guidance pages).
 * Drops nav chrome by section label.
 */
function extractGenericH2Sections($: cheerio.CheerioAPI, slug: string): ExtractResult {
    const warnings: string[] = [];
    const main = getMainScope($);
    const url = parseUrl($);
    const title = parseTitle($);
    const year = parseYear($);
    if (!main) {
        warnings.push('missing-main');
        return { slug, chunks: [], title, year, url, warnings };
    }
    if (!title) warnings.push('missing-title');

    const sections = dropChromeSections(collectBySectionH2($, main));
    const chunks: RawChunk[] = sections.map((s) => ({
        section: slugify(s.label),
        section_label: s.label,
        body: s.body,
    }));
    if (chunks.length === 0) warnings.push('no-content-sections');
    return { slug, chunks, title, year, url, warnings };
}

export function extractOpioidLanding($: cheerio.CheerioAPI, slug: string): ExtractResult {
    return extractGenericH2Sections($, slug);
}

export function extractStiClinicalGuidance($: cheerio.CheerioAPI, slug: string): ExtractResult {
    return extractGenericH2Sections($, slug);
}

export function extractFromHtml(
    surface: CdcSurface,
    slug: string,
    html: string,
): ExtractResult {
    const $ = cheerio.load(html);
    switch (surface) {
        case 'acip-schedule':
            return extractAcipSchedule($, slug);
        case 'acip-notes':
            return extractAcipNotes($, slug);
        case 'opioid-landing':
            return extractOpioidLanding($, slug);
        case 'sti-clinical-guidance':
            return extractStiClinicalGuidance($, slug);
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
            `[extract] fetch-manifest.json not found at ${FETCH_MANIFEST_PATH}; run 'npm run corpus:fetch:cdc' first`,
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
            `[extract] cache not found at ${CACHE_DIR}; run 'npm run corpus:fetch:cdc' first`,
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
                console.warn(`[extract] cdc/${slug}: ${w}`);
            }
        }

        for (const chunk of result.chunks) {
            const fm: ChunkFrontmatter = {
                publication: 'CDC',
                title: result.title,
                section: chunk.section,
                section_label: chunk.section_label,
                year: result.year,
                url: result.url,
                license_tier: 'public_domain',
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

    indexEntries.sort((a, b) => a.file.localeCompare(b.file));
    const index: CorpusIndex = {
        source: 'cdc',
        publication: 'CDC',
        license_tier: 'public_domain',
        chunk_count: indexEntries.length,
        chunks: indexEntries,
    };
    await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

    console.log(
        `[extract] done: ${pages} pages processed, ${written} chunks written, ${pagesWithWarnings} pages with warnings`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
