import { ChartSnapshotDecodeError } from '../snapshot/decode.js';
import type {
    Allergy,
    Demographics,
    Diagnosis,
    Encounter,
    LabObservation,
    Medication,
} from '../snapshot/types.js';

/**
 * Provenance for a single prescription returned by the §4.3
 * `medication_provenance.php` endpoint. Mirrors the PHP-side
 * `MedicationProvenance::toArray()` shape.
 *
 * `doseAdjustments` carries the current single dose only — OpenEMR's
 * `prescriptions` table has no historical dose-change column, and
 * `date_modified` moves on any edit. Tools and graph branches consuming
 * this shape must not infer a dose history; the verifier rule enforces
 * that constraint at the claim layer.
 */
export interface MedicationProvenance {
    readonly prescriptionId: string;
    readonly drugName: string;
    readonly prescriber: string | null;
    readonly prescribingDate: string | null;
    readonly indication: string | null;
    readonly doseAdjustments: readonly {
        readonly dose: string | null;
        readonly date: string | null;
    }[];
}

/**
 * JSON-shape decoders for the four narrow agent endpoints. Each
 * narrow endpoint returns a slim JSON envelope with only its own
 * data; these helpers walk that envelope into the same typed DTOs
 * that the full ChartSnapshot uses. The element decoders themselves
 * live in `snapshot/decode.ts` because the briefing path exercises
 * the same shapes — we don't want two ways to decode a Medication.
 */

import {
    decodeAllergyForNarrow,
    decodeDemographicsForNarrow,
    decodeDiagnosisForNarrow,
    decodeEncounterForNarrow,
    decodeLabForNarrow,
    decodeMedicationForNarrow,
} from '../snapshot/decode.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const expectObject = (path: string, v: unknown): Record<string, unknown> => {
    if (!isObject(v)) {
        throw new ChartSnapshotDecodeError(path, 'expected an object');
    }
    return v;
};

const expectArray = (path: string, v: unknown): unknown[] => {
    if (!Array.isArray(v)) {
        throw new ChartSnapshotDecodeError(path, 'expected an array');
    }
    return v;
};

const requireKey = (path: string, obj: Record<string, unknown>, key: string): unknown => {
    if (!(key in obj)) {
        throw new ChartSnapshotDecodeError(`${path}.${key}`, `${key} is required`);
    }
    return obj[key];
};

export const decodeMedicationsResponse = (raw: unknown): readonly Medication[] => {
    const obj = expectObject('medicationsResponse', raw);
    const arr = expectArray('medicationsResponse.medications', requireKey('medicationsResponse', obj, 'medications'));
    return arr.map((item, idx) =>
        decodeMedicationForNarrow(`medicationsResponse.medications[${String(idx)}]`, item),
    );
};

export const decodeLabsResponse = (raw: unknown): readonly LabObservation[] => {
    const obj = expectObject('labsResponse', raw);
    const arr = expectArray('labsResponse.labs', requireKey('labsResponse', obj, 'labs'));
    return arr.map((item, idx) => decodeLabForNarrow(`labsResponse.labs[${String(idx)}]`, item));
};

export const decodeEncountersResponse = (raw: unknown): readonly Encounter[] => {
    const obj = expectObject('encountersResponse', raw);
    const arr = expectArray(
        'encountersResponse.encounters',
        requireKey('encountersResponse', obj, 'encounters'),
    );
    return arr.map((item, idx) =>
        decodeEncounterForNarrow(`encountersResponse.encounters[${String(idx)}]`, item),
    );
};

export interface PatientContextResponse {
    readonly patient: Demographics;
    readonly diagnoses: readonly Diagnosis[];
    readonly allergies: readonly Allergy[];
}

const expectString = (path: string, v: unknown): string => {
    if (typeof v !== 'string') {
        throw new ChartSnapshotDecodeError(path, 'expected a string');
    }
    return v;
};

const optionalString = (path: string, v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') {
        throw new ChartSnapshotDecodeError(path, 'expected a string or null');
    }
    return v;
};

const expectIntAsString = (path: string, v: unknown): string => {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new ChartSnapshotDecodeError(path, 'expected an integer');
    }
    return String(v);
};

export const decodeMedicationProvenanceResponse = (raw: unknown): MedicationProvenance => {
    const obj = expectObject('medicationProvenanceResponse', raw);
    const prov = expectObject(
        'medicationProvenanceResponse.provenance',
        requireKey('medicationProvenanceResponse', obj, 'provenance'),
    );
    const adjustmentsRaw = expectArray(
        'medicationProvenanceResponse.provenance.doseAdjustments',
        requireKey('medicationProvenanceResponse.provenance', prov, 'doseAdjustments'),
    );
    const doseAdjustments = adjustmentsRaw.map((item, idx) => {
        const path = `medicationProvenanceResponse.provenance.doseAdjustments[${String(idx)}]`;
        const entry = expectObject(path, item);
        return {
            dose: optionalString(`${path}.dose`, entry['dose'] ?? null),
            date: optionalString(`${path}.date`, entry['date'] ?? null),
        };
    });
    return {
        prescriptionId: expectIntAsString(
            'medicationProvenanceResponse.provenance.prescriptionId',
            prov['prescriptionId'],
        ),
        drugName: expectString(
            'medicationProvenanceResponse.provenance.drugName',
            prov['drugName'],
        ),
        prescriber: optionalString(
            'medicationProvenanceResponse.provenance.prescriber',
            prov['prescriber'] ?? null,
        ),
        prescribingDate: optionalString(
            'medicationProvenanceResponse.provenance.prescribingDate',
            prov['prescribingDate'] ?? null,
        ),
        indication: optionalString(
            'medicationProvenanceResponse.provenance.indication',
            prov['indication'] ?? null,
        ),
        doseAdjustments,
    };
};

export const decodePatientContextResponse = (raw: unknown): PatientContextResponse => {
    const obj = expectObject('patientContextResponse', raw);
    const diagnosesArr = expectArray(
        'patientContextResponse.diagnoses',
        requireKey('patientContextResponse', obj, 'diagnoses'),
    );
    const allergiesArr = expectArray(
        'patientContextResponse.allergies',
        requireKey('patientContextResponse', obj, 'allergies'),
    );
    return {
        patient: decodeDemographicsForNarrow(
            'patientContextResponse.patient',
            requireKey('patientContextResponse', obj, 'patient'),
        ),
        diagnoses: diagnosesArr.map((item, idx) =>
            decodeDiagnosisForNarrow(`patientContextResponse.diagnoses[${String(idx)}]`, item),
        ),
        allergies: allergiesArr.map((item, idx) =>
            decodeAllergyForNarrow(`patientContextResponse.allergies[${String(idx)}]`, item),
        ),
    };
};
