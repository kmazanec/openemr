import type { Counters } from '../../observability/counters.js';
import { loadChartSnapshot } from '../../tools/loadChartSnapshot.js';
import type { SnapshotClient, SnapshotCategory } from '../../tools/snapshotClient.js';
import { decodeChartSnapshot } from '../../snapshot/decode.js';
import type { ChartSnapshot } from '../../snapshot/types.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type {
    BriefingSnapshot,
    Gap,
    LabHistorySeries,
    RetrieveChartCategory,
} from '../types.js';

/**
 * `retrieveChart` node.
 *
 * **First call** (`state.retrieveChartCallCount === 0`) runs the full
 * fan-out — `loadChartSnapshot` over every category — so the supervisor
 * has chart context to reason over on iteration 1. The fail-closed-on-
 * safety-critical / fail-open-on-informational tiered behavior is owned
 * by the snapshot endpoint server-side: a single decode populates every
 * category slot atomically.
 *
 * **Subsequent calls** (`callCount > 0`) honor the supervisor's
 * `retrieveChartArgs.categories` — the model picks which categories are
 * still missing for the current question and the node fetches only
 * those, narrowing the original fan-out. An empty `categories` list is
 * rejected at the node entry; the supervisor's structured-output schema
 * enforces the same upstream.
 *
 * The supervisor-facing vocabulary uses `'medication'`; the snapshot
 * HTTP client speaks `'prescription'`. The bridge lives in this file
 * only — the supervisor never sees `'prescription'`, the HTTP layer
 * never sees `'medication'`.
 *
 * Deps come in via the factory rather than `LangGraphRunnableConfig`
 * so the graph builder can wire the per-request bearer token before
 * invoking the compiled graph — keeping `AgentPrincipal` clean of the
 * raw token (it doesn't belong in trace tags or other broad-context
 * value objects).
 */

export interface RetrieveChartDeps {
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
     * Cost-projection counters. Optional so existing tests that build a
     * graph without observability wiring still work; production threads
     * this from `briefingRunner`.
     */
    readonly counters?: Counters;
}

/**
 * Bridge the supervisor-facing category enum to the snapshot client's
 * enum. Only `'medication'` differs (architecture-spec wording);
 * everything else is identity. Returns a frozen array so callers cannot
 * mutate the request shape after translation.
 */
const toSnapshotCategories = (
    requested: readonly RetrieveChartCategory[],
): readonly SnapshotCategory[] => {
    return requested.map((c) => (c === 'medication' ? 'prescription' : c));
};

const assembleFullSnapshot = (
    chart: ChartSnapshot,
    labHistory: LabHistorySeries | Gap | null,
): BriefingSnapshot => ({
    patient: chart.patient,
    appointment: chart.appointment,
    diagnoses: chart.diagnoses,
    prescriptions: chart.prescriptions,
    allergies: chart.allergies,
    labs: chart.labs,
    encounters: chart.encounters,
    labHistory,
    reminders: chart.reminders,
    medications: chart.medications,
});

const runFirstCall = async (
    deps: RetrieveChartDeps,
    state: BriefingState,
): Promise<BriefingStateUpdate> => {
    const chart = await loadChartSnapshot({
        client: deps.client,
        token: deps.token,
        siteId: deps.siteId,
        pid: state.envelope.patient.pid,
        ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
    });
    const snapshot = assembleFullSnapshot(chart, null);
    return { snapshot, retrieveChartCallCount: 1 };
};

/**
 * Subsequent-call narrow fetch. Bypasses the `loadChartSnapshot`
 * traceable wrapper because that helper is fixed to the full fan-out;
 * `fetchSnapshot` directly accepts an arbitrary category list. Only
 * the slots matching `args.categories` are overwritten — categories
 * the supervisor *didn't* re-request stay populated from the first
 * call. (The snapshot endpoint always returns every top-level key per
 * `ChartSnapshot::toArray()`, with un-requested categories filled by
 * empty arrays after `PhiMinimizer`. Without selective merge those
 * empties would clobber populated state.)
 */
const runSubsequentCall = async (
    deps: RetrieveChartDeps,
    state: BriefingState,
    args: { readonly categories: readonly RetrieveChartCategory[] },
): Promise<BriefingStateUpdate> => {
    if (args.categories.length === 0) {
        throw new Error('retrieveChart: args.categories must be non-empty');
    }
    const raw = await deps.client.fetchSnapshot({
        pid: state.envelope.patient.pid,
        categories: toSnapshotCategories(args.categories),
        token: deps.token,
        siteId: deps.siteId,
    });
    const partial = decodeChartSnapshot(raw);
    const previous = state.snapshot;
    if (previous === null) {
        return {
            snapshot: assembleFullSnapshot(partial, null),
            retrieveChartCallCount: state.retrieveChartCallCount + 1,
        };
    }
    const requested = new Set<RetrieveChartCategory>(args.categories);
    const merged: BriefingSnapshot = {
        ...previous,
        ...(requested.has('appointment') ? { appointment: partial.appointment } : {}),
        ...(requested.has('diagnosis') ? { diagnoses: partial.diagnoses } : {}),
        ...(requested.has('medication') ? { prescriptions: partial.prescriptions } : {}),
        ...(requested.has('allergy') ? { allergies: partial.allergies } : {}),
        ...(requested.has('lab') ? { labs: partial.labs } : {}),
        ...(requested.has('encounter') ? { encounters: partial.encounters } : {}),
        ...(requested.has('reminder') ? { reminders: partial.reminders } : {}),
        ...(requested.has('medication_statement') ? { medications: partial.medications } : {}),
    };
    return {
        snapshot: merged,
        retrieveChartCallCount: state.retrieveChartCallCount + 1,
    };
};

export const createRetrieveChart = (
    deps: RetrieveChartDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    return async (state) => {
        const callCount = state.retrieveChartCallCount;
        if (callCount === 0) {
            return runFirstCall(deps, state);
        }
        const args = state.retrieveChartArgs;
        if (args === null) {
            throw new Error(
                'retrieveChart: subsequent invocation requires retrieveChartArgs',
            );
        }
        return runSubsequentCall(deps, state, args);
    };
};
