import { createHash } from 'node:crypto';

import type { BriefingSnapshot, Claim, Gap, VerifiedLedger } from './types.js';
import type {
    Encounter,
    LabObservation,
    MedicationStatement,
    Prescription,
    Reminder,
} from '../snapshot/types.js';

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
    | { readonly type: 'external_care'; readonly lookbackDays: number }
    | { readonly type: 'reminder_detail'; readonly reminderId: string }
    | { readonly type: 'medication_statement_detail'; readonly listId: string };

export interface SuggestedFollowUp {
    readonly id: string;
    readonly displayText: string;
    readonly params: SuggestedFollowUpParams;
    readonly groundedInClaimIds: readonly string[];
}

const RECOGNIZED_ANALYTES = ['A1c', 'BP', 'LDL', 'eGFR'] as const;

const LAB_TREND_CAP = 3;
const PRESCRIPTION_CHANGE_CAP = 2;
const REMINDER_DETAIL_CAP = 2;
const MEDICATION_STATEMENT_DETAIL_CAP = 2;
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
    // W1 distinguished CCDA-imported encounters via `source.system ===
    // 'ccda-importer'`. W2 dropped the `system` field; the closest
    // proxy still in the snapshot is the encounter `type` ("Emergency"
    // for the §4.4 UC4 ED-visit archetype). C-phase work will
    // reintroduce a richer encounter origin marker.
    return encs.some((e) => e.type !== null && /emergency|\bed\b/i.test(e.type));
};

