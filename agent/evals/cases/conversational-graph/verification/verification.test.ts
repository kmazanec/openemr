/**
 * §C.7 conversational-graph evals — verification (4 cases).
 *
 * Drives `verifyLedger` over the three `source_type` resolution paths
 * the C.5 implementation owns. Each case pins one structural invariant
 * that a structural regression in the verifier or the supporting
 * snippets would break:
 *  1. Chart claim accept/reject (W1 carry-forward, renamed to the
 *     unified `SourceReference` shape).
 *  2. Extracted-document claim with a fabricated bbox is rejected
 *     even when the artifact id resolves — the architecture's
 *     explicit failure mode for this rule.
 *  3. Guideline claim citing a chunk_id not in this turn's retriever
 *     output is rejected — protects against fabricated guideline
 *     citations under retriever-bypass cycles.
 *  4. Low-confidence allergy fact in an intake form fires the
 *     category-level fail-closed (allergy + medication content
 *     suppressed for the turn).
 */

import { describe, expect, it } from 'vitest';

import type {
    Claim,
    ClaimLedger,
    EvidenceRetrieverOutput,
} from '../../../../src/graph/types.js';
import {
    HARD_STOP_ALLERGIES_UNAVAILABLE,
    verifyLedger,
} from '../../../../src/verify/verifier.js';
import {
    baseSnapshot,
    chartRef,
    extractedDocRef,
    factSnippet,
    guidelineSnippet,
    guidelineSourceRef,
    intakeArtifact,
} from '../_helpers.js';

describe('§C.7 verification — 4 cases', () => {
    it('case 1: chart claim accept/reject — W1 carry-forward under the unified SourceReference shape', () => {
        const snapshot = baseSnapshot({
            diagnoses: [
                {
                    code: 'E11.9',
                    codeSystem: 'ICD-10',
                    label: 'Type 2 diabetes',
                    onsetDate: '2020-01-01',
                    source: chartRef('c-1', 'condition.code'),
                },
            ],
        });

        const accepted: Claim = {
            id: 'cl-accepted',
            text: 'Active diagnosis: Type 2 diabetes (E11.9)',
            category: 'diagnosis',
            sourceReferences: [chartRef('c-1', 'condition.code')],
            safetyCritical: false,
        };
        const rejected: Claim = {
            id: 'cl-rejected',
            text: 'Active diagnosis: Hypertension (I10)',
            category: 'diagnosis',
            // Hallucinated source_id — no diagnosis row matches.
            sourceReferences: [chartRef('c-fake', 'condition.code')],
            safetyCritical: false,
        };
        const ledger: ClaimLedger = { claims: [accepted, rejected] };
        const verified = verifyLedger(snapshot, ledger);
        expect(verified.accepted).toHaveLength(1);
        expect(verified.accepted[0]?.id).toBe('cl-accepted');
        expect(verified.rejected).toHaveLength(1);
        expect(verified.rejected[0]?.claim.id).toBe('cl-rejected');
        expect(verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('case 2: extracted-document claim with a fabricated bbox is rejected even when the artifact id resolves', () => {
        const realSnippet = factSnippet();
        // The architecture's bbox-fabrication failure mode rejects the
        // claim via REJECT_CONTENT — same artifact id + field path,
        // wrong bbox.
        const honestRef = extractedDocRef(realSnippet, 'HbA1c 6.4');
        const fabricatedRef = {
            ...honestRef,
            locator: { ...honestRef.locator, bbox: [0, 0, 50, 50] as const },
        };
        const claim: Claim = {
            id: 'cl-1',
            text: 'HbA1c was 6.4 %',
            category: 'lab',
            sourceReferences: [fabricatedRef],
            safetyCritical: false,
        };
        const verified = verifyLedger(baseSnapshot(), { claims: [claim] }, {
            documentEvidenceSnippets: [realSnippet],
        });
        expect(verified.passed).toBe(false);
        expect(verified.rejected).toHaveLength(1);
        expect(verified.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
    });

    it('case 3: guideline claim citing a chunk_id not in this turn\'s retriever output is rejected', () => {
        // The retriever returned the colorectal chunk this turn — the
        // claim cites a different chunk id.
        const output: EvidenceRetrieverOutput = {
            snippets: [guidelineSnippet()],
            gap: null,
        };
        const fabricated = guidelineSnippet({
            chunkId: 'uspstf::nonexistent-chunk--recommendation-summary',
        });
        const claim: Claim = {
            id: 'cl-1',
            text: 'USPSTF recommends colorectal screening',
            category: 'reminder',
            sourceReferences: [guidelineSourceRef(fabricated, 'screening')],
            safetyCritical: false,
        };
        const verified = verifyLedger(baseSnapshot(), { claims: [claim] }, {
            evidenceRetrieverOutput: output,
        });
        expect(verified.passed).toBe(false);
        expect(verified.rejected).toHaveLength(1);
        expect(verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('case 4: low-confidence allergy in intake form fires HARD_STOP_ALLERGIES_UNAVAILABLE; allergy + prescription content suppressed', () => {
        // Snapshot itself has a normal prescription row; the allergy
        // hard-stop should suppress it regardless of chart-side state.
        const snapshot = baseSnapshot({
            prescriptions: [
                {
                    name: 'Metformin',
                    dose: '500 mg',
                    route: 'PO',
                    frequency: 'BID',
                    startDate: '2020-01-01',
                    stopDate: null,
                    prescriber: 'Dr. Patel',
                    indication: null,
                    prescriptionId: 'rx-1',
                    source: chartRef('rx-1', 'medication.name'),
                },
            ],
        });

        const lowConfArtifact = intakeArtifact();
        const allergySnippet = factSnippet({
            artifactId: lowConfArtifact.artifactId,
            documentUuid: lowConfArtifact.documentUuid,
            docType: 'intake_form',
            fieldPath: 'allergies.0',
            value: 'penicillin',
            page: 2,
            bbox: [50, 300, 250, 320],
            quote: 'Allergies: penicillin (rash)',
            confidence: 0.55,
        });
        const allergyClaim: Claim = {
            id: 'cl-allergy',
            text: 'Patient lists penicillin allergy on intake form.',
            category: 'allergy',
            sourceReferences: [extractedDocRef(allergySnippet, 'penicillin')],
            safetyCritical: true,
        };
        const rxClaim: Claim = {
            id: 'cl-rx',
            text: 'Active medication: Metformin 500 mg',
            category: 'prescription',
            sourceReferences: [chartRef('rx-1', 'medication.name')],
            safetyCritical: true,
        };
        const ledger: ClaimLedger = { claims: [allergyClaim, rxClaim] };

        const verified = verifyLedger(snapshot, ledger, {
            documentEvidenceSnippets: [allergySnippet],
            artifactConfidence: new Map([
                [lowConfArtifact.artifactId, lowConfArtifact.confidenceSignal],
            ]),
        });
        expect(verified.passed).toBe(false);
        expect(verified.safetyHardStops).toContain(HARD_STOP_ALLERGIES_UNAVAILABLE);

        // Both the low-confidence allergy AND the chart prescription
        // are suppressed under the category fail-closed — the C.5
        // "allergy + medication symmetric suppression" rule.
        expect(verified.accepted).toHaveLength(0);
        const rejectedRxReasons = verified.rejected
            .filter((r) => r.claim.id === 'cl-rx')
            .map((r) => r.reason);
        expect(rejectedRxReasons).toContain('safety-critical-data-unavailable');
    });
});
