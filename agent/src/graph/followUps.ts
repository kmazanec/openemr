import type { BriefingSnapshot, Claim, Gap, VerifiedLedger } from './types.js';
import type {
    Encounter,
    LabObservation,
    MedicationStatement,
    Prescription,
    Reminder,
} from '../snapshot/types.js';

/**
 * Suggested-follow-up generator.
 *
 * Produces a small, grounded set of follow-up suggestions the panel
 * renders as tap-to-run chips below an assistant briefing. Each chip
 * carries a free-text `displayText` and the claim ids that grounded
 * its emission. Tapping a chip posts that `displayText` as a normal
 * `task: 'follow_up'` envelope `question` — the supervisor reads it
 * exactly as if the clinician had typed it.
 *
 * Grounding rule: a suggestion is only emitted when the claim it
 * drills into actually appeared in the verified ledger. Zero
 * qualifying claims → empty array. The "3-5" target is a ceiling, not
 * a floor — generic filler would defeat the source-citation guarantee
 * that is the whole point of the verification gate.
 */

export interface SuggestedFollowUp {
    readonly displayText: string;
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

export const MS_PER_DAY = 86_400_000;

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
    if (claim.category !== 'prescription') return null;
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
        out.push({
            displayText: `How is ${analyte} trending?`,
            groundedInClaimIds: labsBySuggestion.get(key) ?? [claim.id],
        });
    }

    const anchor = referenceDate(snapshot);
    const seenRxNames = new Set<string>();
    let rxCount = 0;
    for (const claim of accepted) {
        if (rxCount >= PRESCRIPTION_CHANGE_CAP) break;
        const rx = findPrescriptionForClaim(claim, snapshot.prescriptions);
        if (rx === null) continue;
        if (!isRecentPrescription(rx, anchor)) continue;
        if (seenRxNames.has(rx.name.toLowerCase())) continue;
        seenRxNames.add(rx.name.toLowerCase());
        out.push({
            displayText: `Why was ${rx.name} prescribed?`,
            groundedInClaimIds: [claim.id],
        });
        rxCount++;
    }

    const remindersIn = snapshot.reminders;
    const reminders: readonly Reminder[] = 'kind' in remindersIn ? [] : remindersIn;
    const seenReminderTitles = new Set<string>();
    let reminderCount = 0;
    for (const claim of accepted) {
        if (reminderCount >= REMINDER_DETAIL_CAP) break;
        const reminder = findReminderForClaim(claim, reminders);
        if (reminder === null) continue;
        // Only the actionable subset gets a drill-down — "due" items
        // are informational; "overdue" is what a clinician should
        // address this visit.
        if (reminder.dueStatus.toLowerCase() !== 'overdue') continue;
        if (seenReminderTitles.has(reminder.itemTitle.toLowerCase())) continue;
        seenReminderTitles.add(reminder.itemTitle.toLowerCase());
        out.push({
            displayText: `When is ${reminder.itemTitle} due?`,
            groundedInClaimIds: [claim.id],
        });
        reminderCount++;
    }

    const statementsIn = snapshot.medications;
    const statements: readonly MedicationStatement[] =
        'kind' in statementsIn ? [] : statementsIn;
    const seenStatementNames = new Set<string>();
    let stmtCount = 0;
    for (const claim of accepted) {
        if (stmtCount >= MEDICATION_STATEMENT_DETAIL_CAP) break;
        const stmt = findMedicationStatementForClaim(claim, statements);
        if (stmt === null) continue;
        const isRecent = isRecentMedicationStatement(stmt, anchor);
        const hasInformationSource = stmt.informationSource !== null;
        if (!isRecent && !hasInformationSource) continue;
        if (seenStatementNames.has(stmt.name.toLowerCase())) continue;
        seenStatementNames.add(stmt.name.toLowerCase());
        out.push({
            displayText: `What did the patient say about ${stmt.name}?`,
            groundedInClaimIds: [claim.id],
        });
        stmtCount++;
    }

    if (findEncountersHaveExternal(snapshot)) {
        const encounterClaims = accepted
            .filter((c) => c.category === 'encounter')
            .map((c) => c.id);
        if (encounterClaims.length > 0) {
            out.push({
                displayText: `What did the outside encounter say in the last ${EXTERNAL_LOOKBACK_DAYS} days?`,
                groundedInClaimIds: encounterClaims,
            });
        }
    }

    return out.slice(0, TOTAL_CAP);
};
