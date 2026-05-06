/**
 * Mrs. Patel scenario — three end-to-end cases.
 *
 * The scenario the MVP demo and Phase D's definition-of-done center
 * on: a 58-year-old with type 2 diabetes returns for follow-up; the
 * clinician attaches her new lab PDF and her self-reported intake
 * form. The agent should:
 *
 *   1. Surface chart-based facts (active diagnosis, current
 *      metformin Rx, prior-encounter context) in the "What's in the
 *      chart" section.
 *   2. Surface document-based facts (the just-uploaded HbA1c result
 *      and the intake-form symptom note) in the "From documents"
 *      section, one card per `document_uuid`.
 *   3. Surface the supporting guideline snippet in the "Evidence"
 *      section — the synthesizer is forbidden from naming USPSTF /
 *      ADA from training, so the guideline text only appears when
 *      the retriever produced it.
 *
 * The three cases below exercise three coverage shapes:
 *
 *   - **Lab + chart only.** No intake form; the document section
 *     contains exactly the lab card.
 *   - **Intake + chart only.** No lab; the document section contains
 *     exactly the intake card.
 *   - **Lab + intake + chart together.** The document section
 *     contains two cards (one per document_uuid), and all three
 *     source-type sections render simultaneously — the MVP demo's
 *     headline shape.
 *
 * The per-MR layer feeds verify → format directly with a hand-rolled
 * draft + ledger, which is sufficient to pin the structural
 * invariants (grouping, citations, empty-section omission, claim
 * acceptance) without an LLM call. Real-vendor coverage of the same
 * scenarios runs through `endToEndSuite.ts` in the nightly LangSmith
 * experiment.
 */

import { describe, expect, it } from 'vitest';

import type { Claim, DraftBriefing } from '../../../../src/graph/types.js';
import {
    DIABETES_GLYCEMIC_CHUNK,
    chartRef,
    draftSegment,
    extractedDocRef,
    guidelineRef,
    guidelineSnippet,
    intakeFactSnippet,
    labFactSnippet,
    patelEnvelope,
    patelSnapshot,
    runEndToEnd,
} from '../_helpers.js';

const chartDxClaim: Claim = {
    id: 'cl-dx',
    text: 'Active diagnosis: Type 2 diabetes (E11.9), since 2020-01-01.',
    category: 'diagnosis',
    sourceReferences: [chartRef('dx-1', 'condition.code')],
    safetyCritical: false,
};

const chartRxClaim: Claim = {
    id: 'cl-rx',
    text: 'Active prescription: Metformin 500 mg twice daily.',
    category: 'prescription',
    sourceReferences: [chartRef('rx-met-1', 'medication.name')],
    safetyCritical: false,
};

const chartEncounterClaim: Claim = {
    id: 'cl-enc',
    text: 'Prior diabetes follow-up encounter on 2026-04-01.',
    category: 'encounter',
    sourceReferences: [chartRef('enc-1', 'encounter.reason')],
    safetyCritical: false,
};

