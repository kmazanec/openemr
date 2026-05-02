import { createHash } from 'node:crypto';

import type { BriefingSnapshot, Claim, Gap, VerifiedLedger } from './types.js';
import type { Encounter, LabObservation, Prescription } from '../snapshot/types.js';

/**
 * §4.1 suggested-follow-up generator.
 *
 * Produces a small, grounded set of typed follow-up suggestions that the
 * panel renders as tap-to-run chips below an assistant briefing. Every
 * suggestion carries a *typed parameter set* (`SuggestedFollowUpParams`)
 * so the follow-up turn — which §4.2/§4.3/§4.4 add — does not have to
 * re-parse natural language. Until those phases land, the server bridges
 * a typed follow-up into a deterministic question string and routes it
 * through the existing free-text follow-up path.
 *
 * Grounding rule: a suggestion is only emitted when the claim it would
 * drill into actually appeared in the verified ledger. Zero qualifying
 * claims → empty array. The plan's "3-5" is a ceiling, not a floor —
 * generic filler would defeat the source-citation guarantee that is the
 * whole point of the verification gate.
 */

export type SuggestedFollowUpParams =
    | { readonly type: 'lab_trend'; readonly analyte: string }
    | { readonly type: 'prescription_change'; readonly prescriptionId: string }
    | { readonly type: 'external_care'; readonly lookbackDays: number };

export interface SuggestedFollowUp {
    readonly id: string;
    readonly displayText: string;
    readonly params: SuggestedFollowUpParams;
    readonly groundedInClaimIds: readonly string[];
}

const RECOGNIZED_ANALYTES = ['A1c', 'BP', 'LDL', 'eGFR'] as const;

const LAB_TREND_CAP = 3;
const PRESCRIPTION_CHANGE_CAP = 2;
const TOTAL_CAP = 5;
const PRESCRIPTION_RECENT_DAYS = 90;
const EXTERNAL_LOOKBACK_DAYS = 365;

const MS_PER_DAY = 86_400_000;

/**
 * Deterministic chip ID derived from `(conversationId, params)`.
 * Exported so the server's chip-ID validation can recompute the same
 * value from the incoming follow-up params and look it up against the
 * persisted suggestion set without a round-trip ID column.
 */
export const stableId = (
    conversationId: string,
    params: SuggestedFollowUpParams,
): string => {
    const hash = createHash('sha1');
    hash.update(JSON.stringify({ conversationId, params }));
    return hash.digest('hex').slice(0, 12);
};

const isGap = (value: readonly LabObservation[] | readonly Encounter[] | Gap): value is Gap =>
    !Array.isArray(value);

const findLabsArray = (snapshot: BriefingSnapshot): readonly LabObservation[] => {
    const labs = snapshot.labs;
    if (isGap(labs)) return [];
    return labs;
};

const findEncountersHaveExternal = (snapshot: BriefingSnapshot): boolean => {
    const encs = snapshot.encounters;
    if (isGap(encs)) return false;
    return encs.some((e) => e.source.system !== 'openemr');
};

const matchAnalyteForClaim = (
    claim: Claim,
    labs: readonly LabObservation[],
): string | null => {
    if (claim.category !== 'lab') return null;
    for (const ref of claim.sourceReferences) {
        const lab = labs.find(
            (l) =>
                l.source.recordType === ref.recordType &&
                l.source.recordId === ref.recordId,
        );
        if (lab === undefined) continue;
        const recognized = RECOGNIZED_ANALYTES.find(
            (a) => a.toLowerCase() === lab.analyte.toLowerCase(),
        );
        if (recognized !== undefined) {
            return lab.analyte;
        }
    }
    return null;
};

const findPrescriptionForClaim = (
    claim: Claim,
    prescriptions: readonly Prescription[],
): Prescription | null => {
    // `prescription_change` is the §4.3 UC3 category (deterministic
    // branch emits these); `prescription` is the §3 default-briefing
    // category. Both should generate the same "Why was X prescribed?"
    // chip when the backing record is recent — without this, a default
    // briefing whose synthesizer happens to emit a
    // `prescription_change`-flavored claim (or a future UC that does
    // so) would never see the chip.
    if (claim.category !== 'prescription' && claim.category !== 'prescription_change') return null;
    for (const ref of claim.sourceReferences) {
        const rx = prescriptions.find(
            (p) =>
                p.source.recordType === ref.recordType &&
                p.source.recordId === ref.recordId,
        );
        if (rx !== undefined) return rx;
    }
    return null;
};

