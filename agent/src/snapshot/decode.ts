import type {
    Allergy,
    Appointment,
    ChartSnapshot,
    Demographics,
    Diagnosis,
    Encounter,
    LabObservation,
    Prescription,
    SourceReference,
} from './types.js';

/**
 * Validates the JSON returned by the OpenEMR snapshot endpoint into typed
 * `ChartSnapshot`. Errors carry a path so a future contributor can find
 * the offending field — the PHI/structural surface here is small enough
 * that hand-written guards are simpler than pulling in zod.
 */

export class ChartSnapshotDecodeError extends Error {
    public override readonly name = 'ChartSnapshotDecodeError';
    public readonly path: string;

    public constructor(path: string, message: string) {
        super(`${path}: ${message}`);
        this.path = path;
    }
}

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

const expectString = (path: string, v: unknown): string => {
    if (typeof v !== 'string') {
        throw new ChartSnapshotDecodeError(path, 'expected a string');
    }
    return v;
};

const expectInt = (path: string, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new ChartSnapshotDecodeError(path, 'expected an integer');
    }
    return v;
};

const optionalString = (path: string, v: unknown): string | null => {
    if (v === null) {
        return null;
    }
    if (typeof v !== 'string') {
        throw new ChartSnapshotDecodeError(path, 'expected a string or null');
    }
    return v;
};

/**
 * PHP encodes integer ids as JSON numbers, but every id in this decoder's
 * output shape is held as a string (the snapshot's SourceReference does
 * the same). Coerce here so callers downstream don't have to worry about
 * the wire-format split.
 */
const optionalIntAsString = (path: string, v: unknown): string | null => {
    if (v === null) {
        return null;
    }
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new ChartSnapshotDecodeError(path, 'expected an integer or null');
    }
    return String(v);
};

const decodeSource = (path: string, raw: unknown): SourceReference => {
    const obj = expectObject(path, raw);
    return {
        system: expectString(`${path}.system`, obj['system']),
        recordType: expectString(`${path}.recordType`, obj['recordType']),
        recordId: expectString(`${path}.recordId`, obj['recordId']),
        field: optionalString(`${path}.field`, obj['field'] ?? null),
        recordedAt: optionalString(`${path}.recordedAt`, obj['recordedAt'] ?? null),
    };
};