describe('§D.4 Mrs. Patel scenario — end-to-end', () => {
    it('lab + chart only — chart and document sections render; guideline section absent without retriever output', async () => {
        const labSnippet = labFactSnippet();
        const labClaim: Claim = {
            id: 'cl-lab',
            text: 'HbA1c 8.1 % from the recent lab PDF (page 1) — abnormal-high.',
            category: 'lab',
            sourceReferences: [extractedDocRef(labSnippet, 'HbA1c 8.1')],
            safetyCritical: false,
        };

        const draft: DraftBriefing = {
            segments: [
                draftSegment("Mrs. Patel's chart shows ", []),
                draftSegment('an active type 2 diabetes diagnosis', ['cl-dx']),
                draftSegment(' and an active metformin prescription. ', ['cl-rx']),
                draftSegment('The lab PDF reports HbA1c 8.1 %.', ['cl-lab']),
            ],
        };

        const out = await runEndToEnd({
            envelope: patelEnvelope(),
            snapshot: patelSnapshot(),
            draft,
            claims: [chartDxClaim, chartRxClaim, labClaim],
            documentEvidenceSnippets: [labSnippet],
        });

        expect(
            out.verified.passed,
            `verified.rejected = ${JSON.stringify(out.verified.rejected.map((r) => ({ id: r.claim.id, reason: r.reason })))}`,
        ).toBe(true);
        expect(out.verified.accepted.map((c) => c.id).sort()).toEqual(['cl-dx', 'cl-lab', 'cl-rx']);

        // Chart section: two sub-categories (diagnosis + prescription).
        expect(out.formatted.claimGroups.chart).toBeDefined();
        const chartCategories = (out.formatted.claimGroups.chart?.subsections ?? []).map(
            (s) => s.category,
        );
        expect(chartCategories.sort()).toEqual(['diagnosis', 'prescription']);

        // Document section: exactly one card (the lab document_uuid).
        expect(out.formatted.claimGroups.extractedDocument).toBeDefined();
        const cards = out.formatted.claimGroups.extractedDocument?.cards ?? [];
        expect(cards).toHaveLength(1);
        expect(cards[0]?.documentUuid).toBe('doc-lab-patel-0001');
        expect(cards[0]?.claims.map((c) => c.id)).toEqual(['cl-lab']);

        // Guideline section omitted — no evidenceRetrieverOutput, so a
        // guideline-typed claim could not have been verified anyway.
        expect(out.formatted.claimGroups.guideline).toBeUndefined();
    });

    it('intake + chart only — chart and document sections render; guideline section absent', async () => {
        const intakeSnippet = intakeFactSnippet();
        const intakeClaim: Claim = {
            id: 'cl-intake',
            text: 'Patient self-reports new symptom: blurry vision in the morning (from the intake form, page 2).',
            category: 'encounter',
            sourceReferences: [extractedDocRef(intakeSnippet, 'blurry vision')],
            safetyCritical: false,
        };

        const draft: DraftBriefing = {
            segments: [
                draftSegment("Mrs. Patel's chart shows ", []),
                draftSegment('an active type 2 diabetes diagnosis', ['cl-dx']),
                draftSegment(' with the most recent visit on 2026-04-01. ', ['cl-enc']),
                draftSegment(
                    'On the new intake form she reports a new symptom: blurry vision in the morning.',
                    ['cl-intake'],
                ),
            ],
        };

        const out = await runEndToEnd({
            envelope: patelEnvelope(),
            snapshot: patelSnapshot(),
            draft,
            claims: [chartDxClaim, chartEncounterClaim, intakeClaim],
            documentEvidenceSnippets: [intakeSnippet],
        });

        expect(out.verified.passed).toBe(true);
        expect(out.verified.accepted).toHaveLength(3);

        expect(out.formatted.claimGroups.chart).toBeDefined();
        const chartCategories = (out.formatted.claimGroups.chart?.subsections ?? []).map(
            (s) => s.category,
        );
        expect(chartCategories.sort()).toEqual(['diagnosis', 'encounter']);

        const cards = out.formatted.claimGroups.extractedDocument?.cards ?? [];
        expect(cards).toHaveLength(1);
        expect(cards[0]?.documentUuid).toBe('doc-intake-patel-0001');

        expect(out.formatted.claimGroups.guideline).toBeUndefined();
    });

    it('lab + intake + chart together — all three source-type sections render; one card per document_uuid', async () => {
        const labSnippet = labFactSnippet();
        const intakeSnippet = intakeFactSnippet();
        const guideline = guidelineSnippet();

        const labClaim: Claim = {
            id: 'cl-lab',
            text: 'HbA1c 8.1 % from the recent lab PDF — abnormal-high.',
            category: 'lab',
            sourceReferences: [extractedDocRef(labSnippet, 'HbA1c 8.1')],
            safetyCritical: false,
        };
        const intakeClaim: Claim = {
            id: 'cl-intake',
            text: 'Patient self-reports new symptom: blurry vision in the morning.',
            category: 'encounter',
            sourceReferences: [extractedDocRef(intakeSnippet, 'blurry vision')],
            safetyCritical: false,
        };
        const guidelineClaim: Claim = {
            id: 'cl-guide',
            text: 'ADA glycemic-targets summary: A1C target <7 % is reasonable; intensification should be considered when A1C exceeds the goal.',
            category: 'reminder',
            sourceReferences: [guidelineRef(guideline, 'A1C target')],
            safetyCritical: false,
        };

        const draft: DraftBriefing = {
            segments: [
                draftSegment("Mrs. Patel's chart shows ", []),
                draftSegment('an active type 2 diabetes diagnosis', ['cl-dx']),
                draftSegment(' and an active metformin prescription. ', ['cl-rx']),
                draftSegment('The lab PDF reports HbA1c 8.1 %, abnormal-high. ', ['cl-lab']),
                draftSegment('On the intake form she reports new blurry vision in the morning. ', [
                    'cl-intake',
                ]),
                draftSegment(
                    "Per ADA's glycemic targets, intensification should be considered when A1C exceeds goal.",
                    ['cl-guide'],
                ),
            ],
        };

        const out = await runEndToEnd({
            envelope: patelEnvelope(),
            snapshot: patelSnapshot(),
            draft,
            claims: [chartDxClaim, chartRxClaim, labClaim, intakeClaim, guidelineClaim],
            documentEvidenceSnippets: [labSnippet, intakeSnippet],
            evidenceRetrieverOutput: { snippets: [guideline], gap: null },
        });

        expect(out.verified.passed).toBe(true);
        expect(out.verified.accepted).toHaveLength(5);

        // All three sections present.
        expect(out.formatted.claimGroups.chart).toBeDefined();
        expect(out.formatted.claimGroups.extractedDocument).toBeDefined();
        expect(out.formatted.claimGroups.guideline).toBeDefined();

        // Document section: two cards, one per document_uuid.
        const cards = out.formatted.claimGroups.extractedDocument?.cards ?? [];
        expect(cards).toHaveLength(2);
        const cardUuids = cards.map((c) => c.documentUuid).sort();
        expect(cardUuids).toEqual(['doc-intake-patel-0001', 'doc-lab-patel-0001']);

        // Guideline section: exactly the one accepted guideline claim.
        const guidelineClaims = out.formatted.claimGroups.guideline?.claims ?? [];
        expect(guidelineClaims).toHaveLength(1);
        expect(guidelineClaims[0]?.id).toBe('cl-guide');
        expect(guidelineClaims[0]?.sourceReferences[0]?.source_id).toBe(
            DIABETES_GLYCEMIC_CHUNK.chunkId,
        );

        // Chart section: diagnosis + prescription, sorted by W1
        // category order in the format node.
        const chartCategories = (out.formatted.claimGroups.chart?.subsections ?? []).map(
            (s) => s.category,
        );
        expect(chartCategories.sort()).toEqual(['diagnosis', 'prescription']);

        // Every accepted claim carries at least one SourceReference —
        // the citation invariant the demo's claim chips depend on.
        for (const claim of out.verified.accepted) {
            expect(
                claim.sourceReferences.length,
                `claim ${claim.id} must carry ≥1 SourceReference`,
            ).toBeGreaterThan(0);
        }
    });
});
