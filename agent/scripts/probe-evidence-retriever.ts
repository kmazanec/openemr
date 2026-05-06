/**
 * Local smoke test for the §C.3 `evidenceRetriever` pipeline. Loads
 * the committed USPSTF corpus, fits BM25 stats, embeds a query via
 * OpenAI, queries Pinecone hybrid, reranks via Cohere, prints the
 * top-K snippets.
 *
 * No-ops with a logged warning when any of OPENAI_API_KEY,
 * PINECONE_API_KEY, PINECONE_INDEX_NAME, or COHERE_API_KEY is missing
 * — same skip semantics as `evals:reindex-corpus`.
 *
 * Not part of the test suite. Invoke with:
 *   npm run probe:evidence-retriever -- "USPSTF colorectal cancer screening"
 *
 * Default query is "USPSTF colorectal cancer screening" — pinned in
 * `W2_ARCHITECTURE.md` §C.3 definition of done.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

import { computeBM25Stats, tokenize } from '../src/retrievers/bm25.js';
import { createCohereRerankClient } from '../src/retrievers/cohere.js';
import { createPineconeRetriever } from '../src/retrievers/pinecone.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CORPUS_ROOT = resolve(AGENT_DIR, 'data/corpus');

const DEFAULT_QUERY = 'USPSTF colorectal cancer screening';

interface IndexEntry {
    readonly file: string;
}
interface CorpusIndex {
    readonly chunks: readonly IndexEntry[];
}

async function loadCorpusTokens(): Promise<readonly (readonly string[])[]> {
    const sources = (await readdir(CORPUS_ROOT, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    const allTokens: (readonly string[])[] = [];
    for (const source of sources) {
        const indexPath = join(CORPUS_ROOT, source, 'index.json');
        let index: CorpusIndex;
        try {
            index = JSON.parse(await readFile(indexPath, 'utf8')) as CorpusIndex;
        } catch {
            console.warn(`[probe] no index.json under ${source} — skipping`);
            continue;
        }
        for (const entry of index.chunks) {
            const raw = await readFile(join(CORPUS_ROOT, source, entry.file), 'utf8');
            const parsed = matter(raw);
            const fm = parsed.data as Record<string, unknown>;
            const title = typeof fm['title'] === 'string' ? fm['title'] : '';
            const body = parsed.content.trim();
            if (!body) continue;
            allTokens.push(tokenize(`${title}\n${body}`));
        }
    }
    return allTokens;
}

async function main(): Promise<void> {
    const openaiKey = process.env['OPENAI_API_KEY'];
    const pineconeKey = process.env['PINECONE_API_KEY'];
    const indexName = process.env['PINECONE_INDEX_NAME'];
    const cohereKey = process.env['COHERE_API_KEY'];
    const namespace = process.env['PINECONE_NAMESPACE'] ?? 'guidelines-v1';

    const missing: string[] = [];
    if (!openaiKey) missing.push('OPENAI_API_KEY');
    if (!pineconeKey) missing.push('PINECONE_API_KEY');
    if (!indexName) missing.push('PINECONE_INDEX_NAME');
    if (!cohereKey) missing.push('COHERE_API_KEY');
    if (
        missing.length > 0
        || openaiKey === undefined
        || pineconeKey === undefined
        || indexName === undefined
        || cohereKey === undefined
    ) {
        console.warn(
            `[probe] missing ${missing.join(', ')} — skipping. (Set in agent/.env to run against real vendors.)`,
        );
        return;
    }

    const query = process.argv[2] ?? DEFAULT_QUERY;
    console.log(`[probe] query: ${query}`);

    console.log('[probe] loading corpus and fitting BM25 stats…');
    const corpusTokens = await loadCorpusTokens();
    console.log(`[probe] BM25 stats: ${corpusTokens.length} chunks`);

    const stats = computeBM25Stats(corpusTokens);
    const openai = new OpenAI({ apiKey: openaiKey });
    const pinecone = new Pinecone({ apiKey: pineconeKey });
    const retriever = createPineconeRetriever({
        pinecone,
        indexName,
        namespace,
        embeddings: openai.embeddings,
        bm25Stats: stats,
    });

    console.log(`[probe] querying Pinecone (namespace=${namespace})…`);
    const t0 = Date.now();
    const hits = await retriever.query({ query });
    console.log(`[probe] Pinecone returned ${hits.length} hits in ${Date.now() - t0}ms`);

    if (hits.length === 0) {
        console.warn('[probe] no hits — index may be empty. Did you run `evals:reindex-corpus`?');
        return;
    }

    const cohere = createCohereRerankClient({ apiKey: cohereKey });
    console.log('[probe] reranking via Cohere…');
    const t1 = Date.now();
    const reranked = await cohere.rerank({
        query,
        documents: hits.map((h) => h.chunk_text),
        topN: 3,
    });
    console.log(`[probe] Cohere returned in ${Date.now() - t1}ms`);

    if (reranked === null) {
        console.warn('[probe] Cohere unavailable — degraded mode. Top 3 by Pinecone hybrid score:');
        for (const hit of hits.slice(0, 3)) {
            console.log(`  ${hit.score.toFixed(3)} ${hit.id}`);
            console.log(`    ${hit.title} (${hit.section})`);
            console.log(`    ${hit.chunk_text.slice(0, 200)}…`);
        }
        return;
    }

    console.log('[probe] reranked top 3:');
    for (const r of reranked) {
        const hit = hits[r.index];
        if (!hit) continue;
        console.log(`  ${r.relevanceScore.toFixed(3)} ${hit.id}`);
        console.log(`    ${hit.title} (${hit.section})`);
        console.log(`    ${hit.chunk_text.slice(0, 200)}…`);
        console.log('');
    }
}

await main();
