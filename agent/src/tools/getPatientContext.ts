import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { Allergy, Demographics, Diagnosis } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { decodePatientContextResponse } from './narrowResponseDecoders.js';

/**
 * "Who is this patient" bundle: demographics + active diagnoses +
 * active allergies.
 *
 * Conversational-path tool: maps 1:1 to OpenEMR's
 * `public/snapshot/patientContext.php`, which runs only the patient,
 * condition, and allergy adapters and writes a `patient_context`
 * audit row. Fail-closed: if any of these throw on the OpenEMR side
 * the model needs to know.
 *
 * Bundling three categories into one tool is a deliberate exception
 * to "one category per tool" — see the OpenEMR-side
 * `PatientContextController` docblock for the rationale.
 */

const PATIENT_CONTEXT_PATH = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/patientContext.php';

export interface GetPatientContextInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export interface PatientContext {
    readonly patient: Demographics;
    readonly diagnoses: readonly Diagnosis[];
    readonly allergies: readonly Allergy[];
}

const buildUrl = (input: GetPatientContextInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${PATIENT_CONTEXT_PATH}?${params.toString()}`;
};

const impl = async (input: GetPatientContextInput): Promise<PatientContext> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        const raw = await input.client.get({ url: buildUrl(input), token: input.token });
        return decodePatientContextResponse(raw);
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getPatientContext', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getPatientContext' });
    }
};

export const getPatientContext = traceable(impl, { name: 'getPatientContext', run_type: 'tool' });

export const getPatientContextTool = {
    name: 'getPatientContext',
    description:
        'Fetch the "who is this patient" bundle: demographics (name, sex, dob), active diagnoses (ICD-10), and active allergies (substance, reaction, severity). Use this when the question needs identity, problem list, or allergy context together. Returns three small lists in one call so the model does not have to thread three separate tool turns for the common case.',
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch context for.',
            },
        },
        required: ['patientPid'],
    },
} as const;
