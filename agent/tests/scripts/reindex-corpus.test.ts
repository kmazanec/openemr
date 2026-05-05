import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    bm25Sparse,
    computeBM25Stats,
    loadChunks,
    reindexSource,
    tokenize,
} from '../../scripts/reindex-corpus.js';

interface FakeEmbeddings {
    create: (req: { input: string[]; model: string; dimensions: number }) => Promise<{
        data: { embedding: number[] }[];
    }>;
}
interface FakeOpenAI {
    embeddings: FakeEmbeddings;
}

interface UpsertCall {
    records: {
        id: string;
        values: number[];
        sparseValues: { indices: number[]; values: number[] };
        metadata: Record<string, string | number>;
    }[];
}
interface FakeIndex {
    upsert: (opts: UpsertCall) => Promise<void>;
}
interface FakePinecone {
    index: (name: string) => { namespace: (ns: string) => FakeIndex };
}

async function setupCorpus(): Promise<{ dir: string; sourceDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'corpus-test-'));
    const sourceDir = join(root, 'data/corpus/uspstf');
    await mkdir(sourceDir, { recursive: true });
    const chunkA = `---
publication: USPSTF
title: "Topic A: Screening"
section: recommendation-summary
section_label: "Recommendation Summary"
year: 2023
url: "https://example.test/a"
license_tier: public_domain
slug: topic-a
---
Adults aged 50 to 75 years | The USPSTF recommends screening. | B
`;
    const chunkB = `---
publication: USPSTF
title: "Topic B: Screening"
section: practice-considerations
section_label: "Practice Considerations"
year: 2024
url: "https://example.test/b"
license_tier: public_domain
slug: topic-b
---
Practice considerations: clinicians should counsel patients about screening tests for adults at average risk.
`;
    await writeFile(join(sourceDir, 'topic-a--recommendation-summary.md'), chunkA, 'utf8');
    await writeFile(join(sourceDir, 'topic-b--practice-considerations.md'), chunkB, 'utf8');

    const index = {
        source: 'uspstf',
        publication: 'USPSTF',
        license_tier: 'public_domain',
        chunk_count: 2,
        chunks: [
            {
                file: 'topic-a--recommendation-summary.md',
                slug: 'topic-a',
                section: 'recommendation-summary',
                title: 'Topic A: Screening',
                year: 2023,
                url: 'https://example.test/a',
            },
            {
                file: 'topic-b--practice-considerations.md',
                slug: 'topic-b',
                section: 'practice-considerations',
                title: 'Topic B: Screening',
                year: 2024,
                url: 'https://example.test/b',
            },
        ],
    };
    await writeFile(join(sourceDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

    return { dir: root, sourceDir };
}

describe('tokenize', () => {
    it('lowercases, drops punctuation, and filters short/long tokens', () => {
        const tokens = tokenize('Adults aged 50 to 75: should be screened.');
        expect(tokens).toContain('adults');
        expect(tokens).toContain('aged');
        expect(tokens).toContain('screened');
        // 'to' is 2 chars so kept by current tokenizer; assert filtering of
        // 1-char tokens and very long tokens instead.
        expect(tokens.every((t) => t.length > 1 && t.length < 30)).toBe(true);
        // Punctuation is stripped.
        expect(tokens.some((t) => /[^a-z0-9]/.test(t))).toBe(false);
    });
});

describe('bm25Sparse', () => {
    it('produces a sparse vector with matching indices/values lengths', () => {
        const docs = [
            tokenize('Adults aged 50 to 75 should be screened for colorectal cancer.'),
            tokenize('Older adults should discuss screening with their clinician.'),
            tokenize('Clinicians should counsel pregnant adults about folic acid.'),
        ];
        const stats = computeBM25Stats(docs);
        const sparse = bm25Sparse(docs[0]!, stats);
        expect(sparse.indices.length).toBe(sparse.values.length);
        expect(sparse.indices.length).toBeGreaterThan(0);
        // Every weight is positive.
        expect(sparse.values.every((v) => v > 0)).toBe(true);
        // Indices are 32-bit unsigned.
        expect(sparse.indices.every((i) => Number.isInteger(i) && i >= 0)).toBe(true);
    });
});

describe('loadChunks', () => {
    it('reads frontmatter and produces records with stable IDs and metadata', async () => {
        const { sourceDir } = await setupCorpus();
        const indexJson = JSON.parse(
            await (await import('node:fs/promises')).readFile(
                join(sourceDir, 'index.json'),
                'utf8',
            ),
        ) as Parameters<typeof loadChunks>[1];

        const records = await loadChunks(sourceDir, indexJson);
        expect(records).toHaveLength(2);

        const a = records.find((r) => r.id === 'uspstf::topic-a--recommendation-summary');
        expect(a).toBeDefined();
        expect(a?.metadata['title']).toBe('Topic A: Screening');
        expect(a?.metadata['year']).toBe(2023);
        expect(a?.metadata['license_tier']).toBe('public_domain');
        expect(a?.metadata['url']).toBe('https://example.test/a');
        expect(a?.metadata['section']).toBe('recommendation-summary');
        expect(a?.metadata['source']).toBe('USPSTF');
        // chunk_text is the verbatim body, no frontmatter.
        expect(a?.metadata['chunk_text']).toContain('Adults aged 50 to 75 years');
        expect(String(a?.metadata['chunk_text'])).not.toContain('---');
    });
});

describe('reindexSource', () => {
    it('embeds with text-embedding-3-large at 3072d and upserts with full metadata', async () => {
        const { sourceDir } = await setupCorpus();
        const indexJson = JSON.parse(
            await (await import('node:fs/promises')).readFile(
                join(sourceDir, 'index.json'),
                'utf8',
            ),
        ) as Parameters<typeof loadChunks>[1];

        const embedCalls: { input: string[]; model: string; dimensions: number }[] = [];
        const fakeOpenAI: FakeOpenAI = {
            embeddings: {
                create: (req) => {
                    embedCalls.push(req);
                    return Promise.resolve({
                        data: req.input.map(() => ({
                            embedding: Array.from({ length: req.dimensions }, () => 0.1),
                        })),
                    });
                },
            },
        };

        const upsertCalls: UpsertCall[] = [];
        const fakeIndex: FakeIndex = {
            upsert: (opts) => {
                upsertCalls.push(opts);
                return Promise.resolve();
            },
        };
        const fakePinecone: FakePinecone = {
            index: () => ({ namespace: () => fakeIndex }),
        };

        // Cast to the script's expected types — they're structurally compatible.
        const result = await reindexSource(
            fakePinecone as unknown as Parameters<typeof reindexSource>[0],
            'test-index',
            fakeOpenAI as unknown as Parameters<typeof reindexSource>[2],
            sourceDir,
            indexJson,
        );

        expect(result.written).toBe(2);
        expect(embedCalls).toHaveLength(1);
        expect(embedCalls[0]?.model).toBe('text-embedding-3-large');
        expect(embedCalls[0]?.dimensions).toBe(3072);

        expect(upsertCalls).toHaveLength(1);
        const records = upsertCalls[0]?.records ?? [];
        expect(records).toHaveLength(2);

        const a = records.find((r) => r.id === 'uspstf::topic-a--recommendation-summary');
        expect(a).toBeDefined();
        expect(a?.values).toHaveLength(3072);
        expect(a?.sparseValues.indices.length).toBeGreaterThan(0);
        expect(a?.sparseValues.indices.length).toBe(a?.sparseValues.values.length);
        expect(a?.metadata['publication']).toBe('USPSTF');
        expect(a?.metadata['license_tier']).toBe('public_domain');
        expect(a?.metadata['url']).toBe('https://example.test/a');
        expect(a?.metadata['title']).toBe('Topic A: Screening');
    });
});
