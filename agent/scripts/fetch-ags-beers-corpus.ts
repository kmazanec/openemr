/**
 * Fetches the 2023 AGS Beers Criteria from the open-access PubMed
 * Central mirror.
 *
 * The publisher's direct site (`agsjournals.onlinelibrary.wiley.com`)
 * returns a Cloudflare JS-challenge to scripted fetches, so the fetcher
 * targets PMC where the article (`PMC12478568`, NIHMS deposit live
 * since 2025-09-30) is freely accessible. The chunk frontmatter records
 * both `url` (PMC, what the fetcher actually used) and `publisher_url`
 * (the canonical DOI link, what citation popovers display to users).
 * License tier remains `fair_use_cds` — PMC's "free to read" doesn't
 * relax AGS's copyright; the source is a single-publication artifact in
 * *J Am Geriatr Soc* and `agent/README.md` carries a production-
 * readiness footnote stronger than ADA's (explicit AGS license required
 * for production deployment).
 *
 * The Beers Criteria is one PMC article; the typed target list is a
 * single entry. `fetch-ada-corpus.ts` uses an 18-entry list for the ADA
 * Standards-of-Care; for AGS Beers a single explicit constant is honest
 * about scope. If AGS publishes a 2026/2029 update, the entry is
 * either replaced (for a new PMC ID) or re-fetched (idempotent on
 * sha256 mismatch).
 *
 * The HTML cache lives at agent/.corpus-cache/ags-beers/ (gitignored).
 * The fetch manifest with provenance for the cached page is committed
 * at agent/data/corpus/ags-beers/fetch-manifest.json so every emitted
 * chunk traces back to a specific URL, fetch timestamp, and content
 * sha256.
 *
 * Re-runs are conditional on content_sha256 in the manifest — if the
 * cached file's sha matches what the publisher returns now, we skip
 * the write. To force a re-fetch, wipe agent/.corpus-cache/ags-beers/.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/ags-beers');
const CORPUS_DIR = resolve(AGENT_DIR, 'data/corpus/ags-beers');
const MANIFEST_PATH = join(CORPUS_DIR, 'fetch-manifest.json');

// PMC's robots.txt declares no Crawl-delay for /articles/ — 3 s is
// conservative for a research mirror with thousands of bots a minute.
const CRAWL_DELAY_MS = 3_000;
const USER_AGENT =
    'openemr-clinical-copilot-corpus-fetcher/1.0 (research; contact: keith@devforward.com)';

const FETCHER_VERSION = '1';

export type AgsBeersSurface = 'pmc-section';

export interface FetchTarget {
    readonly slug: string;
    readonly pmc_id: string;
    readonly publisher_doi: string;
    readonly surface: AgsBeersSurface;
}

const PMC_BASE = 'https://pmc.ncbi.nlm.nih.gov/articles/';
const DOI_BASE = 'https://doi.org/';

const pmcUrl = (pmcId: string): string => `${PMC_BASE}${pmcId}/`;
const doiUrl = (doi: string): string => `${DOI_BASE}${doi}`;

// Single PMC target: AGS Beers 2023. PMC12478568 is the NIHMS deposit
// for jgs.18372 ("American Geriatrics Society 2023 updated AGS Beers
// Criteria® for potentially inappropriate medication use in older
// adults", J Am Geriatr Soc 2023;71(7):2052-2081). DOI resolves to the
// AGS Journals page at agsjournals.onlinelibrary.wiley.com — that's the
// publisher_url the renderer's citation popover shows to users, even
// though the fetcher uses PMC.
export const FETCH_TARGETS: readonly FetchTarget[] = [
    {
        slug: 'beers-criteria-2023',
        pmc_id: 'PMC12478568',
        publisher_doi: '10.1111/jgs.18372',
        surface: 'pmc-section',
    },
];

export interface ManifestEntry {
    readonly slug: string;
    readonly pmc_id: string;
    readonly url: string;
    readonly publisher_url: string;
    readonly surface: AgsBeersSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

export interface Manifest {
    readonly source: 'ags-beers';
    readonly fetcher_version: string;
    readonly first_run_at: string;
    readonly last_run_at: string;
    readonly entries: readonly ManifestEntry[];
}

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
        throw new Error(`fetch ${url} -> HTTP ${res.status}`);
    }
    return res.text();
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

// Smoke-test that the fetched page looks like a real PMC article rather
// than a bot-protection interstitial. PMC has been observed to return a
// reCAPTCHA challenge page (~20 KB, contains `recaptcha`) on bursty
// fetches; saving that to the cache poisons the next extract run with
// a missing-article-body warning. Mirrors the ADA fetcher's check.
function looksLikePmcArticle(html: string): boolean {
    if (html.length < 50_000) return false;
    if (/recaptcha|captcha-delivery|cf-browser-verification/i.test(html)) return false;
    return html.includes('main-article-body');
}

async function fetchOne(target: FetchTarget): Promise<ManifestEntry> {
    const url = pmcUrl(target.pmc_id);
    const html = await fetchText(url);
    if (!looksLikePmcArticle(html)) {
        throw new Error(
            `fetch ${url} -> response did not look like a PMC article (${html.length} bytes); refusing to cache`,
        );
    }
    const sha = sha256(html);
    const cachePath = join(CACHE_DIR, `${target.slug}.html`);
    await writeFile(cachePath, html, 'utf8');
    return {
        slug: target.slug,
        pmc_id: target.pmc_id,
        url,
        publisher_url: doiUrl(target.publisher_doi),
        surface: target.surface,
        fetched_at: new Date().toISOString(),
        content_sha256: sha,
    };
}

async function main(): Promise<void> {
    await mkdir(CACHE_DIR, { recursive: true });
    await mkdir(CORPUS_DIR, { recursive: true });

    const existing = await loadExistingManifest();
    const existingBySlug = new Map<string, ManifestEntry>(
        existing?.entries.map((e) => [e.slug, e]) ?? [],
    );

    console.log(`[fetch] ${FETCH_TARGETS.length} AGS Beers target(s)`);

    const results: ManifestEntry[] = [];
    let fetched = 0;
    let skipped = 0;

    for (const target of FETCH_TARGETS) {
        const cachePath = join(CACHE_DIR, `${target.slug}.html`);
        const prior = existingBySlug.get(target.slug);
        if (prior && (await fileExists(cachePath))) {
            const cached = await readFile(cachePath, 'utf8');
            if (sha256(cached) === prior.content_sha256) {
                results.push({
                    ...prior,
                    pmc_id: target.pmc_id,
                    url: pmcUrl(target.pmc_id),
                    publisher_url: doiUrl(target.publisher_doi),
                    surface: target.surface,
                });
                skipped += 1;
                continue;
            }
        }
        console.log(`[fetch] ${target.slug} (${target.pmc_id})`);
        try {
            const entry = await fetchOne(target);
            results.push(entry);
            fetched += 1;
        } catch (err) {
            console.error(`[fetch] ${target.slug} FAILED:`, err);
        }
        await sleep(CRAWL_DELAY_MS);
    }

    const now = new Date().toISOString();
    const manifest: Manifest = {
        source: 'ags-beers',
        fetcher_version: FETCHER_VERSION,
        first_run_at: existing?.first_run_at ?? now,
        last_run_at: now,
        entries: results.sort((a, b) => a.slug.localeCompare(b.slug)),
    };
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(
        `[fetch] done: ${fetched} fetched, ${skipped} skipped, ${results.length} in manifest`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
