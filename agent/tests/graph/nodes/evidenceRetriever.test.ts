import { describe, expect, it, vi } from 'vitest';

import { createEvidenceRetriever } from '../../../src/graph/nodes/evidenceRetriever.js';
import type { BriefingState } from '../../../src/graph/state.js';
import type {
    BriefingSnapshot,
    EvidenceArgs,
    RequestEnvelope,
} from '../../../src/graph/types.js';
import type { CohereRerankClient } from '../../../src/retrievers/cohere.js';
import {
    PineconeUnavailableError,
    type PineconeHybridHit,
    type PineconeRetriever,
    type PineconeQueryOptions,
} from '../../../src/retrievers/pinecone.js';
import {
    QueryRewriterUnavailableError,
    createStubQueryRewriter,
    type QueryRewriter,
} from '../../../src/retrievers/queryRewriter.js';

const PID = 42;

const envelope: RequestEnvelope = {
    conversationId: 'c-1',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-1', fhirUser: 'https://emr/Practitioner/u-1' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'follow_up',
    question: 'When should colorectal cancer screening start?',
};

const sourceRef = (id: string, field: string) => ({
    source_type: 'chart' as const,
    source_id: id,
    locator: { field },
    quote: id,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: sourceRef('42', 'patient.name'),
    },
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    labHistory: null,
};

const baseState = (overrides: Partial<BriefingState> = {}): BriefingState => ({
    envelope,
    priorTurnContext: { turns: [] },
    snapshot,
    draft: null,
    claimLedger: null,
    verified: null,
    formatted: null,
    persisted: null,
    retrieveChartCallCount: 1,
    retrieveChartArgs: null,
    documentEvidenceArgs: null,
    documentEvidenceSnippets: null, documentEvidenceArtifactConfidence: null,
    evidenceRetrieverArgs: null,
    evidenceRetrieverOutput: null,
    supervisorIterations: 1,
    supervisorDecisionHistory: [],
    capHit: false, kickoffExtractionResults: [],
    ...overrides,
});

const args = (overrides: Partial<EvidenceArgs> = {}): EvidenceArgs => ({
    query: 'colorectal cancer screening',
    top_k: 3,
    ...overrides,
});

const sampleHits: readonly PineconeHybridHit[] = [
    {
        id: 'uspstf::colorectal-cancer-screening--recommendation-summary',
        score: 0.81,
        publication: 'USPSTF',
        year: 2021,
        section: 'recommendation-summary',
        section_label: 'Recommendation Summary',
        title: 'Colorectal Cancer: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening',
        license_tier: 'public_domain',
        chunk_text:
            'The USPSTF recommends screening for colorectal cancer in all adults aged 45 to 75 years. (B recommendation)',
    },
    {
        id: 'uspstf::abdominal-aortic-aneurysm-screening--recommendation-summary',
        score: 0.72,
        publication: 'USPSTF',
        year: 2019,
        section: 'recommendation-summary',
        section_label: 'Recommendation Summary',
        title: 'Abdominal Aortic Aneurysm: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/abdominal-aortic-aneurysm-screening',
        license_tier: 'public_domain',
        chunk_text:
            'The USPSTF recommends one-time screening for abdominal aortic aneurysm with ultrasonography in men aged 65 to 75 who have ever smoked.',
    },
    {
        id: 'uspstf::lipid-screening--recommendation-summary',
        score: 0.65,
        publication: 'USPSTF',
        year: 2016,
        section: 'recommendation-summary',
        section_label: 'Recommendation Summary',
        title: 'Lipid Disorders in Adults: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/lipid-disorders-adults',
        license_tier: 'public_domain',
        chunk_text:
            'The USPSTF recommends offering or referring adults with cardiovascular disease risk to behavioral counseling.',
    },
];

const buildPineconeRetriever = (
    queryFn: (opts: PineconeQueryOptions) => Promise<readonly PineconeHybridHit[]>,
    isEmpty = false,
): PineconeRetriever & { calls: PineconeQueryOptions[] } => {
    const calls: PineconeQueryOptions[] = [];
    return {
        isEmpty,
        calls,
        query: (opts) => {
            calls.push(opts);
            return queryFn(opts);
        },
    };
};

const buildCohereStub = (
    rerank: CohereRerankClient['rerank'],
): CohereRerankClient => ({ rerank });

