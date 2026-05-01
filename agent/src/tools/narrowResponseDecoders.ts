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
