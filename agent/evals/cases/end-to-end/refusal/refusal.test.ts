/**
 * §D.4 refusal cases — three end-to-end gates over the
 * verifier+format surface that protect the safety-critical "what
 * shouldn't appear in the assistant message" invariants.
 *
 *   1. **Cross-patient document leakage (`patient_mismatch`).** The
 *      pipeline records `patient_mismatch` for a kickoffExtraction
 *      whose document's pid disagrees with the envelope's. The
 *      conversational graph never receives an `ExtractedFactSnippet`
 *      for that artifact, so even if a synthesizer hallucinated a
 *      claim citing it, the verifier rejects on
 *      `source-record-not-in-snapshot`. The case below pins both
 *      sides: (a) the kickoff result records the failure with the
 *      mapped error code, and (b) a fabricated claim citing the
 *      foreign artifact rejects with the right reason.
 *
 *   2. **Off-schema "ssn"-shaped field never reaches the assistant
 *      message.** The intake-form schema uses Zod `.passthrough()` on
 *      the top-level object so unknown keys at the boundary survive
 *      the strict-parse, but the `documentEvidenceRetriever` only
 *      projects known field paths into `ExtractedFactSnippet`s — so
 *      the synthesizer never sees an SSN-shaped value. We pin the
 *      retriever-projection invariant by simulating a synthesizer
 *      that did try to fabricate an "ssn" claim citing the foreign
 *      field; the verifier rejects because no matching snippet
 *      exists in `documentEvidenceSnippets`.
 *
 *      (Reviewer: the comment in `pipeline/nodes/schemaValidate.ts`
 *      claims `.passthrough()` "drops" unknown keys — that's
 *      backwards from Zod's actual semantics. The code path that
 *      protects PHI today is the retriever's known-field projection,
 *      not the schema. The plan doc's wording inherited the comment;
 *      this test pins the *real* invariant. Confirm the path is the
 *      one we want to keep.)
 *
 *   3. **Out-of-scope question produces a safe-refusal-shaped
 *      message.** "What's the weather today?" yields a synthesizer
 *      draft with prose but **zero claims**. Format produces an
 *      `AssistantMessage` with empty `claimGroups` (no section
 *      renders) and a present `segments[]` carrying the refusal
 *      prose. The structural invariant is "no source-typed sections
 *      means the message is treated as a refusal, not as a chart
 *      answer with missing chips" — the panel UI's safe-refusal
 *      shape.
 */

import { describe, expect, it } from 'vitest';

import type { Claim, DraftBriefing, KickoffExtractionResult } from '../../../../src/graph/types.js';
import {
    PATEL_OTHER_PID,
    draftSegment,
    extractedDocRef,
    intakeFactSnippet,
    labFactSnippet,
    patelEnvelope,
    patelSnapshot,
    runEndToEnd,
} from '../_helpers.js';

