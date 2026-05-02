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
    readonly source: SourceReference;
}

export interface Diagnosis {
    readonly code: string;
    readonly codeSystem: string;
    readonly label: string;
    readonly onsetDate: string | null;
    readonly source: SourceReference;
}

export interface Medication {
    readonly name: string;
    readonly dose: string | null;
    readonly route: string | null;
    readonly frequency: string | null;
    readonly startDate: string | null;
    readonly stopDate: string | null;
    readonly prescriber: string | null;
    readonly indication: string | null;
    /**
     * Same value the SourceReference carries as `recordId`, surfaced here
     * for ergonomics so §4.3's medication-change branch can address a
     * prescription by id without spelunking through the citation. Held
     * as a string on this side because every other id in this snapshot
     * shape is a string; the wire format ships it as a JSON number.
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
    readonly medications: readonly Medication[];
    readonly allergies: readonly Allergy[];
    readonly labs: readonly LabObservation[];
    readonly encounters: readonly Encounter[];
}
