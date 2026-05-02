import { describe, expect, it } from 'vitest';

import { createBriefingGraph } from '../../../src/graph/index.js';
import type { BriefingSnapshot, Gap, RequestEnvelope } from '../../../src/graph/types.js';
import { verifyLedger } from '../../../src/verify/verifier.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildClient, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §4.4 UC4 — outside care. Three cases per IMPLEMENTATION_PLAN.md
 * §4.4. The §4.5 free-text bridge keeps routing the `external_care`
 * suggestion through the existing follow-up path until UC4 gets a
 * bespoke graph branch (deferred). These tests pin the contract that
 * data + verifier alone deliver:
 *
 *   1. Recent ED visit imported via CCDA — the §4.1 generator emits
 *      the `external_care` suggestion grounded in the ccda-importer
 *      encounter, and the verifier accepts a faithful claim citing
 *      that encounter.
 *   2. No external records — same fixture stripped of
 *      ccda-importer encounters; the suggestion is suppressed and a
 *      fabricated external claim rejects at the gate.
 *   3. Malformed CCDA — encounters fail-open as a Gap; the verifier
 *      rejects fabricated external claims (no record to resolve to)
 *      and the suggestion is suppressed because the generator treats
 *      a Gap as "no qualifying encounters".
 *
 * The synthesizer is a stub. We are not asserting prose — we are
 * asserting that the deterministic gate behaves correctly when the
 * upstream snapshot stream surfaces ccda-importer-tagged encounters
 * (the contract `ExternalEncounterAdapter` ships).
 */

const followUpEnvelope = (snapshot: { patient: { pid: number; uuid: string } }): RequestEnvelope => ({
    conversationId: `conv-fu-${snapshot.patient.uuid}`,
    requestId: `req-fu-${snapshot.patient.uuid}`,
    siteId: 'default',
    actor: { userId: 'eval-actor', fhirUser: 'https://emr/Practitioner/eval-actor' },
    patient: { pid: snapshot.patient.pid, uuid: snapshot.patient.uuid },
    task: 'follow_up',
    question: 'Summarize external care from the last 365 days.',
    followUp: { type: 'external_care', lookbackDays: 365 },
});

