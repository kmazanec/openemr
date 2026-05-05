import type {
    Allergy,
    Appointment,
    ChartSnapshot,
    Demographics,
    Diagnosis,
    Encounter,
    LabObservation,
    MedicationStatement,
    Prescription,
    Reminder,
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

const optionalInt = (path: string, v: unknown): number | null => {
    if (v === null) {
        return null;
    }
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new ChartSnapshotDecodeError(path, 'expected an integer or null');
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
    const sourceType = expectString(`${path}.source_type`, obj['source_type']);
    if (sourceType !== 'chart' && sourceType !== 'extracted_document' && sourceType !== 'guideline') {
        throw new ChartSnapshotDecodeError(
            `${path}.source_type`,
            "expected 'chart' | 'extracted_document' | 'guideline'",
        );
    }
    const sourceId = expectString(`${path}.source_id`, obj['source_id']);
    const quote = expectString(`${path}.quote`, obj['quote']);
    const locator = decodeLocator(`${path}.locator`, obj['locator']);
    const meta = obj['meta'] === undefined ? undefined : decodeMeta(`${path}.meta`, obj['meta']);
    const confidenceRaw = obj['confidence'];
    const confidence =
        confidenceRaw === undefined
            ? undefined
            : (() => {
                  if (typeof confidenceRaw !== 'number' || confidenceRaw < 0 || confidenceRaw > 1) {
                      throw new ChartSnapshotDecodeError(
                          `${path}.confidence`,
                          'expected a number in [0, 1]',
                      );
                  }
                  return confidenceRaw;
              })();
    // Polymorphism check mirrors the PHP-side validateLocator and
    // the Zod schema's superRefine; rejecting at decode time keeps
    // unresolvable citations out of the verifier.
    if (sourceType === 'chart' && locator.field === undefined) {
        throw new ChartSnapshotDecodeError(`${path}.locator.field`, 'chart source requires locator.field');
    }
    if (sourceType === 'extracted_document') {
        if (locator.page === undefined) {
            throw new ChartSnapshotDecodeError(
                `${path}.locator.page`,
                'extracted_document source requires locator.page',
            );
        }
        if (locator.bbox === undefined) {
            throw new ChartSnapshotDecodeError(
                `${path}.locator.bbox`,
                'extracted_document source requires locator.bbox',
            );
        }
    }
    if (sourceType === 'guideline' && locator.section === undefined) {
        throw new ChartSnapshotDecodeError(
            `${path}.locator.section`,
            'guideline source requires locator.section',
        );
    }
    return {
        source_type: sourceType,
        source_id: sourceId,
        locator,
        quote,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(meta !== undefined ? { meta } : {}),
    };
};

const decodeLocator = (path: string, raw: unknown): SourceReference['locator'] => {
    const obj = expectObject(path, raw);
    const locator: { -readonly [K in keyof SourceReference['locator']]: SourceReference['locator'][K] } = {};
    if (obj['page'] !== undefined) {
        locator.page = expectInt(`${path}.page`, obj['page']);
    }
    if (obj['bbox'] !== undefined) {
        const bboxRaw = obj['bbox'];
        if (!Array.isArray(bboxRaw) || bboxRaw.length !== 4) {
            throw new ChartSnapshotDecodeError(`${path}.bbox`, 'expected a 4-tuple of numbers');
        }
        const bbox: number[] = [];
        for (let i = 0; i < 4; i++) {
            const v = bboxRaw[i];
            if (typeof v !== 'number') {
                throw new ChartSnapshotDecodeError(`${path}.bbox[${i}]`, 'expected a number');
            }
            bbox.push(v);
        }
        locator.bbox = bbox as unknown as readonly [number, number, number, number];
    }
    if (obj['section'] !== undefined) {
        locator.section = expectString(`${path}.section`, obj['section']);
    }
    if (obj['field'] !== undefined) {
        locator.field = expectString(`${path}.field`, obj['field']);
    }
    return locator;
};

const decodeMeta = (path: string, raw: unknown): NonNullable<SourceReference['meta']> => {
    const obj = expectObject(path, raw);
    const meta: { -readonly [K in keyof NonNullable<SourceReference['meta']>]: NonNullable<SourceReference['meta']>[K] } = {};
    if (obj['document_uuid'] !== undefined) {
        meta.document_uuid = expectString(`${path}.document_uuid`, obj['document_uuid']);
    }
    if (obj['extractor_version'] !== undefined) {
        meta.extractor_version = expectString(`${path}.extractor_version`, obj['extractor_version']);
    }
    if (obj['rerank_score'] !== undefined) {
        const v = obj['rerank_score'];
        if (typeof v !== 'number') {
            throw new ChartSnapshotDecodeError(`${path}.rerank_score`, 'expected a number');
        }
        meta.rerank_score = v;
    }
    if (obj['record_recorded_at'] !== undefined) {
        meta.record_recorded_at = expectString(
            `${path}.record_recorded_at`,
            obj['record_recorded_at'],
        );
    }
    return meta;
};

const decodeDemographics = (path: string, raw: unknown): Demographics => {
    const obj = expectObject(path, raw);
    return {
        pid: expectInt(`${path}.pid`, obj['pid']),
        uuid: expectString(`${path}.uuid`, obj['uuid']),
        displayName: expectString(`${path}.displayName`, obj['displayName']),
        sex: optionalString(`${path}.sex`, obj['sex'] ?? null),
        dateOfBirth: optionalString(`${path}.dateOfBirth`, obj['dateOfBirth'] ?? null),
        // `ageYears` is additive — older fixtures predating server-side
        // age computation omit the key, and the decoder defaults those
        // to null rather than forcing a synchronized regen.
        ageYears: optionalInt(`${path}.ageYears`, obj['ageYears'] ?? null),
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

const decodeReminder = (path: string, raw: unknown): Reminder => {
    const obj = expectObject(path, raw);
    return {
        item: expectString(`${path}.item`, obj['item']),
        itemTitle: expectString(`${path}.itemTitle`, obj['itemTitle']),
        category: expectString(`${path}.category`, obj['category']),
        categoryTitle: expectString(`${path}.categoryTitle`, obj['categoryTitle']),
        dueStatus: expectString(`${path}.dueStatus`, obj['dueStatus']),
        createdAt: optionalString(`${path}.createdAt`, obj['createdAt'] ?? null),
        reminderId: optionalIntAsString(
            `${path}.reminderId`,
            obj['reminderId'] ?? null,
        ),
        source: decodeSource(`${path}.source`, obj['source']),
    };
};

const decodeMedicationStatement = (path: string, raw: unknown): MedicationStatement => {
    const obj = expectObject(path, raw);
    return {
        name: expectString(`${path}.name`, obj['name']),
        dose: optionalString(`${path}.dose`, obj['dose'] ?? null),
        usageCategory: optionalString(`${path}.usageCategory`, obj['usageCategory'] ?? null),
        informationSource: optionalString(
            `${path}.informationSource`,
            obj['informationSource'] ?? null,
        ),
        startDate: optionalString(`${path}.startDate`, obj['startDate'] ?? null),
        stopDate: optionalString(`${path}.stopDate`, obj['stopDate'] ?? null),
        listId: optionalIntAsString(`${path}.listId`, obj['listId'] ?? null),
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
export const decodeReminderForNarrow = decodeReminder;
export const decodeMedicationStatementForNarrow = decodeMedicationStatement;

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
        reminders: decodeList('snapshot.reminders', requireKey(obj, 'reminders'), decodeReminder),
        medications: decodeList(
            'snapshot.medications',
            requireKey(obj, 'medications'),
            decodeMedicationStatement,
        ),
    };
};
