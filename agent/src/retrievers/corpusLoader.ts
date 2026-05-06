import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import { computeBM25Stats, tokenize, type BM25Stats } from './bm25.js';

/**
 * Boot-time corpus loader for the production `evidenceRetriever` deps.
 *
 * Mirrors the same shape `agent/scripts/probe-evidence-retriever.ts`
 * uses (load every committed source under `agent/data/corpus/<source>/`,
 * tokenize titles + bodies, fit combined BM25 stats), so the query-side
 * weights match what the probe and the existing eval runners produce.
 *
 * Failure modes:
 *  - Missing corpus root → returns empty stats; the caller decides
 *    whether to wire the retriever (a graph that picks
 *    `evidenceRetriever` against an empty BM25 corpus would emit a
 *    `Gap` via the Pinecone "isEmpty" path).
 *  - Source directory without an `index.json` → skipped with a warning.
 *  - Empty body → skipped silently (matches probe behavior).
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_CORPUS_ROOT = resolve(AGENT_DIR, 'data/corpus');

interface IndexEntry {
    readonly file: string;
}

interface CorpusIndex {
    readonly chunks: readonly IndexEntry[];
}

export interface CorpusLoadResult {
    readonly stats: BM25Stats;
    readonly chunkCount: number;
}

export const loadCorpusBM25Stats = async (
    corpusRoot: string = DEFAULT_CORPUS_ROOT,
): Promise<CorpusLoadResult> => {
    let entries;
    try {
        entries = await readdir(corpusRoot, { withFileTypes: true });
    } catch {
        return { stats: computeBM25Stats([]), chunkCount: 0 };
    }
    const sources = entries.filter((d) => d.isDirectory()).map((d) => d.name);
    const allTokens: (readonly string[])[] = [];
    for (const source of sources) {
        const indexPath = join(corpusRoot, source, 'index.json');
        let index: CorpusIndex;
        try {
            index = JSON.parse(await readFile(indexPath, 'utf8')) as CorpusIndex;
        } catch {
            continue;
        }
        for (const entry of index.chunks) {
            const raw = await readFile(join(corpusRoot, source, entry.file), 'utf8');
            const parsed = matter(raw);
            const fm = parsed.data as Record<string, unknown>;
            const title = typeof fm['title'] === 'string' ? fm['title'] : '';
            const body = parsed.content.trim();
            if (!body) continue;
            allTokens.push(tokenize(`${title}\n${body}`));
        }
    }
    return {
        stats: computeBM25Stats(allTokens),
        chunkCount: allTokens.length,
    };
};
