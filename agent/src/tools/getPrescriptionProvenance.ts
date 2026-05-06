import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';

import { AgentHttpError, type AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import {
    decodePrescriptionProvenanceResponse,
    type PrescriptionProvenance,
} from './narrowResponseDecoders.js';

/**
 * Provenance for a single prescription. The deterministic
 * prescription-change branch that used to consume this is gone — the
 * tool stays on disk as a supervisor-pickable handoff candidate for
 * future "why was X prescribed?" routing.
 *
 * **Behavioral contract (pinned by tests, not just docs):**
 * - 404 from the endpoint is a *deterministic* "no record found" — the
 *   tool returns `{ kind: 'ok', provenance: null }` so the branch can
 *   render a connector segment instead of a hallucinated answer.
 * - 5xx / network failures fail open with a typed gap.
 * - 401/403 throw — that signals a misconfigured trust boundary, not
 *   a data gap.
 *
 * `doseAdjustments` carries the current single dose only — OpenEMR's
 * `prescriptions` table has no historical dose-change column. The
 * model must not infer a dose history; the §4.3 verifier rule will
 * reject claims that mention a history not present in the source.
 */

const PROVENANCE_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/prescription_provenance.php';

export interface GetPrescriptionProvenanceInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    /** Prescription primary key (the snapshot's prescription record id). */
    readonly prescriptionId: number;
    readonly openEmrBaseUrl: string;
    /** §6.1: optional counters sink. */
    readonly counters?: Counters;
}

export type PrescriptionProvenanceResult = FailOpenResult<{
    readonly provenance: PrescriptionProvenance | null;
}>;

const buildUrl = (input: GetPrescriptionProvenanceInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        prescriptionId: String(input.prescriptionId),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${PROVENANCE_PATH}?${params.toString()}`;
};

const impl = async (
    input: GetPrescriptionProvenanceInput,
): Promise<PrescriptionProvenanceResult> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (!Number.isInteger(input.prescriptionId) || input.prescriptionId <= 0) {
        throw new Error('prescriptionId must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        const raw = await input.client.get({ url: buildUrl(input), token: input.token });
        const provenance = decodePrescriptionProvenanceResponse(raw);
        return { kind: 'ok', provenance };
    } catch (err) {
        // 404 is *not* a fail-open gap. The branch needs to know the
        // prescription doesn't exist for this patient (or doesn't exist
        // at all) so it can render a deterministic "no record found"
        // segment rather than a fabricated answer. Special-case before
        // delegating to isFailOpenError, which would otherwise classify
        // any non-401/403 as a gap.
        if (err instanceof AgentHttpError && err.status === 404) {
            return { kind: 'ok', provenance: null };
        }
        if (isFailOpenError(err)) {
            return toGap(err, 'Prescription provenance');
        }
        throw err;
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getPrescriptionProvenance', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getPrescriptionProvenance' });
    }
};

export const getPrescriptionProvenance = traceable(impl, {
    name: 'getPrescriptionProvenance',
    run_type: 'tool',
});

/**
 * Anthropic tool-use registration metadata. Currently the §4.3
 * graph branch calls this tool directly (deterministic path). The
 * registration metadata is here for symmetry with the other narrow
 * tools and in case a later free-text path needs the model to call
 * it directly.
 */
export const getPrescriptionProvenanceTool = {
    name: 'getPrescriptionProvenance',
    description:
        'Fetch documented provenance for a single prescription: prescriber, prescribing date, indication, and current dose. Use when the question is about WHEN a prescription was started, BY WHOM, or FOR WHAT reason. doseAdjustments contains only the current dose — historical dose changes are not available; do not infer a dose history.',
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description: 'OpenEMR patient id (pid).',
            },
            prescriptionId: {
                type: 'integer' as const,
                description:
                    "Prescription record id (the snapshot's prescription source.recordId).",
            },
        },
        required: ['patientPid', 'prescriptionId'],
    },
} as const;
