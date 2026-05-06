/**
 * §C.7 conversational-graph evals — guidelines retriever (4 cases).
 *
 * Drives the C.3 retriever node with stubbed Pinecone + Cohere clients
 * and asserts the four invariants Phase C must hold:
 *  1. A relevant query returns the expected chunk in top-1 — the
 *     verifier accepts a guideline claim citing it.
 *  2. An out-of-scope query (Pinecone returns []) emits empty
 *     snippets with no Gap — distinct from an outage. A guideline
 *     claim against a non-existent chunk rejects.
 *  3. Cohere outage falls through to top-`k` by Pinecone hybrid score,
 *     each snippet tagged `degradedRerank: true`.
 *  4. Pinecone outage emits a `Gap{evidence-retrieval-unavailable}`
 *     with empty snippets; a guideline claim under the gap rejects
 *     as unresolved (the supervisor was supposed to route around).
 */

import { describe, expect, it, vi } from 'vitest';

import { createEvidenceRetriever } from '../../../../src/graph/nodes/evidenceRetriever.js';
import type {
    Claim,
    ClaimLedger,
    EvidenceArgs,
    EvidenceRetrieverOutput,
} from '../../../../src/graph/types.js';
import type { CohereRerankClient } from '../../../../src/retrievers/cohere.js';
import {
    PineconeUnavailableError,
    type PineconeHybridHit,
    type PineconeQueryOptions,
    type PineconeRetriever,
} from '../../../../src/retrievers/pinecone.js';
import { verifyLedger } from '../../../../src/verify/verifier.js';
import {
    COLORECTAL_CHUNK,
    baseSnapshot,
    baseState,
    guidelineSourceRef,
    guidelineSnippet,
} from '../_helpers.js';

const args = (overrides: Partial<EvidenceArgs> = {}): EvidenceArgs => ({
    query: 'colorectal cancer screening',
    top_k: 3,
    ...overrides,
});

