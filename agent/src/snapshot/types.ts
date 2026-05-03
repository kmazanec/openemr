/**
 * TypeScript mirror of the @phpstan-typed ChartSnapshot shape produced by
 * the OpenEMR-side PHP DTOs in
 * `interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/`.
 *
 * If the PHP `toArray()` shape drifts from this file, the cross-language
 * fixture test (plan §A.5) catches it. Always update both sides together.
 */

export interface SourceReference {
    readonly system: string;
    readonly recordType: string;
    readonly recordId: string;
    readonly field: string | null;
    readonly recordedAt: string | null;
}

export interface Demographics {
    readonly pid: number;
    readonly uuid: string;
    readonly displayName: string;
    readonly sex: string | null;
    readonly dateOfBirth: string | null;
    /**
     * Whole years between `dateOfBirth` and the snapshot time, computed
     * by the PHP-side adapter. Carried alongside DOB so the model does
     * not have to do birthday-vs-year arithmetic itself — that math
     * was a recurring off-by-one source. Null iff DOB is null.
     */
    readonly ageYears: number | null;
    readonly source: SourceReference;
}

export interface Diagnosis {
    readonly code: string;
    readonly codeSystem: string;
    readonly label: string;
    readonly onsetDate: string | null;
    readonly source: SourceReference;
}

/**
 * Clinic-written prescription line (FHIR `MedicationRequest`).
 *
 * Sourced from OpenEMR's `prescriptions` table — what *this clinic*
 * has prescribed. Phase 4.6.4 will introduce a sibling
 * `MedicationStatement` interface for patient-reported / OTC entries
 * (FHIR `MedicationStatement`) backed by `lists` + `lists_medication`.
 *
 * The default snapshot includes both active rows AND inactive rows
 * modified within the lookback window so the briefing can flag recent
 * discontinuations. `stopDate` is non-null only for inactive rows.
 */
export interface Prescription {
    readonly name: string;
    readonly dose: string | null;
    readonly route: string | null;
    readonly frequency: string | null;
    readonly startDate: string | null;
    readonly stopDate: string | null;
    readonly prescriber: string | null;
    readonly indication: string | null;
    /**
     * Same value the SourceReference carries as `recordId`, surfaced
     * here for ergonomics so §4.3's prescription-change branch can
     * address a prescription by id without spelunking through the
     * citation. Held as a string on this side because every other id in
     * this snapshot shape is a string; the wire format ships it as a
     * JSON number.
     */
    readonly prescriptionId: string | null;
    readonly source: SourceReference;
}

export interface Allergy {
    readonly substance: string;
    readonly reaction: string | null;
    readonly severity: string | null;
    readonly source: SourceReference;
}

export interface LabObservation {
    readonly analyte: string;
    /**
     * Preserved as a string so text qualifiers (`<0.01`, `>500`, `positive`)
     * survive normalization — the verifier compares the displayed claim
     * against this exact value, and coercion would lose information.
     * Pinned by `decode.test.ts`.
     */
    readonly value: string;
    readonly unit: string | null;
    readonly referenceRange: string | null;
    readonly abnormalFlag: string | null;
    readonly observedAt: string | null;
    readonly source: SourceReference;
}

export interface Encounter {
    readonly encounterDate: string | null;
    readonly type: string | null;
    readonly reason: string | null;
    readonly source: SourceReference;
}

/**
 * Patient-reported medication line — what the patient says they're
 * actually taking (FHIR `MedicationStatement`). Includes OTC,
 * supplements, and prescriptions written by other clinics.
 *
 * Sourced from OpenEMR's `lists` table joined to `lists_medication`
 * (`is_primary_record=0`). Distinct from {@link Prescription} (clinic
 * Rx); the two surfaces ride side-by-side so the briefing can
 * mention both:
 *
 *   - Prescriptions: "What this clinic has written"
 *   - Medications:  "What the patient says they're taking"
 *
 * Verifier rule for `medication_statement` claims is intentionally
 * looser than the prescription rule — statement rows often lack
 * structure (no formal prescriber, no clinic-side indication) so the
 * rule asks only that the claim text contain the medication name.
 */
export interface MedicationStatement {
    readonly name: string;
    readonly dose: string | null;
    readonly usageCategory: string | null;
    readonly informationSource: string | null;
    readonly startDate: string | null;
    readonly stopDate: string | null;
    /**
     * Same value the SourceReference carries as `recordId`, surfaced
     * here as a top-level string so §4.6.6's medication-statement
     * detail branch can address one row by id. The wire format ships
     * it as a JSON number; held as a string on this side to match
     * every other id in the snapshot.
     */
    readonly listId: string | null;
    readonly source: SourceReference;
}

/**
 * Clinical reminder — overdue or due health-maintenance items
 * (FHIR `Task`).
 *
 * Sourced from OpenEMR's `patient_reminders` table joined to
 * `list_options` for human-readable category and due-status titles.
 * The adapter caps to 5 rows and filters out `not_due_yet` so the
 * briefing surface stays focused on what the clinician should act
 * on this visit.
 */
export interface Reminder {
    readonly item: string;
    readonly itemTitle: string;
    readonly category: string;
    readonly categoryTitle: string;
    /**
     * `'due'` | `'overdue'` (case-insensitive). The verifier rule
     * requires the claim text to contain this token, so a claim can't
     * say "due" against an overdue reminder.
     */
    readonly dueStatus: string;
    readonly createdAt: string | null;
    /**
     * Same value the SourceReference carries as `recordId`, surfaced
     * here as a top-level string so §4.6.5's reminder-detail branch
     * can address a single reminder without spelunking through the
     * citation. The wire format ships it as a JSON number; held as a
     * string on this side to match every other id in the snapshot.
     */
    readonly reminderId: string | null;
    readonly source: SourceReference;
}

export interface Appointment {
    readonly appointmentId: string;
    readonly startAt: string;
    readonly durationMinutes: number;
    readonly type: string | null;
    readonly reason: string | null;
    readonly source: SourceReference;
}

export interface ChartSnapshot {
    readonly patient: Demographics;
    readonly appointment: Appointment | null;
    readonly diagnoses: readonly Diagnosis[];
    readonly prescriptions: readonly Prescription[];
    readonly allergies: readonly Allergy[];
    readonly labs: readonly LabObservation[];
    readonly encounters: readonly Encounter[];
    readonly reminders: readonly Reminder[];
    readonly medications: readonly MedicationStatement[];
}
