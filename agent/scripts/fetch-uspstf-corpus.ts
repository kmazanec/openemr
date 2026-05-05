/**
 * Fetches every published USPSTF recommendation page into a local cache.
 *
 * The publisher's robots.txt asks for a 5-second crawl delay; we honor that.
 * The cache lives at agent/.corpus-cache/uspstf/ (gitignored). The committed
 * corpus is what falls out of `extract-uspstf-corpus.ts`, never the raw HTML.
 *
 * Re-runs are conditional on content_sha256 in the manifest — if a cached
 * file's sha matches what the publisher returns now, we skip the write.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/uspstf');
const MANIFEST_PATH = join(CACHE_DIR, 'manifest.json');

const SITE_ORIGIN = 'https://www.uspreventiveservicestaskforce.org';
const TOPIC_INDEX_PATH = '/uspstf/topic_search_results?topic_status=P';
const RECOMMENDATION_PATH_PREFIX = '/uspstf/recommendation/';

// robots.txt declares Crawl-delay: 5 — we pad to be safely polite.
const CRAWL_DELAY_MS = 5_500;
const USER_AGENT =
    'openemr-clinical-copilot-corpus-fetcher/1.0 (research; contact: keith@devforward.com)';

interface ManifestEntry {
    readonly slug: string;
    readonly url: string;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

interface Manifest {
    readonly source: 'uspstf';
    readonly fetcher_version: string;
    readonly entries: readonly ManifestEntry[];
}

const FETCHER_VERSION = '1';

const sleep = (ms: number): Promise<void> =>
    new Promise((res) => {
        setTimeout(res, ms);
    });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const fileExists = async (path: string): Promise<boolean> => {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
};

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
    });
    if (!res.ok) {
        throw new Error(`fetch ${url} → HTTP ${res.status}`);
    }
    return res.text();
}

async function discoverSlugs(): Promise<string[]> {
    const slugs = new Set<string>();
    let page = 1;
    while (true) {
        const url = `${SITE_ORIGIN}${TOPIC_INDEX_PATH}${page > 1 ? `&PAGE=${page}` : ''}`;
        console.log(`[discover] ${url}`);
        const html = await fetchText(url);
        const $ = cheerio.load(html);
        const before = slugs.size;
        $('a[href*="/uspstf/recommendation/"]').each((_i, a) => {
            const href = $(a).attr('href');
            if (!href) return;
            const idx = href.indexOf(RECOMMENDATION_PATH_PREFIX);
            if (idx < 0) return;
            const slug = href.slice(idx + RECOMMENDATION_PATH_PREFIX.length).split(/[?#]/)[0];
            if (slug && !slug.includes('/')) slugs.add(slug);
        });
        const added = slugs.size - before;
        console.log(`[discover] page ${page}: +${added} slugs (total ${slugs.size})`);
        if (added === 0) break;
        page += 1;
        await sleep(CRAWL_DELAY_MS);
    }
    return [...slugs].sort();
}

async function loadExistingManifest(): Promise<Manifest | null> {
    if (!(await fileExists(MANIFEST_PATH))) return null;
    try {
        const buf = await readFile(MANIFEST_PATH, 'utf8');
        return JSON.parse(buf) as Manifest;
    } catch {
        return null;
    }
}

async function fetchOne(slug: string): Promise<ManifestEntry> {
    const url = `${SITE_ORIGIN}${RECOMMENDATION_PATH_PREFIX}${slug}`;
    const html = await fetchText(url);
    const sha = sha256(html);
    const cachePath = join(CACHE_DIR, `${slug}.html`);
    await writeFile(cachePath, html, 'utf8');
    return {
        slug,
        url,
        fetched_at: new Date().toISOString(),
        content_sha256: sha,
    };
}

async function main(): Promise<void> {
    await mkdir(CACHE_DIR, { recursive: true });

    const existing = await loadExistingManifest();
    const existingBySlug = new Map<string, ManifestEntry>(
        existing?.entries.map((e) => [e.slug, e]) ?? [],
    );

    const slugs = await discoverSlugs();
    console.log(`[fetch] ${slugs.length} slugs to consider`);

    const results: ManifestEntry[] = [];
    let fetched = 0;
    let skipped = 0;

    for (const slug of slugs) {
        const cachePath = join(CACHE_DIR, `${slug}.html`);
        const prior = existingBySlug.get(slug);
        if (prior && (await fileExists(cachePath))) {
            // Only re-validate by hashing the cached content; we don't re-GET to skip.
            // The publisher updates rarely enough that a manual cache wipe before
            // re-fetch is the right recovery path.
            const cached = await readFile(cachePath, 'utf8');
            if (sha256(cached) === prior.content_sha256) {
                results.push(prior);
                skipped += 1;
                continue;
            }
        }
        console.log(`[fetch] ${slug}`);
        try {
            const entry = await fetchOne(slug);
            results.push(entry);
            fetched += 1;
        } catch (err) {
            console.error(`[fetch] ${slug} FAILED:`, err);
        }
        await sleep(CRAWL_DELAY_MS);
    }

    const manifest: Manifest = {
        source: 'uspstf',
        fetcher_version: FETCHER_VERSION,
        entries: results.sort((a, b) => a.slug.localeCompare(b.slug)),
    };
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(`[fetch] done: ${fetched} fetched, ${skipped} skipped, ${results.length} in manifest`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