const HITS: readonly PineconeHybridHit[] = [
    {
        id: COLORECTAL_CHUNK.chunkId,
        score: 0.81,
        publication: COLORECTAL_CHUNK.publication,
        year: COLORECTAL_CHUNK.year,
        section: COLORECTAL_CHUNK.section,
        section_label: 'Recommendation Summary',
        title: COLORECTAL_CHUNK.title,
        url: COLORECTAL_CHUNK.url,
        license_tier: COLORECTAL_CHUNK.licenseTier,
        chunk_text: COLORECTAL_CHUNK.quote,
    },
    {
        id: 'uspstf::lipid-screening--recommendation-summary',
        score: 0.55,
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

const buildPineconeStub = (
    queryFn: (opts: PineconeQueryOptions) => Promise<readonly PineconeHybridHit[]>,
): PineconeRetriever => ({
    isEmpty: false,
    query: queryFn,
});

const buildCohereStub = (rerank: CohereRerankClient['rerank']): CohereRerankClient => ({ rerank });

describe('§C.7 guidelines retriever — 4 cases', () => {
    it('case 1: relevant query → top-1 chunk; verifier accepts a guideline claim citing it', async () => {
        const pinecone = buildPineconeStub(() => Promise.resolve(HITS));
        const cohere = buildCohereStub(() =>
            // Cohere reranks the colorectal chunk to top with high score.
            // The C.3 node passes `topN: top_k` to cohere; the stub
            // returns just one result so the snippet count matches.
            Promise.resolve([{ index: 0, relevanceScore: 0.97 }]),
        );
        const node = createEvidenceRetriever({ pineconeRetriever: pinecone, cohereRerank: cohere });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 1 }) }));
        const result = out.evidenceRetrieverOutput ?? null;
        expect(result?.gap).toBeNull();
        expect(result?.snippets).toHaveLength(1);
        const top = result!.snippets[0]!;
        expect(top.chunkId).toBe(COLORECTAL_CHUNK.chunkId);

        // Verifier accepts a guideline claim citing the top chunk.
        const claim: Claim = {
            id: 'cl-1',
            text: 'USPSTF recommends colorectal cancer screening for adults aged 45 to 75.',
            category: 'reminder',
            sourceReferences: [guidelineSourceRef(top, '45 to 75')],
            safetyCritical: false,
        };
        const ledger: ClaimLedger = { claims: [claim] };
        const verified = verifyLedger(baseSnapshot(), ledger, {
            evidenceRetrieverOutput: result,
        });
        expect(verified.passed).toBe(true);
        expect(verified.accepted).toHaveLength(1);
    });

    it('case 2: out-of-scope query — empty snippets with no Gap; verifier rejects a claim citing a non-existent chunk', async () => {
        const pinecone = buildPineconeStub(() => Promise.resolve([]));
        const rerank = vi.fn(() => Promise.resolve(null));
        const cohere = buildCohereStub(rerank);
        const node = createEvidenceRetriever({ pineconeRetriever: pinecone, cohereRerank: cohere });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ query: 'nonsense' }) }));
        const result = out.evidenceRetrieverOutput ?? null;
        expect(result?.snippets).toEqual([]);
        expect(result?.gap).toBeNull();
        // Skipping rerank when there's nothing to rerank — burning a
        // Cohere call on an empty list would be a regression.
        expect(rerank).not.toHaveBeenCalled();

        // Any guideline claim against this empty result rejects.
        const claim: Claim = {
            id: 'cl-1',
            text: 'USPSTF recommends colorectal screening',
            category: 'reminder',
            sourceReferences: [
                guidelineSourceRef(guidelineSnippet({ chunkId: 'made-up-chunk' }), 'screening'),
            ],
            safetyCritical: false,
        };
        const verified = verifyLedger(baseSnapshot(), { claims: [claim] }, {
            evidenceRetrieverOutput: result,
        });
        expect(verified.passed).toBe(false);
        expect(verified.rejected).toHaveLength(1);
    });

    it('case 3: Cohere outage — falls through to top-k by Pinecone hybrid score; degradedRerank: true on every snippet', async () => {
        const pinecone = buildPineconeStub(() => Promise.resolve(HITS));
        // null is the cohere.ts contract for "service unavailable —
        // use Pinecone's hybrid order."
        const cohere = buildCohereStub(() => Promise.resolve(null));
        const node = createEvidenceRetriever({ pineconeRetriever: pinecone, cohereRerank: cohere });

        const out = await node(baseState({ evidenceRetrieverArgs: args({ top_k: 2 }) }));
        const result = out.evidenceRetrieverOutput;
        expect(result?.gap).toBeNull();
        expect(result?.snippets).toHaveLength(2);
        expect(result?.snippets.every((s) => s.degradedRerank)).toBe(true);
        // Hybrid order preserved: colorectal (0.81) before lipid (0.55).
        expect(result?.snippets[0]?.chunkId).toBe(COLORECTAL_CHUNK.chunkId);
        expect(result?.snippets[0]?.rerankScore).toBe(0.81);
    });

    it('case 4: Pinecone outage — Gap{evidence-retrieval-unavailable}; verifier rejects guideline citations as unresolved', async () => {
        const pinecone = buildPineconeStub(() =>
            Promise.reject(new PineconeUnavailableError('connection reset')),
        );
        const rerank = vi.fn(() => Promise.resolve(null));
        const cohere = buildCohereStub(rerank);
        const node = createEvidenceRetriever({ pineconeRetriever: pinecone, cohereRerank: cohere });

        const out = await node(baseState({ evidenceRetrieverArgs: args() }));
        const result = out.evidenceRetrieverOutput;
        expect(result?.snippets).toEqual([]);
        expect(result?.gap?.kind).toBe('gap');
        expect(result?.gap?.reason).toBe('evidence-retrieval-unavailable');
        // Cohere should not have been called when Pinecone failed.
        expect(rerank).not.toHaveBeenCalled();

        // Verifier: a guideline claim under a Gap rejects as
        // unresolved — the supervisor was supposed to route around the
        // gap; if a citation reached us anyway, treat the index as
        // unavailable.
        const claim: Claim = {
            id: 'cl-1',
            text: 'USPSTF recommends colorectal screening',
            category: 'reminder',
            sourceReferences: [
                guidelineSourceRef(guidelineSnippet(), 'screening'),
            ],
            safetyCritical: false,
        };
        const gappedOutput: EvidenceRetrieverOutput = result!;
        const verified = verifyLedger(baseSnapshot(), { claims: [claim] }, {
            evidenceRetrieverOutput: gappedOutput,
        });
        expect(verified.rejected).toHaveLength(1);
        expect(verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});
