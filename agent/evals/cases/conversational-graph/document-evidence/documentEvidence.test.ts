/**
 * Document-evidence retriever evals.
 *
 * Drives the retriever node with a fake `searchArtifacts` store and
 * asserts the four invariants the per-MR gate must hold:
 *  1. Returned snippets preserve bbox/page/quote so the verifier can
 *     resolve `extracted_document` citations against them.
 *  2. The store filter is always scoped to `envelope.patient.pid`; a
 *     query against patient A's session never leaks patient B's
 *     artifacts.
 *  3. `lookback_days` excludes stale artifacts (the store treats
 *     `since` as a hard predicate, not a soft hint).
 *  4. The empty-state path returns `[]` — distinct from `null` (the
 *     retriever did not run this turn).
 */

import { describe, expect, it } from 'vitest';

import { createDocumentEvidenceRetriever } from '../../../../src/graph/nodes/documentEvidenceRetriever.js';
import type {
    Claim,
    ClaimLedger,
    DocumentEvidenceArgs,
} from '../../../../src/graph/types.js';
import { verifyLedger } from '../../../../src/verify/verifier.js';
import {
    NOW,
    OTHER_PID,
    PID,
    baseEnvelope,
    baseSnapshot,
    baseState,
    extractedDocRef,
    factSnippet,
    fakeArtifactStore,
    labArtifact,
} from '../_helpers.js';

const args = (overrides: Partial<DocumentEvidenceArgs> = {}): DocumentEvidenceArgs => ({
    query: 'HbA1c',
    lookback_days: 90,
    top_k: 5,
    ...overrides,
});

describe('document-evidence retriever', () => {
    it('per-patient retrieval preserves bbox/page/quote so the verifier accepts an extracted_document claim', async () => {
        const artifact = labArtifact();
        const store = fakeArtifactStore(new Map([[PID, [artifact]]]));
        const node = createDocumentEvidenceRetriever({ store, now: () => NOW });

        const out = await node(baseState({ documentEvidenceArgs: args() }));
        const snippets = out.documentEvidenceSnippets ?? [];
        expect(snippets.length).toBe(1);
        const snippet = snippets[0]!;

        // Verifier accepts a claim citing the snippet with the recorded
        // page + bbox + a quote substring.
        const claim: Claim = {
            id: 'cl-1',
            text: 'HbA1c 6.4 % from the recent lab PDF',
            category: 'lab',
            sourceReferences: [extractedDocRef(snippet, 'HbA1c 6.4')],
            safetyCritical: false,
        };
        const ledger: ClaimLedger = { claims: [claim] };
        const verified = verifyLedger(baseSnapshot(), ledger, {
            documentEvidenceSnippets: snippets,
            artifactConfidence: out.documentEvidenceArtifactConfidence ?? new Map(),
        });
        expect(verified.passed).toBe(true);
        expect(verified.accepted).toHaveLength(1);
        expect(verified.rejected).toHaveLength(0);
    });

    it('pid scope cannot be widened — patient B query against patient A envelope returns no artifacts', async () => {
        const patientAArtifact = labArtifact({ pid: PID, artifactId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
        const patientBArtifact = labArtifact({ pid: OTHER_PID, artifactId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
        const store = fakeArtifactStore(
            new Map([
                [PID, [patientAArtifact]],
                [OTHER_PID, [patientBArtifact]],
            ]),
        );
        const node = createDocumentEvidenceRetriever({ store, now: () => NOW });

        // Envelope is patient B's session; even though the store has
        // patient A's artifact, the retriever must not surface it.
        const out = await node(
            baseState({
                envelope: baseEnvelope({ patient: { pid: OTHER_PID, uuid: 'p-other' } }),
                documentEvidenceArgs: args(),
            }),
        );
        const snippets = out.documentEvidenceSnippets ?? [];
        expect(snippets.length).toBe(1);
        expect(snippets[0]?.artifactId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

        // Filter passed to the store was scoped to OTHER_PID — the
        // model could not have widened it.
        expect(store.calls).toHaveLength(1);
        expect(store.calls[0]?.pid).toBe(OTHER_PID);
    });

    it('stale lookback_days excludes old artifacts', async () => {
        const fresh = labArtifact({
            artifactId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            createdAt: '2026-05-03T00:00:00.000Z', // 2 days before NOW
        });
        const stale = labArtifact({
            artifactId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            createdAt: '2026-04-15T00:00:00.000Z', // 20 days before NOW
        });
        const store = fakeArtifactStore(new Map([[PID, [fresh, stale]]]));
        const node = createDocumentEvidenceRetriever({ store, now: () => NOW });

        const out = await node(
            baseState({ documentEvidenceArgs: args({ lookback_days: 7, top_k: 5 }) }),
        );
        const snippets = out.documentEvidenceSnippets ?? [];
        expect(snippets).toHaveLength(1);
        expect(snippets[0]?.artifactId).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
    });

    it('empty-state — no artifacts returns [] (not null) and the verifier rejects an extracted_document claim against it', async () => {
        const store = fakeArtifactStore(new Map());
        const node = createDocumentEvidenceRetriever({ store, now: () => NOW });

        const out = await node(baseState({ documentEvidenceArgs: args() }));
        expect(out.documentEvidenceSnippets).toEqual([]);

        // A claim cited against a non-existent extracted_document
        // artifact resolves as unresolved — the gate that protects
        // against fabricated extractions when no documents exist for
        // this patient.
        const claim: Claim = {
            id: 'cl-1',
            text: 'HbA1c 6.4 % from a recent lab',
            category: 'lab',
            sourceReferences: [
                extractedDocRef(factSnippet({ artifactId: 'fake-artifact-id' }), 'HbA1c 6.4'),
            ],
            safetyCritical: false,
        };
        const verified = verifyLedger(baseSnapshot(), { claims: [claim] }, {
            documentEvidenceSnippets: out.documentEvidenceSnippets ?? [],
        });
        expect(verified.passed).toBe(false);
        expect(verified.rejected).toHaveLength(1);
        expect(verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});
