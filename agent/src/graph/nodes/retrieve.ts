import type { Counters } from '../../observability/counters.js';
import type { AgentHttpClient } from '../../tools/agentHttp.js';
import { getLabHistory, type GetLabHistoryInput } from '../../tools/getLabHistory.js';
import { loadChartSnapshot } from '../../tools/loadChartSnapshot.js';
import type { SnapshotClient } from '../../tools/snapshotClient.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { BriefingSnapshot, Gap, LabHistorySeries } from '../types.js';

/**
 * Default lookback for the UC2 lab-history fan-out. Two years matches
 * how clinicians read A1c/lipid/eGFR trends — long enough to span
 * pre/post a medication change, short enough to not drown the model
 * in irrelevant rows.
 */
export const UC2_LAB_HISTORY_LOOKBACK_DAYS = 730;

/**
 * §3.2 `Retrieve` node. Calls `loadChartSnapshot` once and distributes
 * the decoded snapshot into the `BriefingSnapshot` shape.
 *
 * Trade-off vs the previous four-tool fan-out: a single network/5xx
 * failure now fails the whole briefing instead of letting labs or
 * encounters fail-open. That fail-open behavior was already thin in
 * practice — the OpenEMR snapshot controller returns 503 for *any*
 * adapter failure, so a labs-adapter blip already failed all four
 * calls. The narrow per-category tools added in B2 restore real
 * per-category isolation for the conversational path.
 *
 * Deps come in via the factory rather than `LangGraphRunnableConfig`
 * so the graph builder can wire the per-request bearer token before
 * invoking the compiled graph — keeping `AgentPrincipal` clean of the
 * raw token (it doesn't belong in trace tags or other broad-context
 * value objects).
 */
/**
 * UC2 lab-history fetcher. Tests inject a stub; production wires the
 * real `getLabHistory` tool via `briefingRunner`. Default factory
 * captures the production seam: an `AgentHttpClient` + base URL pair
 * passed to the tool function. Keeping this as a typed seam avoids
 * test code reaching into the LangSmith-traced `getLabHistory` symbol
 * (which is hard to stub without breaking the trace wrapper).
 */
export type LabHistoryFetcher = (
    input: Omit<GetLabHistoryInput, 'client' | 'openEmrBaseUrl' | 'counters'>
        & { readonly counters?: GetLabHistoryInput['counters'] },
) => ReturnType<typeof getLabHistory>;

export interface RetrieveDeps {
    readonly client: SnapshotClient;
    readonly token: string;
    /**
     * Site the snapshot endpoint must be called against — derived from
     * the verified JWT in the route handler. Threaded through every tool
     * call so OpenEMR's `globals.php` can resolve the site without
     * relying on a session cookie (the agent has none).
     */
    readonly siteId: string;
    /**
     * §6.1 cost-projection counters. Optional so existing tests that
     * build a graph without observability wiring still work; production
     * threads this from `briefingRunner`.
     */
    readonly counters?: Counters;
    /**
     * §4.2 UC2 fan-out. Only invoked when the envelope carries
     * `followUp.type === 'lab_trend'`. Optional so non-UC2 tests can
     * keep their existing wiring; if a `lab_trend` turn arrives without
     * the fetcher, retrieve files a gap so downstream nodes still see
     * a consistent shape.
     */
    readonly fetchLabHistory?: LabHistoryFetcher;
}

const labHistoryUnavailable = (reason: string, message: string): Gap => ({
    kind: 'gap',
    reason,
    message,
});

export const createRetrieve = (
    deps: RetrieveDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    return async (state) => {
        const chart = await loadChartSnapshot({
            client: deps.client,
            token: deps.token,
            siteId: deps.siteId,
            pid: state.envelope.patient.pid,
            ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
        });

        const followUp = state.envelope.followUp;
        let labHistory: LabHistorySeries | Gap | null = null;
        if (followUp?.type === 'lab_trend') {
            if (deps.fetchLabHistory === undefined) {
                labHistory = labHistoryUnavailable(
                    'fetcher-unwired',
                    'Lab history is not available right now.',
                );
            } else {
                const result = await deps.fetchLabHistory({
                    token: deps.token,
                    siteId: deps.siteId,
                    pid: state.envelope.patient.pid,
                    analyte: followUp.analyte,
                    lookbackDays: UC2_LAB_HISTORY_LOOKBACK_DAYS,
                    ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
                });
                labHistory = result.kind === 'ok'
                    ? { analyte: followUp.analyte, observations: result.labs }
                    : { kind: 'gap', reason: result.reason, message: result.message };
            }
        }

        const snapshot: BriefingSnapshot = {
            patient: chart.patient,
            appointment: chart.appointment,
            diagnoses: chart.diagnoses,
            medications: chart.medications,
            allergies: chart.allergies,
            labs: chart.labs,
            encounters: chart.encounters,
            labHistory,
        };

        return { snapshot };
    };
};

/**
 * Default `LabHistoryFetcher` for production. Captures the
 * `AgentHttpClient` + base URL once and returns a fetcher that
 * forwards to the real `getLabHistory` tool — keeps the per-request
 * hot path free of HTTP-client construction.
 */
export const createLabHistoryFetcher = (input: {
    readonly client: AgentHttpClient;
    readonly openEmrBaseUrl: string;
}): LabHistoryFetcher => {
    return ({ counters, ...rest }) =>
        getLabHistory({
            client: input.client,
            openEmrBaseUrl: input.openEmrBaseUrl,
            ...rest,
            ...(counters !== undefined ? { counters } : {}),
        });
};