describe('createEvidenceRetriever (§C.3)', () => {
    it('happy path: Pinecone top-N → Cohere rerank → top-k snippets with rerank scores', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve(sampleHits));
        const cohere = buildCohereStub(() =>
            Promise.resolve([
                { index: 0, relevanceScore: 0.97 },
                { index: 2, relevanceScore: 0.42 },
            ]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 2 }) }));

        const result = out.evidenceRetrieverOutput;
        expect(result).not.toBeNull();
        expect(result?.gap).toBeNull();
        expect(result?.snippets).toHaveLength(2);
        expect(result?.snippets[0]?.chunkId).toBe(
            'uspstf::colorectal-cancer-screening--recommendation-summary',
        );
        expect(result?.snippets[0]?.rerankScore).toBe(0.97);
        expect(result?.snippets[0]?.degradedRerank).toBe(false);
        expect(result?.snippets[0]?.publication).toBe('USPSTF');
        expect(result?.snippets[0]?.year).toBe(2021);
        expect(result?.snippets[0]?.title).toBe('Colorectal Cancer: Screening');
        expect(result?.snippets[0]?.section).toBe('recommendation-summary');
        expect(result?.snippets[0]?.licenseTier).toBe('public_domain');
        expect(result?.snippets[0]?.quote).toContain('45 to 75');
        // Re-ordered: index 2 (lipid) was second in rerank, not third.
        expect(result?.snippets[1]?.chunkId).toBe(
            'uspstf::lipid-screening--recommendation-summary',
        );
    });

    it('forwards source_filter to the Pinecone query', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve(sampleHits));
        const cohere = buildCohereStub(() =>
            Promise.resolve([{ index: 0, relevanceScore: 0.9 }]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        await node(
            baseState({
                evidenceRetrieverArgs: args({
                    source_filter: ['USPSTF'],
                    top_k: 1,
                }),
            }),
        );

        expect(pinecone.calls[0]?.publicationFilter).toEqual(['USPSTF']);
    });

    it('Cohere outage: falls through to top-k by Pinecone hybrid score, tagged degradedRerank', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve(sampleHits));
        // null is the contract for "Cohere is unavailable, use the
        // hybrid order instead" (per cohere.ts).
        const cohere = buildCohereStub(() => Promise.resolve(null));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 2 }) }));

        const result = out.evidenceRetrieverOutput;
        expect(result?.gap).toBeNull();
        expect(result?.snippets).toHaveLength(2);
        // Degraded mode: Pinecone hybrid order is preserved as-is — top
        // two hits in the order Pinecone returned them.
        expect(result?.snippets[0]?.chunkId).toBe(
            'uspstf::colorectal-cancer-screening--recommendation-summary',
        );
        expect(result?.snippets[0]?.rerankScore).toBe(0.81);
        expect(result?.snippets[0]?.degradedRerank).toBe(true);
        expect(result?.snippets[1]?.chunkId).toBe(
            'uspstf::abdominal-aortic-aneurysm-screening--recommendation-summary',
        );
        expect(result?.snippets[1]?.degradedRerank).toBe(true);
    });

    it('Pinecone outage: returns Gap{evidence-retrieval-unavailable} with empty snippets', async () => {
        const pinecone = buildPineconeRetriever(() =>
            Promise.reject(
                new PineconeUnavailableError('Pinecone unavailable: connection reset'),
            ),
        );
        // Cohere should not be called when Pinecone fails.
        const rerank = vi.fn(() => Promise.resolve(null));
        const cohere = buildCohereStub(rerank);
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args() }));

        const result = out.evidenceRetrieverOutput;
        expect(result?.snippets).toEqual([]);
        expect(result?.gap?.kind).toBe('gap');
        expect(result?.gap?.reason).toBe('evidence-retrieval-unavailable');
        expect(rerank).not.toHaveBeenCalled();
    });

    it('Pinecone returns no matches: emits empty snippets with no gap (legitimate "no match" signal)', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve([]));
        const rerank = vi.fn(() => Promise.resolve(null));
        const cohere = buildCohereStub(rerank);
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args() }));

        const result = out.evidenceRetrieverOutput;
        expect(result?.snippets).toEqual([]);
        expect(result?.gap).toBeNull();
        // Skipping rerank when there's nothing to rerank avoids burning
        // a Cohere call on an empty list.
        expect(rerank).not.toHaveBeenCalled();
    });

    it('throws when the supervisor routes here without populating evidenceRetrieverArgs', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve([]));
        const cohere = buildCohereStub(() => Promise.resolve([]));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        await expect(node(baseState({ evidenceRetrieverArgs: null }))).rejects.toThrow(
            /evidenceRetrieverArgs/,
        );
    });

    it('skips rerank entries that point at indices Pinecone did not return', async () => {
        const pinecone = buildPineconeRetriever(() =>
            Promise.resolve([sampleHits[0]!, sampleHits[1]!]),
        );
        // Cohere claims index 99 (which was never in the input). The
        // node must drop that result rather than read undefined.
        const cohere = buildCohereStub(() =>
            Promise.resolve([
                { index: 1, relevanceScore: 0.88 },
                { index: 99, relevanceScore: 0.5 },
            ]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 2 }) }));

        expect(out.evidenceRetrieverOutput?.snippets).toHaveLength(1);
        expect(out.evidenceRetrieverOutput?.snippets[0]?.chunkId).toBe(
            'uspstf::abdominal-aortic-aneurysm-screening--recommendation-summary',
        );
    });

    it('truncates long chunk bodies to a 1200-char excerpt as the snippet quote', async () => {
        const longBody = 'A'.repeat(2000);
        const pinecone = buildPineconeRetriever(() =>
            Promise.resolve([
                {
                    ...sampleHits[0]!,
                    chunk_text: longBody,
                },
            ]),
        );
        const cohere = buildCohereStub(() =>
            Promise.resolve([{ index: 0, relevanceScore: 0.9 }]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 1 }) }));

        const quote = out.evidenceRetrieverOutput?.snippets[0]?.quote ?? '';
        expect(quote.length).toBe(1200);
    });

    it('rethrows non-PineconeUnavailableError errors (so unexpected bugs surface loudly)', async () => {
        const pinecone = buildPineconeRetriever(() =>
            Promise.reject(new TypeError('boom')),
        );
        const cohere = buildCohereStub(() => Promise.resolve(null));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
        });

        await expect(node(baseState({ evidenceRetrieverArgs: args() }))).rejects.toBeInstanceOf(
            TypeError,
        );
    });
});