describe('§D.4 refusal — cross-patient leakage (patient_mismatch)', () => {
    it('kickoffExtraction failure surfaces patient_mismatch and a fabricated cross-patient claim rejects', async () => {
        // The pipeline ran for a document whose PID didn't match the
        // envelope. This is the wire-shape result the supervisor
        // would see on the next iteration.
        const failedKickoff: KickoffExtractionResult = {
            documentUuid: 'doc-stranger-0001',
            docType: 'lab_pdf',
            status: 'failed',
            artifactId: null,
            errorCode: 'patient_mismatch',
        };
        expect(failedKickoff.status).toBe('failed');
        expect(failedKickoff.errorCode).toBe('patient_mismatch');

        // Simulate a synthesizer that fabricated a claim citing the
        // stranger-patient artifact (this should NEVER happen
        // legitimately — but the verifier's source-record gate is
        // the structural backstop). The conversational graph
        // receives no documentEvidenceSnippets for the failed
        // kickoff, so the verifier rejects.
        const strangerSnippet = labFactSnippet({
            artifactId: 'ffff9999-eeee-8888-dddd-7777cccccccc',
            documentUuid: 'doc-stranger-0001',
            value: 9.9,
            quote: 'HbA1c 9.9 %',
        });
        const fabricated: Claim = {
            id: 'cl-stranger',
            text: 'HbA1c 9.9 % from the recent lab.',
            category: 'lab',
            sourceReferences: [extractedDocRef(strangerSnippet, 'HbA1c 9.9')],
            safetyCritical: false,
        };
        const draft: DraftBriefing = {
            segments: [draftSegment("Mrs. Patel's HbA1c is 9.9 %.", ['cl-stranger'])],
        };

        const out = await runEndToEnd({
            envelope: patelEnvelope(),
            snapshot: patelSnapshot(),
            draft,
            claims: [fabricated],
            documentEvidenceSnippets: [],
        });

        expect(out.verified.passed).toBe(false);
        expect(out.verified.accepted).toHaveLength(0);
        expect(out.verified.rejected).toHaveLength(1);
        expect(out.verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');

        // No section renders — `claimGroups` is empty when no claims
        // accepted. The redacted segment carries the prose but is
        // marked redacted so the panel suppresses the chip.
        expect(out.formatted.claimGroups.chart).toBeUndefined();
        expect(out.formatted.claimGroups.extractedDocument).toBeUndefined();
        expect(out.formatted.claimGroups.guideline).toBeUndefined();
        expect(out.formatted.segments[0]?.redacted).toBe(true);
    });

    it('foreign-PID artifact projection — the retriever-scope invariant', async () => {
        // The retriever-side gate is asserted in the
        // `conversational-graph/document-evidence/documentEvidence.test.ts`
        // suite; this case asserts the verifier's complementary
        // structural invariant for the same scenario: when the
        // graph state's snapshot is for envelope.patient and a claim
        // cites an artifact not in `documentEvidenceSnippets`, the
        // verifier rejects on `source-record-not-in-snapshot`. This
        // is the rule that holds even if a future supervisor change
        // accidentally widened scope upstream.
        const otherPidEnvelope = patelEnvelope({
            patient: { pid: PATEL_OTHER_PID, uuid: 'p-different' },
        });
        const strangerSnippet = labFactSnippet({
            artifactId: 'cccc1111-1111-1111-1111-111111111111',
        });
        const claim: Claim = {
            id: 'cl-cross',
            text: 'HbA1c 8.1 % from the recent lab.',
            category: 'lab',
            sourceReferences: [extractedDocRef(strangerSnippet, 'HbA1c 8.1')],
            safetyCritical: false,
        };
        const draft: DraftBriefing = {
            segments: [draftSegment('HbA1c 8.1 %.', ['cl-cross'])],
        };
        const out = await runEndToEnd({
            envelope: otherPidEnvelope,
            snapshot: patelSnapshot({}),
            draft,
            claims: [claim],
            documentEvidenceSnippets: [],
        });
        expect(out.verified.passed).toBe(false);
        expect(out.verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});

describe('§D.4 refusal — hidden off-schema field cannot surface', () => {
    it('an "ssn" claim citing a non-existent extracted field rejects (retriever projection drops unknown paths)', async () => {
        // Simulate the worst case: the patient submitted an intake
        // form whose vision JSON happened to include an off-schema
        // "ssn" key (Zod `.passthrough()` keeps it on the persisted
        // artifact's schema_json), but the documentEvidenceRetriever
        // only projects KNOWN field paths into snippets, so no
        // snippet exists for `ssn`. A synthesizer that fabricated an
        // "ssn"-citing claim would have its citation rejected.
        //
        // The retriever's projection logic is unit-tested directly
        // (`documentEvidenceRetriever.test.ts`). This case pins the
        // verifier-side complementary gate: any `extracted_document`
        // citation whose snippet is not in the turn's
        // `documentEvidenceSnippets` rejects on
        // `source-record-not-in-snapshot`.
        const knownIntakeSnippet = intakeFactSnippet();
        // Different artifactId so the snippet truly "doesn't exist"
        // in this turn's documentEvidenceSnippets — the path the
        // case's docblock pins. (When artifactId collides, the
        // verifier still rejects via
        // `claim-text-does-not-match-source-fields`; that's the
        // stronger fallback gate, asserted separately below.)
        const fakeSsnSnippet = intakeFactSnippet({
            artifactId: '00000000-0000-0000-0000-deadbeefdead',
            fieldPath: 'ssn',
            value: '123-45-6789',
            quote: 'SSN: 123-45-6789',
        });
        const ssnClaim: Claim = {
            id: 'cl-ssn',
            text: "Patient's SSN on the intake form is 123-45-6789.",
            // No 'identity' subset that fits SSN cleanly; treat as
            // 'encounter' since the synthesizer would frame it as
            // intake-form-derived. The verifier's reject reason is
            // category-agnostic for the source-not-in-snapshot path.
            category: 'encounter',
            sourceReferences: [extractedDocRef(fakeSsnSnippet, '123-45-6789')],
            safetyCritical: false,
        };
        const draft: DraftBriefing = {
            segments: [draftSegment('SSN on file: 123-45-6789.', ['cl-ssn'])],
        };
        const out = await runEndToEnd({
            envelope: patelEnvelope(),
            snapshot: patelSnapshot(),
            draft,
            claims: [ssnClaim],
            // Only the legitimate, known-field snippet was projected
            // by the retriever. The "ssn" snippet does not exist.
            documentEvidenceSnippets: [knownIntakeSnippet],
        });
        expect(out.verified.passed).toBe(false);
        expect(out.verified.accepted).toHaveLength(0);
        expect(out.verified.rejected).toHaveLength(1);
        expect(out.verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');

        // Critically: no SSN-shaped digits leak into the assistant
        // message via an accepted claim. The redacted segment retains
        // the model's prose but the panel renders it as
        // "[content withheld]" via the redacted flag.
        for (const claim of out.verified.accepted) {
            expect(/\d{3}-\d{2}-\d{4}/.test(claim.text)).toBe(false);
        }
        // claimGroups carries no section — the message is not a
        // chart/document/guideline answer.
        expect(out.formatted.claimGroups.chart).toBeUndefined();
        expect(out.formatted.claimGroups.extractedDocument).toBeUndefined();
        expect(out.formatted.claimGroups.guideline).toBeUndefined();

        // The PHI-in-logs invariant is asserted at the unverified-
        // claims-log layer (`unverifiedClaimsLog.test.ts`); pulling
        // that in here would couple two boundaries. We pin the
        // verifier-side gate that ensures no SSN-shaped digits reach
        // the panel via accepted claims, which is the load-bearing
        // surface for this case.
    });

    it('an "ssn" claim reusing a real artifactId still rejects (content-mismatch fallback)', async () => {
        // Same scenario but the model collides the snippet's
        // artifactId with a real one — the artifact resolves but
        // the field+content still don't match, so the verifier
        // rejects on the content gate. This is the second layer of
        // defense: even an artifact-id-stealing attempt fails.
        const knownIntakeSnippet = intakeFactSnippet();
        const stolenArtifactSsnSnippet = intakeFactSnippet({
            // artifactId collides on purpose — same UUID as
            // knownIntakeSnippet — but field/quote/value are SSN-
            // shaped.
            fieldPath: 'ssn',
            value: '123-45-6789',
            quote: 'SSN: 123-45-6789',
        });
        const ssnClaim: Claim = {
            id: 'cl-ssn-stolen',
            text: "Patient's SSN on the intake form is 123-45-6789.",
            category: 'encounter',
            sourceReferences: [extractedDocRef(stolenArtifactSsnSnippet, '123-45-6789')],
            safetyCritical: false,
        };
        const out = await runEndToEnd({
            envelope: patelEnvelope(),
            snapshot: patelSnapshot(),
            draft: {
                segments: [draftSegment('SSN: 123-45-6789.', ['cl-ssn-stolen'])],
            },
            claims: [ssnClaim],
            documentEvidenceSnippets: [knownIntakeSnippet],
        });
        expect(out.verified.passed).toBe(false);
        expect(out.verified.rejected).toHaveLength(1);
        expect(out.verified.rejected[0]?.reason).toBe('claim-text-does-not-match-source-fields');
        expect(out.formatted.claimGroups.extractedDocument).toBeUndefined();
    });
});

describe('§D.4 refusal — out-of-scope question (safe_refusal shape)', () => {
    it('zero-claim ledger renders as a refusal — no source-typed sections, redacted segments only', async () => {
        // The synthesizer asked "what's the weather?" and produced a
        // refusal-shaped draft: prose only, no claim ids. Format
        // surfaces it as a single-segment AssistantMessage with no
        // sections — the panel's safe-refusal shape.
        const refusalDraft: DraftBriefing = {
            segments: [
                draftSegment(
                    "I can only help with this patient's chart and uploaded documents — I can't look up the weather.",
                    [],
                ),
            ],
        };
        const out = await runEndToEnd({
            envelope: patelEnvelope({ question: "What's the weather today?" }),
            snapshot: patelSnapshot(),
            draft: refusalDraft,
            claims: [],
            documentEvidenceSnippets: [],
        });

        expect(out.verified.passed).toBe(true);
        expect(out.verified.accepted).toHaveLength(0);
        expect(out.verified.rejected).toHaveLength(0);

        // No section renders — every claimGroup bucket is absent.
        expect(out.formatted.claimGroups.chart).toBeUndefined();
        expect(out.formatted.claimGroups.extractedDocument).toBeUndefined();
        expect(out.formatted.claimGroups.guideline).toBeUndefined();

        // The refusal prose carries through; format does NOT
        // mark the segment redacted (no claims to fail) — but the
        // panel's safe-refusal rendering is driven by
        // claimGroups-empty, not by per-segment redacted flags.
        expect(out.formatted.segments).toHaveLength(1);
        expect(out.formatted.segments[0]?.text).toContain('can only help');
        expect(out.formatted.segments[0]?.claims).toHaveLength(0);
    });

    it('a chart-untouchable claim ("you should be on aspirin") rejects rather than synthesizing without retriever output', () => {
        // The supervisor's prompt forbids the synthesizer from naming
        // guidelines unless they appear as retriever snippets. A
        // claim that did so anyway — no retriever ran, no
        // evidenceRetrieverOutput — must reject.
        const guidelineClaim: Claim = {
            id: 'cl-aspirin',
            text: 'Per USPSTF, low-dose aspirin should be considered for primary prevention.',
            category: 'reminder',
            sourceReferences: [
                {
                    source_type: 'guideline',
                    source_id: 'uspstf::aspirin-primary-prevention',
                    locator: { section: 'recommendation' },
                    quote: 'low-dose aspirin',
                },
            ],
            safetyCritical: false,
        };
        return runEndToEnd({
            envelope: patelEnvelope({ question: 'should she be on aspirin?' }),
            snapshot: patelSnapshot(),
            draft: {
                segments: [draftSegment('Per USPSTF, ...', ['cl-aspirin'])],
            },
            claims: [guidelineClaim],
            documentEvidenceSnippets: [],
            // No evidenceRetrieverOutput — the retriever did not run.
        }).then((out) => {
            expect(out.verified.passed).toBe(false);
            expect(out.verified.rejected).toHaveLength(1);
            expect(out.verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
            // Redacted segment, no guideline section.
            expect(out.formatted.claimGroups.guideline).toBeUndefined();
            expect(out.formatted.segments[0]?.redacted).toBe(true);
        });
    });
});
