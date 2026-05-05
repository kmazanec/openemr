/**
 * Indexes committed corpus chunks into the Pinecone hybrid namespace
 * `guidelines-v1`.
 *
 * Source-agnostic from the start: any directory under
 * agent/data/corpus/<source>/ that has an `index.json` is iterated. The
 * index lists chunk files; each is parsed with gray-matter, embedded via
 * OpenAI text-embedding-3-large, sparse-vectorized via BM25 over the
 * source's chunk corpus, and upserted to Pinecone with full metadata.
 *
 * Stable chunk IDs (`<source>::<basename>`) make re-runs idempotent.
 *
 * Plan note: the original C.2 plan called for the `pinecone-text` SDK
 * for BM25; that package is Python-only. We implement BM25 inline here
 * (Robertson 1995 / Manning, Raghavan, Schütze) over tokens from
 * natural's WordTokenizer. The Pinecone hybrid index format is the
 * same: a sparse vector of `{indices: number[], values: number[]}`
 * alongside the dense vector.
 *
 * No-op with a logged warning when OPENAI_API_KEY or PINECONE_API_KEY
 * is missing — same skip semantics as the agent's other real-vendor
 * scripts.
 */

import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
// natural's package types reference .ts source files which break under
// verbatimModuleSyntax. We use the @types/natural declarations (global)
// and pull the runtime via createRequire to avoid the typed import path.
import { createRequire } from 'node:module';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

const require = createRequire(import.meta.url);
const natural = require('natural') as { WordTokenizer: new () => { tokenize: (s: string) => string[] } };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(SCRIPT_DIR, '..');
const CORPUS_ROOT = resolve(AGENT_DIR, 'data/corpus');

const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIM = 3072;
const PINECONE_NAMESPACE = process.env['PINECONE_NAMESPACE'] ?? 'guidelines-v1';

const EMBEDDING_BATCH_SIZE = 32;
const UPSERT_BATCH_SIZE = 50;

interface IndexEntryFile {
    readonly file: string;
    readonly slug: string;
    readonly section: string;
    readonly title: string;
    readonly year: number;
    readonly url: string;
    readonly fetched_at?: string;
    readonly content_sha256?: string;
}

interface CorpusIndex {
    readonly source: string;
    readonly publication: string;
    readonly license_tier: string;
    readonly chunk_count: number;
    readonly chunks: readonly IndexEntryFile[];
}

export interface ChunkRecord {
    readonly id: string;
    readonly source: string;
    readonly file: string;
    readonly body: string;
    readonly tokens: readonly string[];
    readonly metadata: Record<string, string | number>;
}

export interface SparseVector {
    readonly indices: number[];
    readonly values: number[];
}

const tokenizer = new natural.WordTokenizer();

export function tokenize(text: string): string[] {
    return tokenizer
        .tokenize(text.toLowerCase())
        .filter((t) => t.length > 1 && t.length < 30)
        .map((t) => t.replace(/[^a-z0-9]/g, ''))
        .filter((t) => t.length > 0);
}

/**
 * 32-bit FNV-1a hash. Good enough for BM25 sparse-vector token IDs —
 * stable across runs, low collision rate at our vocabulary size.
 */
function hashToken(token: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < token.length; i += 1) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export interface BM25Stats {
    readonly avgDocLength: number;
    readonly docCount: number;
    readonly docFreq: ReadonlyMap<string, number>;
}

export function computeBM25Stats(docs: readonly (readonly string[])[]): BM25Stats {
    const docCount = docs.length;
    let totalLen = 0;
    const docFreq = new Map<string, number>();
    for (const doc of docs) {
        totalLen += doc.length;
        const seen = new Set<string>();
        for (const t of doc) {
            if (seen.has(t)) continue;
            seen.add(t);
            docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        }
    }
    return { avgDocLength: docCount > 0 ? totalLen / docCount : 0, docCount, docFreq };
}

export function bm25Sparse(tokens: readonly string[], stats: BM25Stats): SparseVector {
    // Standard BM25 weights. k1=1.2, b=0.75 are the canonical defaults.
    const k1 = 1.2;
    const b = 0.75;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    const indicesMap = new Map<number, number>();
    for (const [term, freq] of tf) {
        const df = stats.docFreq.get(term) ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (stats.docCount - df + 0.5) / (df + 0.5));
        const norm = k1 * (1 - b + (b * tokens.length) / (stats.avgDocLength || 1));
        const weight = (idf * (freq * (k1 + 1))) / (freq + norm);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const id = hashToken(term);
        // On hash collision keep the larger weight — collisions are rare and
        // this is a deterministic tie-break.
        const existing = indicesMap.get(id);
        if (existing === undefined || weight > existing) {
            indicesMap.set(id, weight);
        }
    }

    const indices: number[] = [];
    const values: number[] = [];
    for (const [id, w] of indicesMap) {
        indices.push(id);
        values.push(w);
    }
    return { indices, values };
}

async function loadIndex(sourceDir: string): Promise<CorpusIndex | null> {
    const indexPath = join(sourceDir, 'index.json');
    try {
        const buf = await readFile(indexPath, 'utf8');
        return JSON.parse(buf) as CorpusIndex;
    } catch {
        return null;
    }
}

function readStr(fm: Record<string, unknown>, key: string, fallback: string): string {
    const v = fm[key];
    return typeof v === 'string' ? v : fallback;
}

