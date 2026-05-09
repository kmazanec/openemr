import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';

import { type AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import {
    decodeChartDocumentsResponse,
    type ChartDocument,
} from './narrowResponseDecoders.js';

/**
 * Lists Clinical-Copilot-categorized documents on a patient's chart
 * (regardless of whether the agent has already extracted them).
 *
 * The briefing runner pairs this with an `extraction_artifacts` lookup
 * on the agent's own DB to produce the *unprocessed* subset, then
 * splices that subset into `RequestEnvelope.pendingUploads` before the
 * graph runs. From there the supervisor's existing
 * `kickoffExtraction` routing handles the rest unchanged — chart-side
 * uploads (legacy Documents UI) get the same supervisor → kickoff →
 * documentEvidenceRetriever → synthesize flow as chat-panel uploads.
 *
 * **Behavioral contract (pinned by tests, not just docs):**
 *  - 5xx / network failures fail open with a typed gap. The runner
 *    proceeds with the un-enriched envelope (i.e. legacy chat-panel
 *    behavior); the briefing still works, just without chart-doc
 *    discovery this turn.
 *  - 401/403 throw — that's a misconfigured trust boundary, not a
 *    data gap.
 *  - The endpoint returns an empty list when the patient has no
 *    Clinical-Copilot-categorized documents; the tool surfaces that
 *    as `{ kind: 'ok', documents: [] }`.
 */

const CHART_DOCUMENTS_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/chart-documents.php';

export interface GetChartDocumentsInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly openEmrBaseUrl: string;
    readonly conversationId?: string;
    readonly counters?: Counters;
}

export type ChartDocumentsResult = FailOpenResult<{
    readonly documents: readonly ChartDocument[];
}>;

const buildUrl = (input: GetChartDocumentsInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        ...(input.conversationId !== undefined ? { conversation: input.conversationId } : {}),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${CHART_DOCUMENTS_PATH}?${params.toString()}`;
};

const impl = async (
    input: GetChartDocumentsInput,
): Promise<ChartDocumentsResult> => {
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
        const documents = decodeChartDocumentsResponse(raw);
        return { kind: 'ok', documents };
    } catch (err) {
        if (isFailOpenError(err)) {
            return toGap(err, 'Chart documents');
        }
        throw err;
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getChartDocuments', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getChartDocuments' });
    }
};

export const getChartDocuments = traceable(impl, {
    name: 'getChartDocuments',
    run_type: 'tool',
});
