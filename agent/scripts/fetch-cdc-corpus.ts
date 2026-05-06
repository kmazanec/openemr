/**
 * Fetches CDC clinical-guidance pages into a local cache for the corpus.
 *
 * CDC publishes its guidelines across heterogeneous URL spaces (ACIP
 * immunization schedules, opioid prescribing landing, STI clinical
 * guidance), so we can't sweep an index page the way the USPSTF
 * fetcher does. Targets are an explicit typed list at the top of this
 * file — adding a CDC surface is editing one constant.
 *
 * The HTML cache lives at agent/.corpus-cache/cdc/ (gitignored). The
 * fetch manifest with provenance for each cached page is committed at
 * agent/data/corpus/cdc/fetch-manifest.json so every emitted chunk
 * traces back to a specific URL, fetch timestamp, and content sha256.
 *
 * Re-runs are conditional on content_sha256 in the manifest — if the
 * cached file's sha matches what the publisher returns now, we skip
 * the write. To force a re-fetch, wipe agent/.corpus-cache/cdc/.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/cdc');
const CORPUS_DIR = resolve(AGENT_DIR, 'data/corpus/cdc');
const MANIFEST_PATH = join(CORPUS_DIR, 'fetch-manifest.json');

// CDC's robots.txt declares no Crawl-delay for the paths we hit, so we
// pick a conservative 2 s — well below USPSTF's 5.5 s but polite for an
// unspecified-delay site.
const CRAWL_DELAY_MS = 2_000;
const USER_AGENT =
    'openemr-clinical-copilot-corpus-fetcher/1.0 (research; contact: keith@devforward.com)';

const FETCHER_VERSION = '1';

export type CdcSurface = 'acip-schedule' | 'acip-notes' | 'opioid-landing' | 'sti-clinical-guidance';

export interface FetchTarget {
    readonly slug: string;
    readonly url: string;
    readonly surface: CdcSurface;
}

// One entry per page we ingest. Slugs are filename-safe and stable —
// they become the basename of the cached HTML and the prefix of the
// emitted chunk files.
export const FETCH_TARGETS: readonly FetchTarget[] = [
    // ACIP — adult immunization schedule
    {
        slug: 'acip-adult-age',
        url: 'https://www.cdc.gov/vaccines/hcp/imz-schedules/adult-age.html',
        surface: 'acip-schedule',
    },
    {
        slug: 'acip-adult-notes',
        url: 'https://www.cdc.gov/vaccines/hcp/imz-schedules/adult-notes.html',
        surface: 'acip-notes',
    },
    // ACIP — child & adolescent immunization schedule
    {
        slug: 'acip-child-adolescent-age',
        url: 'https://www.cdc.gov/vaccines/hcp/imz-schedules/child-adolescent-age.html',
        surface: 'acip-schedule',
    },
    {
        slug: 'acip-child-adolescent-notes',
        url: 'https://www.cdc.gov/vaccines/hcp/imz-schedules/child-adolescent-notes.html',
        surface: 'acip-notes',
    },
    // CDC opioid prescribing — 2022 Clinical Practice Guideline at a glance
    {
        slug: 'opioid-prescribing-2022',
        url: 'https://www.cdc.gov/overdose-prevention/hcp/clinical-guidance/index.html',
        surface: 'opioid-landing',
    },
    // STI treatment guidelines clinical-guidance sub-pages
    {
        slug: 'sti-availability-of-products',
        url: 'https://www.cdc.gov/sti/hcp/clinical-guidance/availability-of-products.html',
        surface: 'sti-clinical-guidance',
    },
    {
        slug: 'sti-duty-to-warn',
        url: 'https://www.cdc.gov/sti/hcp/clinical-guidance/duty-to-warn-for-health-care-settings.html',
        surface: 'sti-clinical-guidance',
    },
    {
        slug: 'sti-expedited-partner-therapy',
        url: 'https://www.cdc.gov/sti/hcp/clinical-guidance/expedited-partner-therapy.html',
        surface: 'sti-clinical-guidance',
    },
    {
        slug: 'sti-quality-clinical-services',
        url: 'https://www.cdc.gov/sti/hcp/clinical-guidance/qcs.html',
        surface: 'sti-clinical-guidance',
    },
    {
        slug: 'sti-taking-a-sexual-history',
        url: 'https://www.cdc.gov/sti/hcp/clinical-guidance/taking-a-sexual-history.html',
        surface: 'sti-clinical-guidance',
    },
];

export interface ManifestEntry {
    readonly slug: string;
    readonly url: string;
    readonly surface: CdcSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

export interface Manifest {
    readonly source: 'cdc';
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
        throw new Error(`fetch ${url} → HTTP ${res.status}`);
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

async function fetchOne(target: FetchTarget): Promise<ManifestEntry> {
    const html = await fetchText(target.url);
    const sha = sha256(html);
    const cachePath = join(CACHE_DIR, `${target.slug}.html`);
    await writeFile(cachePath, html, 'utf8');
    return {
        slug: target.slug,
        url: target.url,
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

    console.log(`[fetch] ${FETCH_TARGETS.length} CDC targets`);

    const results: ManifestEntry[] = [];
    let fetched = 0;
    let skipped = 0;

    for (const target of FETCH_TARGETS) {
        const cachePath = join(CACHE_DIR, `${target.slug}.html`);
        const prior = existingBySlug.get(target.slug);
        if (prior && (await fileExists(cachePath))) {
            const cached = await readFile(cachePath, 'utf8');
            if (sha256(cached) === prior.content_sha256) {
                results.push({ ...prior, surface: target.surface });
                skipped += 1;
                continue;
            }
        }
        console.log(`[fetch] ${target.slug} (${target.surface})`);
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
        source: 'cdc',
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
