/**
 * Local smoke test for the §C.3 `evidenceRetriever` pipeline. Loads
 * the committed USPSTF corpus, fits BM25 stats, embeds a query via
 * OpenAI, queries Pinecone hybrid, reranks via Cohere, prints the
 * top-K snippets.
 *
 * No-ops with a logged warning when any of OPENAI_API_KEY,
 * PINECONE_API_KEY, PINECONE_INDEX_NAME, or COHERE_API_KEY is missing
 * — same skip semantics as `grounding:reindex-corpus`.
 *
 * Not part of the test suite. Invoke with:
 *   npm run probe:evidence-retriever -- "USPSTF colorectal cancer screening"
 *
 * Default query is "USPSTF colorectal cancer screening" — pinned in
 * `W2_ARCHITECTURE.md` §C.3 definition of done.
 */

import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

import { createCohereRerankClient } from '../src/retrievers/cohere.js';
import { loadCorpusBM25Stats } from '../src/retrievers/corpusLoader.js';
import { createPineconeRetriever } from '../src/retrievers/pinecone.js';

const DEFAULT_QUERY = 'USPSTF colorectal cancer screening';

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
    const { stats, chunkCount } = await loadCorpusBM25Stats();
    console.log(`[probe] BM25 stats: ${chunkCount} chunks`);

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
        console.warn('[probe] no hits — index may be empty. Did you run `grounding:reindex-corpus`?');
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