describe('UC4 outside care — recent ED visit imported via CCDA', () => {
    it('emits the external_care suggestion grounded in the ccda-importer encounter', async () => {
        // The regenerated `recent_ed_visit` fixture tags `enc-6006-ed`
        // with `source.system: 'ccda-importer'`. The §4.1 generator
        // gates the `external_care` suggestion on that exact field, so
        // this case asserts the path PHP → snapshot → graph → suggestion
        // stays intact.
        const snapshot = loadFixture('recent_ed_visit');
        const client = buildClient(snapshot);
        const { synth } = buildFaithfulSynth();
        const graph = createBriefingGraph({
            retrieve: { client, token: 'eval-token', siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });

        expect(out.verified?.passed).toBe(true);
        const suggestions = out.formatted?.suggestedFollowUps ?? [];
        const external = suggestions.filter((s) => s.params.type === 'external_care');
        expect(external).toHaveLength(1);
        expect(external[0]?.params).toEqual({ type: 'external_care', lookbackDays: 365 });
        expect(external[0]?.groundedInClaimIds.length).toBeGreaterThan(0);
    });

    it('verifier accepts a follow-up claim citing the external encounter by id', async () => {
        // Pins the verifier-resolves-external-IDs contract end-to-end:
        // a follow-up turn over the same fixture cites the
        // ccda-importer encounter and the gate accepts it.
        const snapshot = loadFixture('recent_ed_visit');
        const client = buildClient(snapshot);
        const { synth } = buildFaithfulSynth();
        const graph = createBriefingGraph({
            retrieve: { client, token: 'eval-token', siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: followUpEnvelope(snapshot) });

        expect(out.verified?.passed).toBe(true);
        const accepted = out.verified?.accepted ?? [];
        const externalEncounterClaim = accepted.find(
            (c) =>
                c.category === 'encounter' &&
                c.sourceReferences.some(
                    (r) => r.recordId === 'enc-6006-ed' && r.system === 'ccda-importer',
                ),
        );
        expect(externalEncounterClaim).toBeDefined();
    });
});

describe('UC4 outside care — patient with no external records', () => {
    it('does not emit the external_care suggestion when every encounter is native', async () => {
        // The `diabetic` fixture has only `system: 'openemr'` encounters
        // (one Office Visit). The §4.1 generator's `system !== 'openemr'`
        // gate evaluates false; the suggestion must not surface.
        const snapshot = loadFixture('diabetic');
        const client = buildClient(snapshot);
        const { synth } = buildFaithfulSynth();
        const graph = createBriefingGraph({
            retrieve: { client, token: 'eval-token', siteId: 'default' },
            synthesize: { synthesizer: synth },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });

        const out = await graph.invoke({ envelope: baseEnvelope(snapshot) });

        expect(out.verified?.passed).toBe(true);
        const suggestions = out.formatted?.suggestedFollowUps ?? [];
        expect(suggestions.find((s) => s.params.type === 'external_care')).toBeUndefined();
    });

    it('verifier rejects a fabricated external-care claim citing an id not in the snapshot', () => {
        // Defense in depth: even if a synthesizer fabricated an
        // `external_care` claim against a snapshot with no external
        // records, the verifier's REJECT_UNRESOLVED rule must catch it.
        const snapshot = loadFixture('diabetic');
        const verified = verifyLedger(snapshot, {
            claims: [
                {
                    id: 'cl-fabricated',
                    text: 'Outside ED visit on 2026-04-22 for chest pain',
                    category: 'encounter',
                    sourceReferences: [
                        {
                            system: 'ccda-importer',
                            recordType: 'Encounter',
                            recordId: 'ext-fabricated-7',
                            field: null,
                            recordedAt: null,
                        },
                    ],
                    safetyCritical: false,
                },
            ],
        });
        expect(verified.passed).toBe(false);
        expect(verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});

describe('UC4 outside care — malformed CCDA (encounters Gap)', () => {
    it('treats a Gap on encounters as "no qualifying encounters" without hard-stopping', () => {
        // Forward-compat: today Retrieve fails the whole graph if the
        // narrow encounter endpoint errors, so a Gap on `encounters`
        // never reaches the verifier in production. A future widening
        // (per Step 2 of the §4.4 plan) will let external-encounter
        // fetch failures degrade to a Gap so the briefing still
        // renders the native encounters. This test pins the gate's
        // contract for that future shape: a Gap on encounters must
        // not produce a hard-stop (encounters aren't safety-critical),
        // and must reject fabricated external-care claims.
        const base = loadFixture('recent_ed_visit');
        const malformed: BriefingSnapshot = {
            patient: base.patient,
            appointment: base.appointment,
            diagnoses: base.diagnoses,
            prescriptions: base.prescriptions,
            allergies: base.allergies,
            labs: base.labs,
            encounters: gap('ccda-import-malformed', 'CCDA payload could not be parsed'),
            labHistory: null,
            reminders: base.reminders,
        };
        const verified = verifyLedger(malformed, {
            claims: [
                {
                    id: 'cl-fabricated-ext',
                    text: 'External ED visit on 2026-04-22',
                    category: 'encounter',
                    sourceReferences: [
                        {
                            system: 'ccda-importer',
                            recordType: 'Encounter',
                            recordId: 'enc-6006-ed',
                            field: null,
                            recordedAt: null,
                        },
                    ],
                    safetyCritical: false,
                },
            ],
        });

        expect(verified.passed).toBe(false);
        expect(verified.safetyHardStops).toEqual([]);
        expect(verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });
});

const gap = (reason: string, message: string): Gap => ({ kind: 'gap', reason, message });
