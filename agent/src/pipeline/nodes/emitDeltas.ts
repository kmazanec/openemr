/**
 * §B.7 Pipeline node 6 — `emitDeltas`.
 *
 * Diff the extracted facts against the patient's current chart and
 * record the structured difference as `deltas_json` on the artifact.
 * The downstream UI surfaces the delta as "needs-confirmation" chips
 * (per `WEEK2-PRESEARCH.md` §Q2b) so the clinician can accept/reject
 * each fact individually before it lands in chart records (Tier-3
 * promotion, Phase F).
 *
 * The deltas are intentionally **detection-only** here: this node does
 * not write to chart tables. It only annotates the Tier-2 row with
 * what's new vs. what's already on the chart.
 *
 * Lab PDFs do not produce `new_*` clinical facts in this node — a lab
 * result is not a chart fact until promotion creates a FHIR
 * `Observation`, and that is Phase F's responsibility. Lab artifacts
 * therefore emit empty `new_*` arrays; their delta is the cited values
 * themselves, which the UI surfaces directly from `schema_json`.
 *
 * Intake forms, by contrast, *do* produce clinical-fact deltas at this
 * stage: allergies, current medications, and past medical history each
 * map to candidate `lists` entries the clinician will accept/reject.
 * Demographics deltas (address, phone, email) are surfaced through the
 * same mechanism but never auto-promoted (Tier-3 acceptance gate
 * applies to demographics too — `W2_ARCHITECTURE.md` §emitDeltas).
 */

import type { Logger } from 'pino';

import type { ChartSnapshot } from '../../snapshot/types.js';
import {
    type ExtractionArtifact,
    type ExtractionArtifactStore,
} from '../../state/extractionArtifacts.js';
import { type PipelineError, type PipelineState } from '../state.js';

export interface EmitDeltasDeps {
    readonly artifactStore: ExtractionArtifactStore;
    readonly logger: Logger;
    /** Boundary for fetching the chart snapshot needed for the diff. */
    readonly fetchChartSnapshot: (pid: number) => Promise<ChartSnapshot>;
}

/**
 * Persisted shape of the deltas JSON. Symmetric across doc types so
 * the UI renderer can dispatch on a single shape; doc-types simply
 * leave categories they don't speak to as empty arrays.
 *
 * Each delta entry carries the field path within the extraction
 * schema_json so the UI can render the bbox + quote citation on the
 * "Document attached" inline view.
 */
export interface ExtractedFactsDelta {
    readonly newAllergies: readonly NewAllergyDelta[];
    readonly newDiagnoses: readonly NewDiagnosisDelta[];
    readonly newMedications: readonly NewMedicationDelta[];
    readonly demographicsChanges: readonly DemographicsChangeDelta[];
}

export interface NewAllergyDelta {
    readonly fieldPath: string;
    readonly substance: string;
}

export interface NewDiagnosisDelta {
    readonly fieldPath: string;
    readonly condition: string;
}

export interface NewMedicationDelta {
    readonly fieldPath: string;
    readonly name: string;
}

export interface DemographicsChangeDelta {
    readonly fieldPath: string;
    /** `'address' | 'phone' | 'email'` — closed enum so the UI dispatch is exhaustive. */
    readonly field: 'address' | 'phone' | 'email';
    readonly extractedValue: string;
}

const fail = (state: PipelineState, error: PipelineError): Partial<PipelineState> => ({
    status: 'failed',
    errors: [...state.errors, error],
});

const emptyDelta: ExtractedFactsDelta = {
    newAllergies: [],
    newDiagnoses: [],
    newMedications: [],
    demographicsChanges: [],
};

