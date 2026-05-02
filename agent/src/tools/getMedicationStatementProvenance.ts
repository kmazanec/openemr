import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';

import { AgentHttpError, type AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import {
    decodeMedicationStatementProvenanceResponse,
    type MedicationStatementProvenance,
} from './narrowResponseDecoders.js';

/**
 * Provenance for a single patient-reported medication. Backs
 * §4.6.6's medication-statement-detail drill-down: the graph's
 * `medicationStatementBranch` calls this with the listId from the
 * suggested follow-up's typed params, then builds a deterministic
 * claim from the dose instructions, usage category, and information
 * source.
 *
 * **Behavioral contract (pinned by tests):**
 * - 404 → `{ kind: 'ok', provenance: null }` for the deterministic
 *   "no record found" path.
 * - 5xx / network → typed gap.
 * - 401/403 → throw.
 */

const PROVENANCE_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/medication_statement_provenance.php';

export interface GetMedicationStatementProvenanceInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly listId: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type MedicationStatementProvenanceResult = FailOpenResult<{
    readonly provenance: MedicationStatementProvenance | null;
}>;

const buildUrl = (input: GetMedicationStatementProvenanceInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        listId: String(input.listId),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${PROVENANCE_PATH}?${params.toString()}`;
};

const impl = async (
    input: GetMedicationStatementProvenanceInput,
): Promise<MedicationStatementProvenanceResult> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (!Number.isInteger(input.listId) || input.listId <= 0) {
        throw new Error('listId must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        const raw = await input.client.get({ url: buildUrl(input), token: input.token });
        const provenance = decodeMedicationStatementProvenanceResponse(raw);
        return { kind: 'ok', provenance };
    } catch (err) {
        if (err instanceof AgentHttpError && err.status === 404) {
            return { kind: 'ok', provenance: null };
        }
        if (isFailOpenError(err)) {
            return toGap(err, 'Medication statement detail');
        }
        throw err;
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getMedicationStatementProvenance', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getMedicationStatementProvenance' });
    }
};

export const getMedicationStatementProvenance = traceable(impl, {
    name: 'getMedicationStatementProvenance',
    run_type: 'tool',
});

export const getMedicationStatementProvenanceTool = {
    name: 'getMedicationStatementProvenance',
    description:
        "Fetch detail for a single patient-reported medication (FHIR MedicationStatement): dosage instructions, usage category (OTC, supplement, prescribed elsewhere), information source (patient/family/external), adherence-asserted date, and any linked clinic prescription. Use when the question is about WHAT the patient said about a self-reported medication, not what the clinic prescribed. List ids come from `medications[].listId` in the snapshot.",
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid).',
            },
            listId: {
                type: 'integer' as const,
                description:
                    "MedicationStatement record id (the snapshot's medications[].listId).",
            },
        },
        required: ['patientPid', 'listId'],
    },
} as const;
