/**
 * Fetches the ADA Standards of Care in Diabetes—2026 sections from the
 * open-access PubMed Central mirror.
 *
 * The publisher's direct site (`diabetesjournals.org`) returns a
 * Cloudflare JS-challenge to scripted fetches, so the fetcher targets
 * the open-access PMC mirror where every Standards-of-Care section is
 * published as a separate article. The chunk frontmatter records both
 * `url` (PMC, what the fetcher actually used) and `publisher_url` (the
 * canonical DOI link, what citation popovers display to users). The
 * license tier remains `fair_use_cds` — PMC's "free to read" doesn't
 * relax ADA's copyright, only the access path.
 *
 * Targets are an explicit typed list at the top of this file — adding
 * an ADA section is editing one constant. The list covers the
 * Introduction & Methodology front-matter article plus the 17 numbered
 * sections (18 entries total). Disclosures and the Summary of Revisions
 * are intentionally excluded: the former is conflict-of-interest
 * boilerplate, the latter is meta ("what changed") rather than
 * actionable clinical guidance.
 *
 * The HTML cache lives at agent/.corpus-cache/ada/ (gitignored). The
 * fetch manifest with provenance for each cached page is committed at
 * agent/data/corpus/ada/fetch-manifest.json so every emitted chunk
 * traces back to a specific URL, fetch timestamp, and content sha256.
 *
 * Re-runs are conditional on content_sha256 in the manifest — if the
 * cached file's sha matches what the publisher returns now, we skip
 * the write. To force a re-fetch, wipe agent/.corpus-cache/ada/.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = resolve(AGENT_DIR, '.corpus-cache/ada');
const CORPUS_DIR = resolve(AGENT_DIR, 'data/corpus/ada');
const MANIFEST_PATH = join(CORPUS_DIR, 'fetch-manifest.json');

// PMC's robots.txt declares no Crawl-delay for /articles/ — 3 s is
// conservative for a research mirror with thousands of bots a minute.
const CRAWL_DELAY_MS = 3_000;
const USER_AGENT =
    'openemr-clinical-copilot-corpus-fetcher/1.0 (research; contact: keith@devforward.com)';

const FETCHER_VERSION = '1';

export type AdaSurface = 'pmc-section';

export interface FetchTarget {
    readonly slug: string;
    readonly pmc_id: string;
    readonly publisher_doi: string;
    readonly surface: AdaSurface;
}

const PMC_BASE = 'https://pmc.ncbi.nlm.nih.gov/articles/';
const DOI_BASE = 'https://doi.org/';

const pmcUrl = (pmcId: string): string => `${PMC_BASE}${pmcId}/`;
const doiUrl = (doi: string): string => `${DOI_BASE}${doi}`;

// One entry per ADA Standards-of-Care 2026 article we ingest. PMC IDs
// are stable per article; DOIs (`10.2337/dc26-S<NN>`) resolve to the
// canonical diabetesjournals.org URL and are the form we cite to users.
//
// Order is editorial: front matter, then sections 1 through 17. The
// fetcher walks this order so log output reads naturally.
//
// Disclosures (PMC12690169 / dc26-SDIS) and Summary of Revisions
// (PMC12690167 / dc26-SREV) are intentionally excluded — see file
// header.
export const FETCH_TARGETS: readonly FetchTarget[] = [
    {
        slug: 'introduction-and-methodology',
        pmc_id: 'PMC12690168',
        publisher_doi: '10.2337/dc26-SINT',
        surface: 'pmc-section',
    },
    {
        slug: '01-improving-care-and-promoting-health',
        pmc_id: 'PMC12690171',
        publisher_doi: '10.2337/dc26-S001',
        surface: 'pmc-section',
    },
    {
        slug: '02-diagnosis-and-classification',
        pmc_id: 'PMC12690183',
        publisher_doi: '10.2337/dc26-S002',
        surface: 'pmc-section',
    },
    {
        slug: '03-prevention-or-delay',
        pmc_id: 'PMC12690170',
        publisher_doi: '10.2337/dc26-S003',
        surface: 'pmc-section',
    },
    {
        slug: '04-comprehensive-medical-evaluation',
        pmc_id: 'PMC12690184',
        publisher_doi: '10.2337/dc26-S004',
        surface: 'pmc-section',
    },
    {
        slug: '05-facilitating-positive-health-behaviors',
        pmc_id: 'PMC12690188',
        publisher_doi: '10.2337/dc26-S005',
        surface: 'pmc-section',
    },
    {
        slug: '06-glycemic-goals-hypoglycemia',
        pmc_id: 'PMC12690178',
        publisher_doi: '10.2337/dc26-S006',
        surface: 'pmc-section',
    },
    {
        slug: '07-diabetes-technology',
        pmc_id: 'PMC12690173',
        publisher_doi: '10.2337/dc26-S007',
        surface: 'pmc-section',
    },
    {
        slug: '08-obesity-and-weight-management',
        pmc_id: 'PMC12690172',
        publisher_doi: '10.2337/dc26-S008',
        surface: 'pmc-section',
    },
    {
        slug: '09-pharmacologic-approaches',
        pmc_id: 'PMC12690185',
        publisher_doi: '10.2337/dc26-S009',
        surface: 'pmc-section',
    },
    {
        slug: '10-cardiovascular-disease-and-risk-management',
        pmc_id: 'PMC12690187',
        publisher_doi: '10.2337/dc26-S010',
        surface: 'pmc-section',
    },
    {
        slug: '11-chronic-kidney-disease',
        pmc_id: 'PMC12690176',
        publisher_doi: '10.2337/dc26-S011',
        surface: 'pmc-section',
    },
    {
        slug: '12-retinopathy-neuropathy-foot-care',
        pmc_id: 'PMC12690177',
        publisher_doi: '10.2337/dc26-S012',
        surface: 'pmc-section',
    },
    {
        slug: '13-older-adults',
        pmc_id: 'PMC12690186',
        publisher_doi: '10.2337/dc26-S013',
        surface: 'pmc-section',
    },
    {
        slug: '14-children-and-adolescents',
        pmc_id: 'PMC12690182',
        publisher_doi: '10.2337/dc26-S014',
        surface: 'pmc-section',
    },
    {
        slug: '15-management-of-diabetes-in-pregnancy',
        pmc_id: 'PMC12690181',
        publisher_doi: '10.2337/dc26-S015',
        surface: 'pmc-section',
    },
    {
        slug: '16-diabetes-care-in-the-hospital',
        pmc_id: 'PMC12690180',
        publisher_doi: '10.2337/dc26-S016',
        surface: 'pmc-section',
    },
    {
        slug: '17-diabetes-advocacy',
        pmc_id: 'PMC12690165',
        publisher_doi: '10.2337/dc26-S017',
        surface: 'pmc-section',
    },
];

export interface ManifestEntry {
    readonly slug: string;
    readonly pmc_id: string;
    readonly url: string;
    readonly publisher_url: string;
    readonly surface: AdaSurface;
    readonly fetched_at: string;
    readonly content_sha256: string;
}

export interface Manifest {
    readonly source: 'ada';
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
    const url = pmcUrl(target.pmc_id);
    const html = await fetchText(url);
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

    console.log(`[fetch] ${FETCH_TARGETS.length} ADA targets`);

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
        source: 'ada',
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