const decodeDemographics = (path: string, raw: unknown): Demographics => {
    const obj = expectObject(path, raw);
    return {
        pid: expectInt(`${path}.pid`, obj['pid']),
        uuid: expectString(`${path}.uuid`, obj['uuid']),
        displayName: expectString(`${path}.displayName`, obj['displayName']),
        sex: optionalString(`${path}.sex`, obj['sex'] ?? null),
        dateOfBirth: optionalString(`${path}.dateOfBirth`, obj['dateOfBirth'] ?? null),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodeDiagnosis = (path: string, raw: unknown): Diagnosis => {
    const obj = expectObject(path, raw);
    return {
        code: expectString(`${path}.code`, obj['code']),
        codeSystem: expectString(`${path}.codeSystem`, obj['codeSystem']),
        label: expectString(`${path}.label`, obj['label']),
        onsetDate: optionalString(`${path}.onsetDate`, obj['onsetDate'] ?? null),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodePrescription = (path: string, raw: unknown): Prescription => {
    const obj = expectObject(path, raw);
    return {
        name: expectString(`${path}.name`, obj['name']),
        dose: optionalString(`${path}.dose`, obj['dose'] ?? null),
        route: optionalString(`${path}.route`, obj['route'] ?? null),
        frequency: optionalString(`${path}.frequency`, obj['frequency'] ?? null),
        startDate: optionalString(`${path}.startDate`, obj['startDate'] ?? null),
        stopDate: optionalString(`${path}.stopDate`, obj['stopDate'] ?? null),
        prescriber: optionalString(`${path}.prescriber`, obj['prescriber'] ?? null),
        // §4.3 fields. `??` defaults so older fixtures (pre-§4.3) still
        // decode — the PHP regenerator was updated alongside this, but
        // keeping the decoder additive avoids a synchronized-bump
        // requirement on every consumer.
        indication: optionalString(`${path}.indication`, obj['indication'] ?? null),
        prescriptionId: optionalIntAsString(
            `${path}.prescriptionId`,
            obj['prescriptionId'] ?? null,
        ),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodeAllergy = (path: string, raw: unknown): Allergy => {
    const obj = expectObject(path, raw);
    return {
        substance: expectString(`${path}.substance`, obj['substance']),
        reaction: optionalString(`${path}.reaction`, obj['reaction'] ?? null),
        severity: optionalString(`${path}.severity`, obj['severity'] ?? null),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodeLab = (path: string, raw: unknown): LabObservation => {
    const obj = expectObject(path, raw);
    return {
        analyte: expectString(`${path}.analyte`, obj['analyte']),
        value: expectString(`${path}.value`, obj['value']),
        unit: optionalString(`${path}.unit`, obj['unit'] ?? null),
        referenceRange: optionalString(`${path}.referenceRange`, obj['referenceRange'] ?? null),
        abnormalFlag: optionalString(`${path}.abnormalFlag`, obj['abnormalFlag'] ?? null),
        observedAt: optionalString(`${path}.observedAt`, obj['observedAt'] ?? null),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodeEncounter = (path: string, raw: unknown): Encounter => {
    const obj = expectObject(path, raw);
    return {
        encounterDate: optionalString(`${path}.encounterDate`, obj['encounterDate'] ?? null),
        type: optionalString(`${path}.type`, obj['type'] ?? null),
        reason: optionalString(`${path}.reason`, obj['reason'] ?? null),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodeAppointment = (path: string, raw: unknown): Appointment => {
    const obj = expectObject(path, raw);
    return {
        appointmentId: expectString(`${path}.appointmentId`, obj['appointmentId']),
        startAt: expectString(`${path}.startAt`, obj['startAt']),
        durationMinutes: expectInt(`${path}.durationMinutes`, obj['durationMinutes']),
        type: optionalString(`${path}.type`, obj['type'] ?? null),
        reason: optionalString(`${path}.reason`, obj['reason'] ?? null),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodeList = <T>(
    path: string,
    raw: unknown,
    decode: (itemPath: string, item: unknown) => T,
): T[] => {
    const arr = expectArray(path, raw);
    return arr.map((item, idx) => decode(`${path}[${String(idx)}]`, item));
};

const requireKey = (obj: Record<string, unknown>, key: string): unknown => {
    if (!(key in obj)) {
        throw new ChartSnapshotDecodeError(`snapshot.${key}`, `${key} is required`);
    }
    return obj[key];
};

/**
 * Element decoders re-exported under stable names so the narrow
 * conversational-path response decoders (`narrowResponseDecoders.ts`)
 * can reuse the same field-by-field walks. Keeping decode logic in
 * one place — there is exactly one way to interpret a Prescription
 * coming from OpenEMR, regardless of which endpoint emitted it.
 */
export const decodeDemographicsForNarrow = decodeDemographics;
export const decodeDiagnosisForNarrow = decodeDiagnosis;
export const decodePrescriptionForNarrow = decodePrescription;
export const decodeAllergyForNarrow = decodeAllergy;
export const decodeLabForNarrow = decodeLab;
export const decodeEncounterForNarrow = decodeEncounter;

export const decodeChartSnapshot = (raw: unknown): ChartSnapshot => {
    const obj = expectObject('snapshot', raw);

    // Every top-level key must be present. PHP's ChartSnapshot::toArray()
    // emits each one unconditionally; a missing key means the contract
    // drifted and we'd rather fail loudly than silently coerce to empty.
    const patientRaw = requireKey(obj, 'patient');
    requireKey(obj, 'appointment');
    const appointmentRaw = obj['appointment'];
    const appointment =
        appointmentRaw === null ? null : decodeAppointment('snapshot.appointment', appointmentRaw);

    return {
        patient: decodeDemographics('snapshot.patient', patientRaw),
        appointment,
        diagnoses: decodeList('snapshot.diagnoses', requireKey(obj, 'diagnoses'), decodeDiagnosis),
        prescriptions: decodeList(
            'snapshot.prescriptions',
            requireKey(obj, 'prescriptions'),
            decodePrescription,
        ),
        allergies: decodeList('snapshot.allergies', requireKey(obj, 'allergies'), decodeAllergy),
        labs: decodeList('snapshot.labs', requireKey(obj, 'labs'), decodeLab),
        encounters: decodeList('snapshot.encounters', requireKey(obj, 'encounters'), decodeEncounter),
    };
};
