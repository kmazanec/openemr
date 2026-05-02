import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { Prescription } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { decodePrescriptionsResponse } from './narrowResponseDecoders.js';

/**
 * Recent prescriptions for one patient — clinic-written scripts (FHIR
 * `MedicationRequest`), active rows plus inactive rows modified within
 * the lookback window.
 *
 * Conversational-path tool: maps 1:1 to OpenEMR's
 * `public/snapshot/prescriptions.php`, which runs only the
 * PrescriptionAdapter and writes a `prescriptions` audit row. The
 * model picks this tool on a follow-up like "what is she on?".
 *
 * Briefing path uses {@link loadChartSnapshot} instead, which calls
 * `snapshot.php` once for everything.
 */

const PRESCRIPTIONS_PATH = '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/prescriptions.php';

export interface GetPrescriptionsInput {
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

const buildUrl = (input: GetPrescriptionsInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${PRESCRIPTIONS_PATH}?${params.toString()}`;
};

const impl = async (input: GetPrescriptionsInput): Promise<readonly Prescription[]> => {
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
        return decodePrescriptionsResponse(raw);
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getPrescriptions', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getPrescriptions' });
    }
};

export const getPrescriptions = traceable(impl, { name: 'getPrescriptions', run_type: 'tool' });

/**
 * Anthropic tool-use registration metadata. The conversational graph
 * will register this for the model to call when answering follow-up
 * questions; the briefing path does not use it.
 */
export const getPrescriptionsTool = {
    name: 'getPrescriptions',
    description:
        'Fetch the patient\'s recent prescriptions: drug name, dose, route, frequency, prescriber, start date, and stop date for inactive rows. Includes active scripts plus inactive scripts modified within the last year so recent discontinuations surface. Use this when the question is about what the clinic has prescribed; for patient-reported / OTC entries see getMedicationStatements (Phase 4.6.4).',
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid) to fetch prescriptions for.',
            },
        },
        required: ['patientPid'],
    },
} as const;