const matchAnalyteForClaim = (
    claim: Claim,
    labs: readonly LabObservation[],
): string | null => {
    if (claim.category !== 'lab') return null;
    for (const ref of claim.sourceReferences) {
        const lab = labs.find((l) => l.source.source_id === ref.source_id);
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
        const rx = prescriptions.find((p) => p.source.source_id === ref.source_id);
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

const isWithinRecentDays = (
    startDate: string | null,
    anchor: Date,
    windowDays: number,
): boolean => {
    if (startDate === null) return false;
    const start = new Date(startDate);
    if (Number.isNaN(start.getTime())) return false;
    const diffDays = Math.abs(anchor.getTime() - start.getTime()) / MS_PER_DAY;
    return diffDays <= windowDays;
};

const isRecentPrescription = (rx: Prescription, anchor: Date): boolean =>
    isWithinRecentDays(rx.startDate, anchor, PRESCRIPTION_RECENT_DAYS);

const isRecentMedicationStatement = (
    stmt: MedicationStatement,
    anchor: Date,
): boolean =>
    isWithinRecentDays(stmt.startDate, anchor, PRESCRIPTION_RECENT_DAYS);

const prescriptionKey = (rx: Prescription): string =>
    `${rx.source.locator.field ?? 'medication.name'}:${rx.source.source_id}`;

/**
 * Inverse of {@link prescriptionKey}. Used by §4.3's
 * `prescriptionChangeBranch` to recover the prescription record id from
 * the typed follow-up params the §4.1 generator emitted, without
 * re-implementing the split inline in the branch.
 */
export const parsePrescriptionKey = (key: string): {
    readonly locatorField: string;
    readonly sourceId: string;
} | null => {
    // Split on the LAST `:` rather than the first so a sourceId
    // containing `:` (e.g. URN-style external ids) round-trips cleanly
    // through the `${locator.field}:${source_id}` shape that
    // prescriptionKey emits. Today's locator fields are all colon-free,
    // so this is pin-the-invariant rather than fix-a-live-bug.
    const idx = key.lastIndexOf(':');
    if (idx <= 0 || idx === key.length - 1) return null;
    return {
        locatorField: key.slice(0, idx),
        sourceId: key.slice(idx + 1),
    };
};

/**
 * Same `recordType:recordId` shape as the prescription key — kept
 * separate to make the call sites self-documenting at the
 * suggestion-generator boundary.
 */
const reminderKey = (reminder: Reminder): string =>
    `${reminder.source.locator.field ?? 'task.description'}:${reminder.source.source_id}`;

/**
 * Inverse of {@link reminderKey}. Used by §4.6.5's `reminderBranch`
 * to recover the reminder record id from the typed follow-up params.
 */
export const parseReminderKey = (key: string): {
    readonly locatorField: string;
    readonly sourceId: string;
} | null => parsePrescriptionKey(key);

const findReminderForClaim = (
    claim: Claim,
    reminders: readonly Reminder[],
): Reminder | null => {
    if (claim.category !== 'reminder') return null;
    for (const ref of claim.sourceReferences) {
        const r = reminders.find((rem) => rem.source.source_id === ref.source_id);
        if (r !== undefined) return r;
    }
    return null;
};

const medicationStatementKey = (stmt: MedicationStatement): string =>
    `${stmt.source.locator.field ?? 'medicationStatement.medication'}:${stmt.source.source_id}`;

/**
 * Inverse of {@link medicationStatementKey}. Used by §4.6.6's
 * `medicationStatementBranch` to recover the list record id from
 * the typed follow-up params.
 */
export const parseMedicationStatementKey = (key: string): {
    readonly locatorField: string;
    readonly sourceId: string;
} | null => parsePrescriptionKey(key);

const findMedicationStatementForClaim = (
    claim: Claim,
    statements: readonly MedicationStatement[],
): MedicationStatement | null => {
    if (claim.category !== 'medication_statement') return null;
    for (const ref of claim.sourceReferences) {
        const s = statements.find((stmt) => stmt.source.source_id === ref.source_id);
        if (s !== undefined) return s;
    }
    return null;
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

    const remindersIn = snapshot.reminders;
    const reminders: readonly Reminder[] = 'kind' in remindersIn ? [] : remindersIn;
    const seenReminderKeys = new Set<string>();
    let reminderCount = 0;
    for (const claim of accepted) {
        if (reminderCount >= REMINDER_DETAIL_CAP) break;
        const reminder = findReminderForClaim(claim, reminders);
        if (reminder === null) continue;
        // Only the actionable subset gets a drill-down — "due" items
        // are informational; "overdue" is what a clinician should
        // address this visit.
        if (reminder.dueStatus.toLowerCase() !== 'overdue') continue;
        const key = reminderKey(reminder);
        if (seenReminderKeys.has(key)) continue;
        seenReminderKeys.add(key);
        const params: SuggestedFollowUpParams = {
            type: 'reminder_detail',
            reminderId: key,
        };
        out.push({
            id: stableId(conversationId, params),
            displayText: `When is ${reminder.itemTitle} due?`,
            params,
            groundedInClaimIds: [claim.id],
        });
        reminderCount++;
    }

    const statementsIn = snapshot.medications;
    const statements: readonly MedicationStatement[] =
        'kind' in statementsIn ? [] : statementsIn;
    const seenStatementKeys = new Set<string>();
    let stmtCount = 0;
    for (const claim of accepted) {
        if (stmtCount >= MEDICATION_STATEMENT_DETAIL_CAP) break;
        const stmt = findMedicationStatementForClaim(claim, statements);
        if (stmt === null) continue;
        // Surface a chip when there's something a clinician would
        // want to drill into: a recently-started entry OR one that
        // names its information source ("family reports..."). Pure
        // "patient said" entries with old start dates and no extra
        // context don't usually need a chip — the briefing line is
        // enough.
        const isRecent = isRecentMedicationStatement(stmt, anchor);
        const hasInformationSource = stmt.informationSource !== null;
        if (!isRecent && !hasInformationSource) continue;
        const key = medicationStatementKey(stmt);
        if (seenStatementKeys.has(key)) continue;
        seenStatementKeys.add(key);
        const params: SuggestedFollowUpParams = {
            type: 'medication_statement_detail',
            listId: key,
        };
        out.push({
            id: stableId(conversationId, params),
            displayText: `What did the patient say about ${stmt.name}?`,
            params,
            groundedInClaimIds: [claim.id],
        });
        stmtCount++;
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
