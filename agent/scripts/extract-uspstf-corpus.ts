/**
 * Parses cached USPSTF recommendation HTML into committed chunk files.
 *
 * Reads agent/.corpus-cache/uspstf/<slug>.html (produced by
 * fetch-uspstf-corpus.ts) and emits one markdown chunk per
 * (recommendation, section) under agent/data/corpus/uspstf/. Body text is
 * the verbatim text content of the corresponding DOM section — no
 * rewrites, no summarization, no model authorship.
 *
 * Pages whose selectors fail are logged and skipped; never invented.
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/uspstf');
const OUT_DIR = resolve(AGENT_DIR, 'data/corpus/uspstf');
const INDEX_PATH = join(OUT_DIR, 'index.json');

// Sections we keep, mapped to a normalized chunk-section name. The DOM uses
// the section title as the div id (verbatim, with spaces). We normalize to
// kebab-case for filenames and chunk metadata.
const SECTION_MAP: ReadonlyMap<string, string> = new Map([
    ['recommendation-summary', 'recommendation-summary'],
    ['Importance', 'importance'],
    ['USPSTF Assessment of Magnitude of Net Benefit', 'assessment-of-net-benefit'],
    ['Practice Considerations', 'practice-considerations'],
    ['Clinical Considerations', 'clinical-considerations'],
]);

// LD+JSON shape we need from each page.
interface ArticleLd {
    readonly '@type'?: string;
    readonly headline?: string;
    readonly url?: string;
    readonly datePublished?: string;
    readonly articleSection?: readonly string[];
}

interface ChunkFrontmatter {
    publication: 'USPSTF';
    title: string;
    section: string;
    section_label: string;
    year: number;
    url: string;
    license_tier: 'public_domain';
    slug: string;
}

interface ExtractResult {
    readonly slug: string;
    readonly chunks: readonly { section: string; section_label: string; body: string }[];
    readonly title: string;
    readonly year: number;
    readonly url: string;
    readonly warnings: readonly string[];
}

interface IndexEntryFile {
    readonly file: string;
    readonly slug: string;
    readonly section: string;
    readonly title: string;
    readonly year: number;
    readonly url: string;
}

interface CorpusIndex {
    readonly source: 'uspstf';
    readonly publication: 'USPSTF';
    readonly license_tier: 'public_domain';
    readonly chunk_count: number;
    readonly chunks: readonly IndexEntryFile[];
}

function parseLd($: cheerio.CheerioAPI): ArticleLd | null {
    const scripts = $('script[type="application/ld+json"]');
    for (const el of scripts.toArray()) {
        const text = $(el).text().trim();
        if (!text) continue;
        try {
            const parsed = JSON.parse(text) as unknown;
            if (
                typeof parsed === 'object' &&
                parsed !== null &&
                '@type' in parsed &&
                (parsed as { '@type': string })['@type'] === 'Article'
            ) {
                return parsed as ArticleLd;
            }
        } catch {
            // ignore — try next script
        }
    }
    return null;
}

function normalizeWhitespace(text: string): string {
    return text
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractSection($: cheerio.CheerioAPI, domId: string): string | null {
    // The site uses the literal section title as the div id, including spaces.
    // cheerio supports attribute selectors which sidestep CSS escaping rules.
    const node = $(`div[id="${domId}"]`).first();
    if (node.length === 0) return null;
    const text = normalizeWhitespace(node.text());
    return text.length > 0 ? text : null;
}

function extractRecommendationSummary($: cheerio.CheerioAPI): string | null {
    const node = $('.field--name-field-recommendation-summary').first();
    if (node.length === 0) return null;
    // The summary is a Population/Recommendation/Grade table. We render rows
    // as "Population: ... | Recommendation: ... | Grade: X" so the chunk text
    // remains useful for both keyword and embedding search without losing the
    // tabular semantics.
    const rows = node.find('tr');
    const lines: string[] = [];
    for (const tr of rows.toArray()) {
        const cells = $(tr).find('th, td');
        const cellTexts = cells
            .toArray()
            .map((c) => normalizeWhitespace($(c).text()))
            .filter((t) => t.length > 0);
        if (cellTexts.length > 0) {
            lines.push(cellTexts.join(' | '));
        }
    }
    const joined = lines.join('\n');
    return joined.length > 0 ? joined : null;
}

export function extractFromHtml(slug: string, html: string): ExtractResult {
    const warnings: string[] = [];
    const $ = cheerio.load(html);
    const ld = parseLd($);
    if (!ld) {
        warnings.push('missing-ld-json');
        return { slug, chunks: [], title: '', year: 0, url: '', warnings };
    }

    const title = ld.headline?.trim() ?? '';
    const year = ld.datePublished ? Number(ld.datePublished.slice(0, 4)) : 0;
    const url = ld.url?.trim() ?? '';
    if (!title) warnings.push('missing-title');
    if (!year || Number.isNaN(year)) warnings.push('missing-year');
    if (!url) warnings.push('missing-url');

    const chunks: { section: string; section_label: string; body: string }[] = [];

    // 1) Recommendation summary (always tried; always produced if present).
    const summary = extractRecommendationSummary($);
    if (summary) {
        chunks.push({
            section: 'recommendation-summary',
            section_label: 'Recommendation Summary',
            body: summary,
        });
    } else {
        warnings.push('missing-recommendation-summary');
    }

    // 2) Article sections — only those in our keep list.
    const articleSections = ld.articleSection ?? [];
    for (const sectionTitle of articleSections) {
        const trimmed = sectionTitle.trim();
        const slugSection = SECTION_MAP.get(trimmed);
        if (!slugSection) continue;
        const body = extractSection($, trimmed);
        if (!body) {
            warnings.push(`empty-section:${trimmed}`);
            continue;
        }
        chunks.push({ section: slugSection, section_label: trimmed, body });
    }

    return { slug, chunks, title, year, url, warnings };
}

function frontmatterToYaml(fm: ChunkFrontmatter): string {
    // Hand-rolled emitter — keeps formatting predictable and avoids pulling
    // js-yaml just for write-side stringification. gray-matter handles the
    // read side.
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
        '---',
        '',
    ].join('\n');
}

async function main(): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });

    let cached: string[];
    try {
        const all = await readdir(CACHE_DIR);
        cached = all.filter((f) => f.endsWith('.html'));
    } catch {
        console.error(
            `[extract] cache not found at ${CACHE_DIR}; run 'npm run corpus:fetch:uspstf' first`,
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

    for (const fname of cached) {
        const slug = fname.replace(/\.html$/, '');
        const html = await readFile(join(CACHE_DIR, fname), 'utf8');
        const result = extractFromHtml(slug, html);
        pages += 1;

        if (result.warnings.length > 0) {
            pagesWithWarnings += 1;
            for (const w of result.warnings) {
                console.warn(`[extract] ${slug}: ${w}`);
            }
        }

        for (const chunk of result.chunks) {
            const fm: ChunkFrontmatter = {
                publication: 'USPSTF',
                title: result.title,
                section: chunk.section,
                section_label: chunk.section_label,
                year: result.year,
                url: result.url,
                license_tier: 'public_domain',
                slug: result.slug,
            };
            const file = `${slug}--${chunk.section}.md`;
            const fullPath = join(OUT_DIR, file);
            const contents = `${frontmatterToYaml(fm)}${chunk.body}\n`;
            await writeFile(fullPath, contents, 'utf8');
            indexEntries.push({
                file,
                slug: result.slug,
                section: chunk.section,
                title: result.title,
                year: result.year,
                url: result.url,
            });
            written += 1;
        }
    }

    indexEntries.sort((a, b) => a.file.localeCompare(b.file));
    const index: CorpusIndex = {
        source: 'uspstf',
        publication: 'USPSTF',
        license_tier: 'public_domain',
        chunk_count: indexEntries.length,
        chunks: indexEntries,
    };
    await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

    console.log(
        `[extract] done: ${pages} pages processed, ${written} chunks written, ${pagesWithWarnings} pages with warnings`,
    );
}

// Only run main() when invoked as a CLI, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