describe('createEvidenceRetriever — multi-query rewriting', () => {
    const COLORECTAL_HIT: PineconeHybridHit = {
        id: 'uspstf::colorectal-cancer-screening--recommendation-summary',
        score: 0.91,
        publication: 'USPSTF',
        year: 2021,
        section: 'recommendation-summary',
        section_label: 'Recommendation Summary',
        title: 'Colorectal Cancer: Screening',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening',
        license_tier: 'public_domain',
        chunk_text:
            'The USPSTF recommends screening for colorectal cancer in adults aged 45 to 75 years. (B recommendation)',
    };
    const STATIN_HIT: PineconeHybridHit = {
        ...COLORECTAL_HIT,
        id: 'uspstf::statin--recommendation',
        title: 'Statin Use for Primary Prevention',
        chunk_text: 'The USPSTF recommends statins for primary prevention in adults aged 40-75.',
    };
    const SCREENING_GENERAL_HIT: PineconeHybridHit = {
        ...COLORECTAL_HIT,
        id: 'uspstf::cancer-screening--overview',
        title: 'Cancer Screening Overview',
        chunk_text: 'Cancer screening recommendations vary by age and risk profile.',
    };

    const stubRewriter: QueryRewriter = createStubQueryRewriter((q) => ({
        original: q,
        variants: [
            { kind: 'paraphrase', text: 'colon cancer screening age recommendations' },
            { kind: 'step_back', text: 'cancer screening guidelines' },
            { kind: 'terminology', text: 'colorectal cancer prevention screening' },
        ],
        queries: [
            q,
            'colon cancer screening age recommendations',
            'cancer screening guidelines',
            'colorectal cancer prevention screening',
        ],
    }));

    it('fans out one Pinecone call per rewritten variant', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve([COLORECTAL_HIT]));
        const cohere = buildCohereStub(() =>
            Promise.resolve([{ index: 0, relevanceScore: 0.95 }]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
            queryRewriter: stubRewriter,
        });

        await node(baseState({ evidenceRetrieverArgs: args({ top_k: 1 }) }));

        // 1 original + 3 variants = 4 Pinecone calls.
        expect(pinecone.calls).toHaveLength(4);
        expect(pinecone.calls.map((c) => c.query)).toEqual([
            'colorectal cancer screening',
            'colon cancer screening age recommendations',
            'cancer screening guidelines',
            'colorectal cancer prevention screening',
        ]);
    });

    it('reranks against the ORIGINAL user query, not a rewrite', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve([COLORECTAL_HIT]));
        const seenQueries: string[] = [];
        const cohere = buildCohereStub((input) => {
            seenQueries.push(input.query);
            return Promise.resolve([{ index: 0, relevanceScore: 0.95 }]);
        });
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
            queryRewriter: stubRewriter,
        });

        await node(
            baseState({ evidenceRetrieverArgs: args({ query: 'is colon cancer screening at 45?' }) }),
        );

        // The rerank query must be the user's original phrasing, not
        // any of the rewritten variants. The cross-encoder makes the
        // final ordering call against the user's actual intent.
        expect(seenQueries).toEqual(['is colon cancer screening at 45?']);
    });

    it('RRF-fuses overlapping per-variant hits — a chunk in multiple variants outranks a one-off hit', async () => {
        // q1 (original): [colorectal, statin]
        // q2 (paraphrase): [colorectal, screening_general]
        // q3 (step_back): [statin, colorectal]
        // q4 (terminology): [colorectal]
        // colorectal appears in 4 lanes; statin in 2; screening_general in 1.
        const responses: Record<string, readonly PineconeHybridHit[]> = {
            'colorectal cancer screening': [COLORECTAL_HIT, STATIN_HIT],
            'colon cancer screening age recommendations': [COLORECTAL_HIT, SCREENING_GENERAL_HIT],
            'cancer screening guidelines': [STATIN_HIT, COLORECTAL_HIT],
            'colorectal cancer prevention screening': [COLORECTAL_HIT],
        };
        const pinecone = buildPineconeRetriever((opts) =>
            Promise.resolve(responses[opts.query] ?? []),
        );
        // Cohere "outage" so we observe the RRF-fused order directly
        // (degraded mode returns top-`k` by RRF score).
        const cohere = buildCohereStub(() => Promise.resolve(null));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
            queryRewriter: stubRewriter,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 3 }) }));
        const result = out.evidenceRetrieverOutput;
        expect(result?.snippets).toHaveLength(3);
        // Colorectal is in 4 of 4 lanes — RRF score dominates.
        expect(result?.snippets[0]?.chunkId).toBe(COLORECTAL_HIT.id);
        // Statin is in 2 of 4; screening_general in 1 — statin ranks above.
        expect(result?.snippets[1]?.chunkId).toBe(STATIN_HIT.id);
        expect(result?.snippets[2]?.chunkId).toBe(SCREENING_GENERAL_HIT.id);
        expect(result?.snippets.every((s) => s.degradedRerank)).toBe(true);
    });

    it('rewriter outage: falls back to single-query, retriever still produces snippets', async () => {
        const failingRewriter: QueryRewriter = {
            rewrite: () =>
                Promise.reject(new QueryRewriterUnavailableError('rewriter timeout')),
        };
        const pinecone = buildPineconeRetriever(() => Promise.resolve([COLORECTAL_HIT]));
        const cohere = buildCohereStub(() =>
            Promise.resolve([{ index: 0, relevanceScore: 0.9 }]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
            queryRewriter: failingRewriter,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 1 }) }));
        // Single Pinecone call — only the original query ran.
        expect(pinecone.calls).toHaveLength(1);
        expect(pinecone.calls[0]?.query).toBe('colorectal cancer screening');
        // Snippet still produced — rewriter outage is degraded, not a Gap.
        expect(out.evidenceRetrieverOutput?.snippets).toHaveLength(1);
        expect(out.evidenceRetrieverOutput?.gap).toBeNull();
    });

    it('rethrows non-QueryRewriterUnavailableError (unexpected bugs surface loudly)', async () => {
        const failingRewriter: QueryRewriter = {
            rewrite: () => Promise.reject(new TypeError('boom')),
        };
        const pinecone = buildPineconeRetriever(() => Promise.resolve([]));
        const cohere = buildCohereStub(() => Promise.resolve([]));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
            queryRewriter: failingRewriter,
        });
        await expect(node(baseState({ evidenceRetrieverArgs: args() }))).rejects.toBeInstanceOf(
            TypeError,
        );
    });

    it('Pinecone outage on any variant escalates to a Gap (fail-closed)', async () => {
        let call = 0;
        const pinecone = buildPineconeRetriever(() => {
            // First two variants return hits; third one fails.
            if (++call === 3) {
                return Promise.reject(new PineconeUnavailableError('connection reset'));
            }
            return Promise.resolve([COLORECTAL_HIT]);
        });
        const cohere = buildCohereStub(() => Promise.resolve(null));
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
            queryRewriter: stubRewriter,
        });

        const out = await node(baseState({ evidenceRetrieverArgs: args() }));
        expect(out.evidenceRetrieverOutput?.snippets).toEqual([]);
        expect(out.evidenceRetrieverOutput?.gap?.reason).toBe('evidence-retrieval-unavailable');
    });

    it('without a rewriter: falls back to single-query (legacy posture)', async () => {
        const pinecone = buildPineconeRetriever(() => Promise.resolve([COLORECTAL_HIT]));
        const cohere = buildCohereStub(() =>
            Promise.resolve([{ index: 0, relevanceScore: 0.95 }]),
        );
        const node = createEvidenceRetriever({
            pineconeRetriever: pinecone,
            cohereRerank: cohere,
            // queryRewriter omitted
        });

        await node(baseState({ evidenceRetrieverArgs: args({ top_k: 1 }) }));
        expect(pinecone.calls).toHaveLength(1);
    });
});
