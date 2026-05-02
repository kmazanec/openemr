import { createHash } from 'node:crypto';

import type { BriefingSnapshot, Claim, Gap, VerifiedLedger } from './types.js';
import type { Encounter, LabObservation, Medication } from '../snapshot/types.js';

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
    | { readonly type: 'medication_change'; readonly medicationId: string }
    | { readonly type: 'external_care'; readonly lookbackDays: number };

export interface SuggestedFollowUp {
    readonly id: string;
    readonly displayText: string;
    readonly params: SuggestedFollowUpParams;
    readonly groundedInClaimIds: readonly string[];
}

const RECOGNIZED_ANALYTES = ['A1c', 'BP', 'LDL', 'eGFR'] as const;

const LAB_TREND_CAP = 3;
const MEDICATION_CHANGE_CAP = 2;
const TOTAL_CAP = 5;
const MEDICATION_RECENT_DAYS = 90;
const EXTERNAL_LOOKBACK_DAYS = 365;

const MS_PER_DAY = 86_400_000;

const stableId = (conversationId: string, params: SuggestedFollowUpParams): string => {
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

const findMedicationForClaim = (
    claim: Claim,
    medications: readonly Medication[],
): Medication | null => {
    if (claim.category !== 'medication') return null;
    for (const ref of claim.sourceReferences) {
        const med = medications.find(
            (m) =>
                m.source.recordType === ref.recordType &&
                m.source.recordId === ref.recordId,
        );
        if (med !== undefined) return med;
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

const isRecentMedication = (med: Medication, anchor: Date): boolean => {
    if (med.startDate === null) return false;
    const start = new Date(med.startDate);
    if (Number.isNaN(start.getTime())) return false;
    const diffDays = Math.abs(anchor.getTime() - start.getTime()) / MS_PER_DAY;
    return diffDays <= MEDICATION_RECENT_DAYS;
};

const medicationKey = (med: Medication): string =>
    `${med.source.recordType}:${med.source.recordId}`;

/**
 * Inverse of {@link medicationKey}. Used by §4.3's medChangeBranch to
 * recover the prescription record id from the typed follow-up params
 * the §4.1 generator emitted, without re-implementing the split inline
 * in the branch.
 */
export const parseMedicationKey = (key: string): {
    readonly recordType: string;
    readonly recordId: string;
} | null => {
    const idx = key.indexOf(':');
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
    const seenMedKeys = new Set<string>();
    let medCount = 0;
    for (const claim of accepted) {
        if (medCount >= MEDICATION_CHANGE_CAP) break;
        const med = findMedicationForClaim(claim, snapshot.medications);
        if (med === null) continue;
        if (!isRecentMedication(med, anchor)) continue;
        const key = medicationKey(med);
        if (seenMedKeys.has(key)) continue;
        seenMedKeys.add(key);
        const params: SuggestedFollowUpParams = {
            type: 'medication_change',
            medicationId: key,
        };
        out.push({
            id: stableId(conversationId, params),
            displayText: `Why was ${med.name} started?`,
            params,
            groundedInClaimIds: [claim.id],
        });
        medCount++;
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
