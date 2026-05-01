import type { Counters } from '../../observability/counters.js';
import { loadChartSnapshot } from '../../tools/loadChartSnapshot.js';
import type { SnapshotClient } from '../../tools/snapshotClient.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { BriefingSnapshot } from '../types.js';

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
}

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

        const snapshot: BriefingSnapshot = {
            patient: chart.patient,
            appointment: chart.appointment,
            diagnoses: chart.diagnoses,
            medications: chart.medications,
            allergies: chart.allergies,
            labs: chart.labs,
            encounters: chart.encounters,
        };

        return { snapshot };
    };
};
