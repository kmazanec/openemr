/**
 * Multi-query rewriting eval — proves the rewriter+RRF path beats the
 * single-query path on synonym-mismatch cases.
 *
 * The case set is the dominant clinical-retrieval failure mode:
 * the user phrases the question in lay or non-publisher terminology,
 * but the relevant guideline chunk uses the publisher's preferred
 * clinical term. A single-query hybrid retrieval misses (or buries)
 * the right chunk; a query rewriter that produces a terminology-
 * shifted variant lifts it into the candidate set.
 *
 * The Pinecone stub here is hand-wired to mimic that exact pathology:
 * a query phrased as "heart attack" returns chunks about generic
 * cardiology, but the same retrieval against "myocardial infarction"
 * returns the load-bearing recommendation chunk. The rewriter's
 * terminology variant produces "myocardial infarction"; RRF fuses;
 * the right chunk lands in the top-K.
 *
 * The metric is **recall@K pre-rerank**: did the ground-truth chunk
 * appear in the candidate set the reranker saw? This is the cleanest
 * signal that rewriting (not reranking) is doing the work. We assert
 * the metric improves on average across the case set, not on every
 * individual case — single-case noise is absorbed by the aggregate
 * threshold the same way the §"Eval Architecture" 5%-regression-
 * per-rubric pattern does.
 */

import { describe, expect, it } from 'vitest';

import { createEvidenceRetriever } from '../../../../src/graph/nodes/evidenceRetriever.js';
import type { EvidenceArgs } from '../../../../src/graph/types.js';
import type { CohereRerankClient } from '../../../../src/retrievers/cohere.js';
import type {
    PineconeHybridHit,
    PineconeQueryOptions,
    PineconeRetriever,
} from '../../../../src/retrievers/pinecone.js';
import {
    createStubQueryRewriter,
    type QueryRewriter,
} from '../../../../src/retrievers/queryRewriter.js';
import { baseState } from '../_helpers.js';

interface RewritingCase {
    readonly name: string;
    readonly userQuery: string;
    /**
     * Variants the rewriter would produce. The terminology variant is
     * the load-bearing one — it's what attacks the lay/clinical
     * mismatch. Cases pin the publisher's preferred phrasing so the
     * stub is reproducible.
     */
    readonly variants: {
        readonly paraphrase: string;
        readonly step_back: string;
        readonly terminology: string;
    };
    /** Chunk id the case considers the load-bearing answer. */
    readonly groundTruthChunkId: string;
    /**
     * The pre-built corpus the Pinecone stub serves up per query.
     * Every entry the case expects to see in any lane goes here; the
     * stub matches by query keyword (publisher preferred term).
     */
    readonly corpus: readonly {
        readonly chunkId: string;
        readonly preferredTerms: readonly string[];
    }[];
}