function readNum(fm: Record<string, unknown>, key: string, fallback: number): number {
    const v = fm[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function loadChunks(sourceDir: string, index: CorpusIndex): Promise<ChunkRecord[]> {
    const records: ChunkRecord[] = [];
    for (const entry of index.chunks) {
        const fullPath = join(sourceDir, entry.file);
        const raw = await readFile(fullPath, 'utf8');
        const parsed = matter(raw);
        const fm = parsed.data as Record<string, unknown>;
        const body = parsed.content.trim();
        if (!body) continue;
        const id = `${index.source}::${basename(entry.file, '.md')}`;
        const tokens = tokenize(`${entry.title}\n${body}`);
        const metadata: Record<string, string | number> = {
            source: readStr(fm, 'publication', index.publication),
            publication: readStr(fm, 'publication', index.publication),
            license_tier: readStr(fm, 'license_tier', index.license_tier),
            slug: readStr(fm, 'slug', entry.slug),
            section: readStr(fm, 'section', entry.section),
            section_label: readStr(fm, 'section_label', entry.section),
            title: readStr(fm, 'title', entry.title),
            year: readNum(fm, 'year', entry.year),
            url: readStr(fm, 'url', entry.url),
            fetched_at: readStr(fm, 'fetched_at', entry.fetched_at ?? ''),
            content_sha256: readStr(fm, 'content_sha256', entry.content_sha256 ?? ''),
            chunk_text: body,
        };
        records.push({ id, source: index.source, file: entry.file, body, tokens, metadata });
    }
    return records;
}

function* batched<T>(items: readonly T[], size: number): Generator<T[]> {
    for (let i = 0; i < items.length; i += size) {
        yield items.slice(i, i + size);
    }
}

async function embedAll(openai: OpenAI, records: readonly ChunkRecord[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    let done = 0;
    const batches = [...batched(records, EMBEDDING_BATCH_SIZE)];
    for (const batch of batches) {
        const inputs = batch.map((r) => r.body);
        const res = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: inputs,
            dimensions: EMBEDDING_DIM,
        });
        if (res.data.length !== batch.length) {
            throw new Error(`embedding response count ${res.data.length} != batch ${batch.length}`);
        }
        batch.forEach((r, i) => {
            const data = res.data[i];
            if (!data) throw new Error(`embedding missing for ${r.id}`);
            out.set(r.id, data.embedding);
        });
        done += batch.length;
        console.log(`[reindex] embedded ${done}/${records.length}`);
    }
    return out;
}

export async function reindexSource(
    pinecone: Pinecone,
    indexName: string,
    openai: OpenAI,
    sourceDir: string,
    index: CorpusIndex,
): Promise<{ written: number }> {
    console.log(`[reindex] source ${index.source}: ${index.chunk_count} chunks`);
    const records = await loadChunks(sourceDir, index);
    if (records.length === 0) {
        console.warn(`[reindex] source ${index.source}: no chunks loaded`);
        return { written: 0 };
    }

    const stats = computeBM25Stats(records.map((r) => r.tokens));
    const dense = await embedAll(openai, records);
    const idx = pinecone.index(indexName).namespace(PINECONE_NAMESPACE);

    const vectors = records.map((r) => {
        const denseVec = dense.get(r.id);
        if (!denseVec) throw new Error(`missing dense vec for ${r.id}`);
        return {
            id: r.id,
            values: denseVec,
            sparseValues: bm25Sparse(r.tokens, stats),
            metadata: r.metadata,
        };
    });

    let written = 0;
    const upsertBatches = [...batched(vectors, UPSERT_BATCH_SIZE)];
    for (const batch of upsertBatches) {
        await idx.upsert({ records: batch });
        written += batch.length;
        console.log(`[reindex] upserted ${written}/${vectors.length}`);
    }
    return { written };
}

async function main(): Promise<void> {
    const openaiKey = process.env['OPENAI_API_KEY'];
    const pineconeKey = process.env['PINECONE_API_KEY'];
    const indexName = process.env['PINECONE_INDEX_NAME'];

    if (!openaiKey || !pineconeKey || !indexName) {
        const missing: string[] = [];
        if (!openaiKey) missing.push('OPENAI_API_KEY');
        if (!pineconeKey) missing.push('PINECONE_API_KEY');
        if (!indexName) missing.push('PINECONE_INDEX_NAME');
        console.warn(
            `[reindex] missing ${missing.join(', ')} — skipping with warning. (Set these in agent/.env to run against real vendors.)`,
        );
        return;
    }

    const sources = (await readdir(CORPUS_ROOT, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

    if (sources.length === 0) {
        console.warn(`[reindex] no corpus sources under ${CORPUS_ROOT}`);
        return;
    }

    const openai = new OpenAI({ apiKey: openaiKey });
    const pinecone = new Pinecone({ apiKey: pineconeKey });

    let totalWritten = 0;
    for (const sourceName of sources) {
        const sourceDir = join(CORPUS_ROOT, sourceName);
        const index = await loadIndex(sourceDir);
        if (!index) {
            console.warn(`[reindex] source ${sourceName}: no index.json — skipping`);
            continue;
        }
        const { written } = await reindexSource(pinecone, indexName, openai, sourceDir, index);
        totalWritten += written;
    }

    console.log(`[reindex] done: ${totalWritten} vectors upserted to namespace ${PINECONE_NAMESPACE}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
