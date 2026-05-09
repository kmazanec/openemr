import { ChartSnapshotDecodeError } from '../snapshot/decode.js';
import type {
    Allergy,
    Demographics,
    Diagnosis,
    Encounter,
    EncounterNote,
    LabObservation,
    Prescription,
    SourceReference,
    VitalSign,
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
 * One chart-side document returned by the
 * `chart-documents.php` endpoint. The PHP side restricts to documents
 * filed under the `Clinical Copilot` category root and emits exactly
 * the three slots `pendingUploads` needs so the agent can splice them
 * onto the envelope without further transformation.
 *
 * The agent's `getChartDocuments` tool drops any row whose
 * `documentUuid` already has an `extraction_artifacts` entry, so the
 * supervisor only sees still-unprocessed documents.
 */
export interface ChartDocument {
    readonly documentUuid: string;
    readonly docType: 'lab_pdf' | 'intake_form';
    readonly canonicalExt: string;
}

/**
 * Provenance for a single patient-reported medication returned by
 * the §4.6.6 `medication_statement_provenance.php` endpoint. Mirrors
 * the PHP-side `MedicationStatementProvenance::toArray()` shape.
 *
 * `linkedPrescriptionId`, when present, is the foreign key to the
 * clinic's `prescriptions.id` for this self-reported entry — lets
 * the briefing distinguish "patient reports taking the metformin
 * we prescribed" from "patient is on Tylenol nobody wrote down."
 */
export interface MedicationStatementProvenance {
    readonly listId: string;
    readonly name: string;
    readonly dose: string | null;
    readonly usageCategory: string | null;
    readonly informationSource: string | null;
    readonly adherenceAssertedAt: string | null;
    readonly startDate: string | null;
    readonly stopDate: string | null;
    readonly linkedPrescriptionId: string | null;
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
    const arr = expectArray(
        'prescriptionsResponse.prescriptions',
        requireKey('prescriptionsResponse', obj, 'prescriptions'),
    );
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

const optionalIntAsString = (path: string, v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    return expectIntAsString(path, v);
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

export const decodeChartDocumentsResponse = (raw: unknown): readonly ChartDocument[] => {
    const obj = expectObject('chartDocumentsResponse', raw);
    const arr = expectArray(
        'chartDocumentsResponse.documents',
        requireKey('chartDocumentsResponse', obj, 'documents'),
    );
    return arr.map((item, idx) => {
        const path = `chartDocumentsResponse.documents[${String(idx)}]`;
        const row = expectObject(path, item);
        const docType = expectString(`${path}.doc_type`, row['doc_type']);
        if (docType !== 'lab_pdf' && docType !== 'intake_form') {
            throw new ChartSnapshotDecodeError(
                `${path}.doc_type`,
                'expected "lab_pdf" or "intake_form"',
            );
        }
        return {
            documentUuid: expectString(`${path}.document_uuid`, row['document_uuid']),
            docType,
            canonicalExt: expectString(`${path}.canonical_ext`, row['canonical_ext']),
        };
    });
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
        itemTitle: expectString('reminderDetailResponse.detail.itemTitle', detail['itemTitle']),
        category: expectString('reminderDetailResponse.detail.category', detail['category']),
        categoryTitle: expectString(
            'reminderDetailResponse.detail.categoryTitle',
            detail['categoryTitle'],
        ),
        dueStatus: expectString('reminderDetailResponse.detail.dueStatus', detail['dueStatus']),
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

export const decodeMedicationStatementProvenanceResponse = (
    raw: unknown,
): MedicationStatementProvenance => {
    const obj = expectObject('medicationStatementProvenanceResponse', raw);
    const prov = expectObject(
        'medicationStatementProvenanceResponse.provenance',
        requireKey('medicationStatementProvenanceResponse', obj, 'provenance'),
    );
    return {
        listId: expectIntAsString(
            'medicationStatementProvenanceResponse.provenance.listId',
            prov['listId'],
        ),
        name: expectString('medicationStatementProvenanceResponse.provenance.name', prov['name']),
        dose: optionalString(
            'medicationStatementProvenanceResponse.provenance.dose',
            prov['dose'] ?? null,
        ),
        usageCategory: optionalString(
            'medicationStatementProvenanceResponse.provenance.usageCategory',
            prov['usageCategory'] ?? null,
        ),
        informationSource: optionalString(
            'medicationStatementProvenanceResponse.provenance.informationSource',
            prov['informationSource'] ?? null,
        ),
        adherenceAssertedAt: optionalString(
            'medicationStatementProvenanceResponse.provenance.adherenceAssertedAt',
            prov['adherenceAssertedAt'] ?? null,
        ),
        startDate: optionalString(
            'medicationStatementProvenanceResponse.provenance.startDate',
            prov['startDate'] ?? null,
        ),
        stopDate: optionalString(
            'medicationStatementProvenanceResponse.provenance.stopDate',
            prov['stopDate'] ?? null,
        ),
        linkedPrescriptionId: optionalIntAsString(
            'medicationStatementProvenanceResponse.provenance.linkedPrescriptionId',
            prov['linkedPrescriptionId'] ?? null,
        ),
    };
};

const decodeSourceReference = (path: string, raw: unknown): SourceReference => {
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
    const locatorObj = expectObject(`${path}.locator`, obj['locator']);
    const locator: SourceReference['locator'] = {};
    if (locatorObj['field'] !== undefined) {
        (locator as { field?: string }).field = expectString(`${path}.locator.field`, locatorObj['field']);
    }
    if (locatorObj['section'] !== undefined) {
        (locator as { section?: string }).section = expectString(
            `${path}.locator.section`,
            locatorObj['section'],
        );
    }
    return {
        source_type: sourceType,
        source_id: sourceId,
        locator,
        quote,
    };
};

const decodeVital = (path: string, raw: unknown): VitalSign => {
    const obj = expectObject(path, raw);
    return {
        observedAt: optionalString(`${path}.observedAt`, obj['observedAt'] ?? null),
        bpSystolic: optionalString(`${path}.bpSystolic`, obj['bpSystolic'] ?? null),
        bpDiastolic: optionalString(`${path}.bpDiastolic`, obj['bpDiastolic'] ?? null),
        pulse: optionalString(`${path}.pulse`, obj['pulse'] ?? null),
        respiration: optionalString(`${path}.respiration`, obj['respiration'] ?? null),
        temperatureF: optionalString(`${path}.temperatureF`, obj['temperatureF'] ?? null),
        weightLbs: optionalString(`${path}.weightLbs`, obj['weightLbs'] ?? null),
        heightInches: optionalString(`${path}.heightInches`, obj['heightInches'] ?? null),
        bmi: optionalString(`${path}.bmi`, obj['bmi'] ?? null),
        oxygenSaturation: optionalString(
            `${path}.oxygenSaturation`,
            obj['oxygenSaturation'] ?? null,
        ),
        source: decodeSourceReference(`${path}.source`, requireKey(path, obj, 'source')),
    };
};

export const decodeVitalsResponse = (raw: unknown): readonly VitalSign[] => {
    const obj = expectObject('vitalsResponse', raw);
    const arr = expectArray('vitalsResponse.vitals', requireKey('vitalsResponse', obj, 'vitals'));
    return arr.map((item, idx) => decodeVital(`vitalsResponse.vitals[${String(idx)}]`, item));
};

const decodeEncounterNote = (path: string, raw: unknown): EncounterNote => {
    const obj = expectObject(path, raw);
    return {
        encounterId: expectString(`${path}.encounterId`, obj['encounterId']),
        noteId: expectString(`${path}.noteId`, obj['noteId']),
        noteDate: optionalString(`${path}.noteDate`, obj['noteDate'] ?? null),
        subjective: optionalString(`${path}.subjective`, obj['subjective'] ?? null),
        objective: optionalString(`${path}.objective`, obj['objective'] ?? null),
        assessment: optionalString(`${path}.assessment`, obj['assessment'] ?? null),
        plan: optionalString(`${path}.plan`, obj['plan'] ?? null),
        source: decodeSourceReference(`${path}.source`, requireKey(path, obj, 'source')),
    };
};

export const decodeEncounterNotesResponse = (raw: unknown): readonly EncounterNote[] => {
    const obj = expectObject('encounterNotesResponse', raw);
    const arr = expectArray(
        'encounterNotesResponse.notes',
        requireKey('encounterNotesResponse', obj, 'notes'),
    );
    return arr.map((item, idx) =>
        decodeEncounterNote(`encounterNotesResponse.notes[${String(idx)}]`, item),
    );
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
