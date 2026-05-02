import { ChartSnapshotDecodeError } from '../snapshot/decode.js';
import type {
    Allergy,
    Demographics,
    Diagnosis,
    Encounter,
    LabObservation,
    Prescription,
} from '../snapshot/types.js';

/**
 * Provenance for a single prescription returned by the §4.3
 * `prescription_provenance.php` endpoint. Mirrors the PHP-side
 * `PrescriptionProvenance::toArray()` shape.
 *
 * `doseAdjustments` carries the current single dose only — OpenEMR's
 * `prescriptions` table has no historical dose-change column, and
 * `date_modified` moves on any edit. Tools and graph branches consuming
 * this shape must not infer a dose history; the verifier rule enforces
 * that constraint at the claim layer.
 */
export interface PrescriptionProvenance {
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
 * Detail for a single clinical reminder returned by the §4.6.5
 * `reminder_detail.php` endpoint. Mirrors the PHP-side
 * `ReminderDetail::toArray()` shape.
 */
export interface ReminderDetail {
    readonly reminderId: string;
    readonly item: string;
    readonly itemTitle: string;
    readonly category: string;
    readonly categoryTitle: string;
    readonly dueStatus: string;
    readonly createdAt: string | null;
    readonly ruleDescription: string | null;
}

/**
 * JSON-shape decoders for the four narrow agent endpoints. Each
 * narrow endpoint returns a slim JSON envelope with only its own
 * data; these helpers walk that envelope into the same typed DTOs
 * that the full ChartSnapshot uses. The element decoders themselves
 * live in `snapshot/decode.ts` because the briefing path exercises
 * the same shapes — we don't want two ways to decode a Prescription.
 */

import {
    decodeAllergyForNarrow,
    decodeDemographicsForNarrow,
    decodeDiagnosisForNarrow,
    decodeEncounterForNarrow,
    decodeLabForNarrow,
    decodePrescriptionForNarrow,
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

export const decodePrescriptionsResponse = (raw: unknown): readonly Prescription[] => {
    const obj = expectObject('prescriptionsResponse', raw);
    const arr = expectArray('prescriptionsResponse.prescriptions', requireKey('prescriptionsResponse', obj, 'prescriptions'));
    return arr.map((item, idx) =>
        decodePrescriptionForNarrow(`prescriptionsResponse.prescriptions[${String(idx)}]`, item),
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

export const decodePrescriptionProvenanceResponse = (raw: unknown): PrescriptionProvenance => {
    const obj = expectObject('prescriptionProvenanceResponse', raw);
    const prov = expectObject(
        'prescriptionProvenanceResponse.provenance',
        requireKey('prescriptionProvenanceResponse', obj, 'provenance'),
    );
    const adjustmentsRaw = expectArray(
        'prescriptionProvenanceResponse.provenance.doseAdjustments',
        requireKey('prescriptionProvenanceResponse.provenance', prov, 'doseAdjustments'),
    );
    const doseAdjustments = adjustmentsRaw.map((item, idx) => {
        const path = `prescriptionProvenanceResponse.provenance.doseAdjustments[${String(idx)}]`;
        const entry = expectObject(path, item);
        return {
            dose: optionalString(`${path}.dose`, entry['dose'] ?? null),
            date: optionalString(`${path}.date`, entry['date'] ?? null),
        };
    });
    return {
        prescriptionId: expectIntAsString(
            'prescriptionProvenanceResponse.provenance.prescriptionId',
            prov['prescriptionId'],
        ),
        drugName: expectString(
            'prescriptionProvenanceResponse.provenance.drugName',
            prov['drugName'],
        ),
        prescriber: optionalString(
            'prescriptionProvenanceResponse.provenance.prescriber',
            prov['prescriber'] ?? null,
        ),
        prescribingDate: optionalString(
            'prescriptionProvenanceResponse.provenance.prescribingDate',
            prov['prescribingDate'] ?? null,
        ),
        indication: optionalString(
            'prescriptionProvenanceResponse.provenance.indication',
            prov['indication'] ?? null,
        ),
        doseAdjustments,
    };
};

export const decodeReminderDetailResponse = (raw: unknown): ReminderDetail => {
    const obj = expectObject('reminderDetailResponse', raw);
    const detail = expectObject(
        'reminderDetailResponse.detail',
        requireKey('reminderDetailResponse', obj, 'detail'),
    );
    return {
        reminderId: expectIntAsString(
            'reminderDetailResponse.detail.reminderId',
            detail['reminderId'],
        ),
        item: expectString('reminderDetailResponse.detail.item', detail['item']),
        itemTitle: expectString(
            'reminderDetailResponse.detail.itemTitle',
            detail['itemTitle'],
        ),
        category: expectString(
            'reminderDetailResponse.detail.category',
            detail['category'],
        ),
        categoryTitle: expectString(
            'reminderDetailResponse.detail.categoryTitle',
            detail['categoryTitle'],
        ),
        dueStatus: expectString(
            'reminderDetailResponse.detail.dueStatus',
            detail['dueStatus'],
        ),
        createdAt: optionalString(
            'reminderDetailResponse.detail.createdAt',
            detail['createdAt'] ?? null,
        ),
        ruleDescription: optionalString(
            'reminderDetailResponse.detail.ruleDescription',
            detail['ruleDescription'] ?? null,
        ),
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