const normalizeForCompare = (s: string): string =>
    s
        .normalize('NFKD')
        .toLowerCase()
        // collapse all whitespace + punctuation; the chart's
        // free-text storage and the extracted free text are not
        // guaranteed to share spacing or capitalization.
        .replace(/[\s.,/\\\-_'"]+/gu, ' ')
        .trim();

/**
 * Pull the `value` out of a cited field — vision returns
 * `{value, page, bbox, quote, confidence}` for cited demographics; this
 * helper looks past the envelope so the caller never has to reach into
 * the cited shape.
 */
const citedString = (
    schema: unknown,
    objectKey: 'patient_demographics',
    fieldKey: string,
): string | null => {
    if (schema === null || typeof schema !== 'object') return null;
    const root = schema as Record<string, unknown>;
    const obj = root[objectKey];
    if (obj === null || typeof obj !== 'object') return null;
    const cited = (obj as Record<string, unknown>)[fieldKey];
    if (cited === null || typeof cited !== 'object') return null;
    const value = (cited as Record<string, unknown>)['value'];
    return typeof value === 'string' ? value : null;
};

const arrayField = (schema: unknown, key: string): readonly Record<string, unknown>[] => {
    if (schema === null || typeof schema !== 'object') return [];
    const root = schema as Record<string, unknown>;
    const arr = root[key];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
        (entry): entry is Record<string, unknown> =>
            entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    );
};

/**
 * Compute the lab-PDF delta. Per the architecture, lab PDFs don't
 * produce chart-fact deltas at the emitDeltas stage — Tier-3
 * promotion is what creates `Observation` rows. The UI surfaces
 * extracted lab values directly from `schema_json` and chips them
 * with the `extracted_document` citation type.
 *
 * We still emit demographics deltas if the lab header contradicts the
 * chart (off-by-letter name capitalization is filtered by
 * `normalizeForCompare`; an actual address mismatch surfaces).
 */
const labPdfDeltas = (schema: unknown): ExtractedFactsDelta => ({
    ...emptyDelta,
    demographicsChanges: demographicsDeltas(schema),
});

/**
 * Compute the intake-form delta. New allergies, new medications, new
 * past-medical-history items, and any demographics changes the form
 * surfaces.
 */
const intakeFormDeltas = (
    schema: unknown,
    chart: ChartSnapshot,
): ExtractedFactsDelta => {
    return {
        newAllergies: newAllergies(schema, chart),
        newDiagnoses: newDiagnoses(schema, chart),
        newMedications: newMedications(schema, chart),
        demographicsChanges: demographicsDeltas(schema),
    };
};

const newAllergies = (schema: unknown, chart: ChartSnapshot): readonly NewAllergyDelta[] => {
    const known = new Set(
        chart.allergies.map((a) => normalizeForCompare(a.substance)).filter((s) => s.length > 0),
    );
    const out: NewAllergyDelta[] = [];
    arrayField(schema, 'allergies').forEach((entry, index) => {
        const substance = entry['substance'];
        if (typeof substance !== 'string' || substance.length === 0) return;
        if (known.has(normalizeForCompare(substance))) return;
        out.push({
            fieldPath: `allergies[${String(index)}]`,
            substance,
        });
    });
    return out;
};

const newMedications = (schema: unknown, chart: ChartSnapshot): readonly NewMedicationDelta[] => {
    // Compare against both prescriptions (clinic-written) and
    // medication statements (patient-reported). The intake form is
    // patient-reported, so the medication-statement list is the
    // closer match; checking both keeps a freshly-prescribed but
    // not-yet-stated item from showing up as "new".
    const known = new Set<string>();
    chart.medications.forEach((m) => {
        const k = normalizeForCompare(m.name);
        if (k.length > 0) known.add(k);
    });
    chart.prescriptions.forEach((p) => {
        const k = normalizeForCompare(p.name);
        if (k.length > 0) known.add(k);
    });

    const out: NewMedicationDelta[] = [];
    arrayField(schema, 'current_medications').forEach((entry, index) => {
        const name = entry['name'];
        if (typeof name !== 'string' || name.length === 0) return;
        if (known.has(normalizeForCompare(name))) return;
        out.push({
            fieldPath: `current_medications[${String(index)}]`,
            name,
        });
    });
    return out;
};

const newDiagnoses = (schema: unknown, chart: ChartSnapshot): readonly NewDiagnosisDelta[] => {
    const known = new Set(
        chart.diagnoses.map((d) => normalizeForCompare(d.label)).filter((s) => s.length > 0),
    );
    const out: NewDiagnosisDelta[] = [];
    arrayField(schema, 'past_medical_history').forEach((entry, index) => {
        const condition = entry['condition'];
        if (typeof condition !== 'string' || condition.length === 0) return;
        if (known.has(normalizeForCompare(condition))) return;
        out.push({
            fieldPath: `past_medical_history[${String(index)}]`,
            condition,
        });
    });
    return out;
};

// The chart's `Demographics` exposes only `displayName, sex, dob`
// today — address/phone/email aren't on the snapshot surface so we
// have no chart-side baseline to diff against. Per W2's
// emitDeltas architecture, every extracted address/phone/email
// surfaces as a "needs confirmation" delta; a future chart-side
// address surface will tighten the comparison.
const demographicsDeltas = (
    schema: unknown,
): readonly DemographicsChangeDelta[] => {
    const out: DemographicsChangeDelta[] = [];
    (['address', 'phone', 'email'] as const).forEach((field) => {
        const value = citedString(schema, 'patient_demographics', field);
        if (value === null) return;
        out.push({
            fieldPath: `patient_demographics.${field}`,
            field,
            extractedValue: value,
        });
    });
    return out;
};

const dispatchDeltas = (
    docType: 'lab_pdf' | 'intake_form',
    schema: unknown,
    chart: ChartSnapshot,
): ExtractedFactsDelta =>
    docType === 'lab_pdf' ? labPdfDeltas(schema) : intakeFormDeltas(schema, chart);

export const emitDeltas = async (
    state: PipelineState,
    deps: EmitDeltasDeps,
): Promise<Partial<PipelineState>> => {
    if (state.status === 'failed') return {};

    if (state.artifactId === null) {
        // The persist node should have set artifactId on success; if it
        // didn't, the persist path failed silently — refuse to compute
        // deltas against an unrooted artifact.
        deps.logger.error(
            { documentUuid: state.documentUuid, pid: state.pid },
            'emitDeltas: artifactId is null but status is not failed',
        );
        return fail(state, {
            code: 'persist_failed',
            message: 'emitDeltas: artifactId missing on persist',
        });
    }

    let chart: ChartSnapshot;
    try {
        chart = await deps.fetchChartSnapshot(state.pid);
    } catch (err) {
        deps.logger.error(
            { documentUuid: state.documentUuid, pid: state.pid, err: String(err) },
            'emitDeltas: failed to fetch chart snapshot',
        );
        // Failing to fetch chart state is *not* a pipeline failure —
        // the artifact is already persisted and the deltas are a
        // detection signal for the UI, not a correctness gate. Log
        // and store an empty delta. The UI degrades to "no chart
        // comparison available."
        await persistDelta(deps, state.artifactId, emptyDelta);
        return { status: 'persisted' };
    }

    const delta = dispatchDeltas(state.docType, state.schema, chart);

    let updated: ExtractionArtifact | null;
    try {
        updated = await persistDelta(deps, state.artifactId, delta);
    } catch (err) {
        deps.logger.error(
            { artifactId: state.artifactId, err: String(err) },
            'emitDeltas: failed to write deltas_json',
        );
        // Same posture as the snapshot fetch failure — log and
        // continue. The artifact is persisted; missing deltas degrade
        // the UI but don't poison chart state.
        return { status: 'persisted' };
    }

    deps.logger.info(
        {
            artifactId: state.artifactId,
            docType: state.docType,
            newAllergies: delta.newAllergies.length,
            newDiagnoses: delta.newDiagnoses.length,
            newMedications: delta.newMedications.length,
            demographicsChanges: delta.demographicsChanges.length,
            updatedSucceeded: updated !== null,
        },
        'emitDeltas: deltas_json written',
    );

    return { status: 'persisted' };
};

const persistDelta = async (
    deps: EmitDeltasDeps,
    artifactId: string,
    delta: ExtractedFactsDelta,
): Promise<ExtractionArtifact | null> =>
    deps.artifactStore.updateArtifactStatus(artifactId, 'pending_confirmation', {
        deltasJson: delta,
    });