const CASES: readonly RewritingCase[] = [
    {
        name: 'lay → clinical: "heart attack" vs "myocardial infarction"',
        userQuery: 'aspirin for heart attack prevention in 60-year-old man',
        variants: {
            paraphrase: 'aspirin to prevent heart attack in 60-year-old man',
            step_back: 'aspirin primary prevention cardiovascular disease',
            terminology:
                'aspirin primary prevention myocardial infarction adults',
        },
        groundTruthChunkId: 'uspstf::aspirin-mi-prevention--recommendation',
        corpus: [
            {
                chunkId: 'uspstf::aspirin-mi-prevention--recommendation',
                preferredTerms: ['myocardial infarction', 'aspirin', 'primary prevention'],
            },
            {
                chunkId: 'uspstf::cardiovascular-disease--overview',
                preferredTerms: ['cardiovascular', 'aspirin'],
            },
            {
                chunkId: 'uspstf::aspirin-stroke--background',
                preferredTerms: ['aspirin', 'stroke'],
            },
        ],
    },
    {
        name: 'lay → clinical: "high blood pressure" vs "hypertension"',
        userQuery: 'when to start medication for high blood pressure',
        variants: {
            paraphrase: 'starting drug therapy for elevated blood pressure',
            step_back: 'pharmacologic treatment thresholds for blood pressure',
            terminology: 'pharmacologic treatment threshold hypertension adults',
        },
        groundTruthChunkId: 'uspstf::hypertension-treatment--threshold',
        corpus: [
            {
                chunkId: 'uspstf::hypertension-treatment--threshold',
                preferredTerms: ['hypertension', 'pharmacologic', 'threshold'],
            },
            {
                chunkId: 'uspstf::lifestyle-bp--counseling',
                preferredTerms: ['blood pressure', 'lifestyle', 'counseling'],
            },
        ],
    },
    {
        name: 'lay → clinical: "sugar diabetes" vs "type 2 diabetes mellitus"',
        userQuery: 'screening adults for sugar diabetes',
        variants: {
            paraphrase: 'screening criteria for diabetes in adults',
            step_back: 'diabetes screening recommendations',
            terminology: 'screening type 2 diabetes mellitus adults',
        },
        groundTruthChunkId: 'uspstf::t2dm-screening--recommendation',
        corpus: [
            {
                chunkId: 'uspstf::t2dm-screening--recommendation',
                preferredTerms: ['type 2 diabetes mellitus', 'screening', 'adults'],
            },
            {
                chunkId: 'uspstf::diabetes-counseling--overview',
                preferredTerms: ['diabetes', 'counseling'],
            },
        ],
    },
    {
        name: 'over-specified → step-back: patient-specific vs general policy',
        userQuery: 'should this 52-year-old man with LDL 145 and family history be on a statin',
        variants: {
            paraphrase: 'statin recommendation for 52-year-old male with LDL 145',
            step_back: 'USPSTF statin therapy primary prevention adults',
            terminology: 'HMG-CoA reductase inhibitor primary prevention CVD',
        },
        groundTruthChunkId: 'uspstf::statin-primary-prevention--recommendation',
        corpus: [
            {
                chunkId: 'uspstf::statin-primary-prevention--recommendation',
                preferredTerms: ['statin', 'primary prevention'],
            },
            {
                chunkId: 'uspstf::ldl-management--overview',
                preferredTerms: ['LDL', 'management'],
            },
        ],
    },
    {
        name: 'lay → clinical: "water pill" vs "diuretic"',
        userQuery: 'water pill safety in elderly',
        variants: {
            paraphrase: 'safety of diuretic medications in older adults',
            step_back: 'diuretic prescribing risks',
            terminology: 'diuretic adverse effects geriatric AGS Beers',
        },
        groundTruthChunkId: 'ags-beers::diuretic-elderly--caution',
        corpus: [
            {
                chunkId: 'ags-beers::diuretic-elderly--caution',
                preferredTerms: ['diuretic', 'older adults', 'AGS Beers'],
            },
            {
                chunkId: 'cdc::salt-intake--guidelines',
                preferredTerms: ['salt', 'sodium'],
            },
        ],
    },
];

const PINECONE_TOP_K = 20;

const buildHit = (chunkId: string, score: number): PineconeHybridHit => ({
    id: chunkId,
    score,
    publication: 'USPSTF',
    year: 2021,
    section: 'recommendation-summary',
    section_label: 'Recommendation Summary',
    title: chunkId,
    url: '',
    license_tier: 'public_domain',
    chunk_text: `Body for ${chunkId}`,
});

/**
 * Score a corpus chunk against a query string by counting how many
 * of its `preferredTerms` appear (case-insensitive substring) in the
 * query. This is intentionally a stand-in for hybrid retrieval — the
 * point of the eval is the rewriter's effect on candidate-set
 * inclusion, not the retrieval algorithm itself. The behavior the
 * stub captures is the load-bearing one: a query phrased in lay
 * terms scores zero against publisher-preferred terms, the
 * terminology variant flips that.
 *
 * Returns the hybrid hits in descending score order, capped at top-K.
 * Ties break on chunkId for determinism.
 */
const queryCorpus = (
    query: string,
    corpus: RewritingCase['corpus'],
): readonly PineconeHybridHit[] => {
    const q = query.toLowerCase();
    const scored = corpus
        .map((c) => ({
            chunkId: c.chunkId,
            score: c.preferredTerms.reduce(
                (acc, term) => (q.includes(term.toLowerCase()) ? acc + 1 : acc),
                0,
            ),
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.chunkId.localeCompare(b.chunkId);
        })
        .slice(0, PINECONE_TOP_K);

    return scored.map((s) =>
        buildHit(s.chunkId, 0.5 + 0.1 * s.score /* shape some headroom for RRF */),
    );
};

const buildPineconeStub = (
    corpus: RewritingCase['corpus'],
): PineconeRetriever & { readonly calls: PineconeQueryOptions[] } => {
    const calls: PineconeQueryOptions[] = [];
    return {
        isEmpty: false,
        calls,
        query: (opts) => {
            calls.push(opts);
            return Promise.resolve(queryCorpus(opts.query, corpus));
        },
    };
};

/**
 * Cohere stub that returns the top-N candidates by their input order
 * (i.e. preserves the fused order). The recall metric is computed
 * pre-rerank — we just need rerank to not error.
 */
const passthroughCohere: CohereRerankClient = {
    rerank: (input) =>
        Promise.resolve(
            input.documents
                .map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.01 }))
                .slice(0, input.topN),
        ),
};

