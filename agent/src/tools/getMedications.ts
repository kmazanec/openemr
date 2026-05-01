import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { Medication } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { decodeMedicationsResponse } from './narrowResponseDecoders.js';

/**
 * Active medications for one patient.
 *
 * Conversational-path tool: maps 1:1 to OpenEMR's
 * `public/snapshot/medications.php`, which runs only the
 * MedicationAdapter and writes a `medications` audit row. The model
 * picks this tool on a follow-up like "what is she on?".
 *
 * Briefing path uses {@link loadChartSnapshot} instead, which calls
 * `snapshot.php` once for everything.
 */

const MEDICATIONS_PATH = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/medications.php';

export interface GetMedicationsInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    /**
     * Base URL of the OpenEMR install (no trailing slash). The narrow
     * URL is composed inline so each tool owns its own endpoint
     * shape — there is no shared multiplex anymore.
     */
    readonly openEmrBaseUrl: string;
    /** §6.1: optional counters sink. */
    readonly counters?: Counters;
}

const buildUrl = (input: GetMedicationsInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${MEDICATIONS_PATH}?${params.toString()}`;
};

const impl = async (input: GetMedicationsInput): Promise<readonly Medication[]> => {
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
        return decodeMedicationsResponse(raw);
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getMedications', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getMedications' });
    }
};

export const getMedications = traceable(impl, { name: 'getMedications', run_type: 'tool' });

/**
 * Anthropic tool-use registration metadata. The conversational graph
 * will register this for the model to call when answering follow-up
 * questions; the briefing path does not use it.
 */
export const getMedicationsTool = {
    name: 'getMedications',
    description:
        'Fetch the patient\'s currently active medications: drug name, dose, route, frequency, prescriber, and start date. Use this when the question is about what the patient is taking now. Does not include discontinued or historical prescriptions.',
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch medications for.',
            },
        },
        required: ['patientPid'],
    },
} as const;