const referenceDate = (snapshot: BriefingSnapshot): Date => {
    const apptStart = snapshot.appointment?.startAt;
    if (apptStart !== undefined) {
        const parsed = new Date(apptStart);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
};

const isRecentPrescription = (rx: Prescription, anchor: Date): boolean => {
    if (rx.startDate === null) return false;
    const start = new Date(rx.startDate);
    if (Number.isNaN(start.getTime())) return false;
    const diffDays = Math.abs(anchor.getTime() - start.getTime()) / MS_PER_DAY;
    return diffDays <= PRESCRIPTION_RECENT_DAYS;
};

const prescriptionKey = (rx: Prescription): string =>
    `${rx.source.recordType}:${rx.source.recordId}`;

/**
 * Inverse of {@link prescriptionKey}. Used by §4.3's
 * `prescriptionChangeBranch` to recover the prescription record id from
 * the typed follow-up params the §4.1 generator emitted, without
 * re-implementing the split inline in the branch.
 */
export const parsePrescriptionKey = (key: string): {
    readonly recordType: string;
    readonly recordId: string;
} | null => {
    // Split on the LAST `:` rather than the first so a recordId
    // containing `:` (e.g. URN-style external ids) round-trips cleanly
    // through the `${recordType}:${recordId}` shape that medicationKey
    // emits. Today's record types are all colon-free, so this is
    // pin-the-invariant rather than fix-a-live-bug.
    const idx = key.lastIndexOf(':');
    if (idx <= 0 || idx === key.length - 1) return null;
    return {
        recordType: key.slice(0, idx),
        recordId: key.slice(idx + 1),
    };
};

export const generateFollowUps = (
    conversationId: string,
    verified: VerifiedLedger,
    snapshot: BriefingSnapshot,
): readonly SuggestedFollowUp[] => {
    const accepted = verified.accepted;
    if (accepted.length === 0) return [];

    const out: SuggestedFollowUp[] = [];
    const labs = findLabsArray(snapshot);

    const seenAnalytes = new Set<string>();
    const labsBySuggestion = new Map<string, string[]>();
    for (const claim of accepted) {
        const analyte = matchAnalyteForClaim(claim, labs);
        if (analyte === null) continue;
        const key = analyte.toLowerCase();
        if (seenAnalytes.has(key)) {
            const existing = labsBySuggestion.get(key);
            if (existing !== undefined) existing.push(claim.id);
            continue;
        }
        if (seenAnalytes.size >= LAB_TREND_CAP) continue;
        seenAnalytes.add(key);
        labsBySuggestion.set(key, [claim.id]);
        const params: SuggestedFollowUpParams = { type: 'lab_trend', analyte };
        out.push({
            id: stableId(conversationId, params),
            displayText: `Trend ${analyte}`,
            params,
            groundedInClaimIds: labsBySuggestion.get(key) ?? [claim.id],
        });
    }

    const anchor = referenceDate(snapshot);
    const seenRxKeys = new Set<string>();
    let rxCount = 0;
    for (const claim of accepted) {
        if (rxCount >= PRESCRIPTION_CHANGE_CAP) break;
        const rx = findPrescriptionForClaim(claim, snapshot.prescriptions);
        if (rx === null) continue;
        if (!isRecentPrescription(rx, anchor)) continue;
        const key = prescriptionKey(rx);
        if (seenRxKeys.has(key)) continue;
        seenRxKeys.add(key);
        const params: SuggestedFollowUpParams = {
            type: 'prescription_change',
            prescriptionId: key,
        };
        out.push({
            id: stableId(conversationId, params),
            displayText: `Why was ${rx.name} prescribed?`,
            params,
            groundedInClaimIds: [claim.id],
        });
        rxCount++;
    }

    if (findEncountersHaveExternal(snapshot)) {
        const encounterClaims = accepted
            .filter((c) => c.category === 'encounter')
            .map((c) => c.id);
        if (encounterClaims.length > 0) {
            const params: SuggestedFollowUpParams = {
                type: 'external_care',
                lookbackDays: EXTERNAL_LOOKBACK_DAYS,
            };
            out.push({
                id: stableId(conversationId, params),
                displayText: 'What did the outside encounter say?',
                params,
                groundedInClaimIds: encounterClaims,
            });
        }
    }

    return out.slice(0, TOTAL_CAP);
};