const args = (query: string, top_k = 5): EvidenceArgs => ({ query, top_k });

const buildRewriter = (c: RewritingCase): QueryRewriter =>
    createStubQueryRewriter((q) => ({
        original: q,
        variants: [
            { kind: 'paraphrase', text: c.variants.paraphrase },
            { kind: 'step_back', text: c.variants.step_back },
            { kind: 'terminology', text: c.variants.terminology },
        ],
        queries: [q, c.variants.paraphrase, c.variants.step_back, c.variants.terminology],
    }));

interface RecallResult {
    /** True if the ground-truth chunk landed in the top-K snippets. */
    readonly recallAtK: boolean;
    /** 0-indexed rank of the ground-truth chunk in the snippets, or -1 if absent. */
    readonly rank: number;
}

const measureRecall = async (
    c: RewritingCase,
    rewriter: QueryRewriter | undefined,
    topK: number,
): Promise<RecallResult> => {
    const pinecone = buildPineconeStub(c.corpus);
    const node = createEvidenceRetriever({
        pineconeRetriever: pinecone,
        cohereRerank: passthroughCohere,
        ...(rewriter !== undefined ? { queryRewriter: rewriter } : {}),
    });
    const out = await node(baseState({ evidenceRetrieverArgs: args(c.userQuery, topK) }));
    const snippets = out.evidenceRetrieverOutput?.snippets ?? [];
    const rank = snippets.findIndex((s) => s.chunkId === c.groundTruthChunkId);
    return { recallAtK: rank >= 0, rank };
};

describe('multi-query rewriting eval — recall@K vs single-query baseline', () => {
    const TOP_K = 5;

    it('treatment beats control on aggregate recall@K across the synonym-mismatch case set', async () => {
        let controlHits = 0;
        let treatmentHits = 0;
        const perCase: { name: string; control: boolean; treatment: boolean }[] = [];

        for (const c of CASES) {
            const control = await measureRecall(c, undefined, TOP_K);
            const treatment = await measureRecall(c, buildRewriter(c), TOP_K);
            if (control.recallAtK) controlHits++;
            if (treatment.recallAtK) treatmentHits++;
            perCase.push({
                name: c.name,
                control: control.recallAtK,
                treatment: treatment.recallAtK,
            });
        }

        // Aggregate threshold — multi-query must beat single-query
        // recall@K across the case set. Hard-coded margin (≥ 1 case
        // lift) absorbs ties and rejects regressions.
        expect(treatmentHits).toBeGreaterThan(controlHits);

        // No case should regress: treatment recall ≥ control recall
        // for every case. (A treatment that recovers some cases by
        // sacrificing others isn't a real win.)
        for (const r of perCase) {
            // If control passed, treatment must pass too — otherwise
            // the rewriter introduced a regression on that case.
            if (r.control) expect(r.treatment).toBe(true);
        }
    });

    it('every case has the ground-truth chunk reachable in the corpus when phrased correctly', async () => {
        // Sanity test: the corpus stub is correctly wired so the
        // ground-truth chunk would be retrievable if the user had
        // phrased the query in clinical terms. This proves the
        // recall lift in the previous test is "rewriter found it"
        // and not "the test corpus is unreachable".
        for (const c of CASES) {
            const result = await measureRecall(
                c,
                createStubQueryRewriter((_q) => ({
                    original: c.variants.terminology,
                    variants: [],
                    queries: [c.variants.terminology],
                })),
                TOP_K,
            );
            expect(result.recallAtK).toBe(true);
        }
    });

    it('recall lift is driven by RRF fusion of variants, not the rewriter alone', async () => {
        // Dial the rewriter to produce only the original query (no
        // variants). RRF over a single lane is a no-op — recall must
        // match the no-rewriter baseline. This pins the lift to RRF +
        // diverse variants together, not the rewriter wrapper alone.
        const noopRewriter: QueryRewriter = createStubQueryRewriter((q) => ({
            original: q,
            variants: [],
            queries: [q],
        }));

        let baselineHits = 0;
        let noopHits = 0;
        for (const c of CASES) {
            if ((await measureRecall(c, undefined, TOP_K)).recallAtK) baselineHits++;
            if ((await measureRecall(c, noopRewriter, TOP_K)).recallAtK) noopHits++;
        }
        expect(noopHits).toBe(baselineHits);
    });
});
