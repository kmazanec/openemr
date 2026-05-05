import type { Counters } from '../../observability/counters.js';
import type { AgentHttpClient } from '../../tools/agentHttp.js';
import { getLabHistory, type GetLabHistoryInput } from '../../tools/getLabHistory.js';
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
 * Default lookback for the UC2 lab-history fan-out. Two years matches
 * how clinicians read A1c/lipid/eGFR trends — long enough to span
 * pre/post a prescription change, short enough to not drown the model
 * in irrelevant rows.
 */
export const UC2_LAB_HISTORY_LOOKBACK_DAYS = 730;

/**
 * §A.4 `retrieveChart` node (renamed from W1's `retrieve`).
 *
 * **First call** (`state.retrieveChartCallCount === 0`) runs the W1
 * full fan-out — `loadChartSnapshot` over every category — so the A.7
 * supervisor has chart context to reason over on iteration 1. The W1
 * fail-closed-on-safety-critical / fail-open-on-informational tiered
 * behavior is unchanged: the snapshot endpoint already fans out
 * server-side and either returns the full payload or 5xx's, so a single
 * decode populates every category slot atomically.
 *
 * **Subsequent calls** (`callCount > 0`) honor the supervisor's
 * `retrieveChartArgs.categories` — the model picks which categories are
 * still missing for the current question and the node fetches only
 * those, narrowing the original fan-out. An empty `categories` list is
 * rejected at the node entry; A.7's structured-output schema enforces
 * the same upstream.
 *
 * The supervisor-facing vocabulary uses `'medication'` (per
 * `W2_ARCHITECTURE.md` §"retrieveChart"); the snapshot HTTP client
 * speaks `'prescription'`. The bridge lives in this file only — the
 * supervisor never sees `'prescription'`, the HTTP layer never sees
 * `'medication'`.
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

const fetchLabHistoryIfRequested = async (
    deps: RetrieveChartDeps,
    state: BriefingState,
): Promise<LabHistorySeries | Gap | null> => {
    const followUp = state.envelope.followUp;
    if (followUp?.type !== 'lab_trend') {
        return null;
    }
    if (deps.fetchLabHistory === undefined) {
        return labHistoryUnavailable(
            'fetcher-unwired',
            'Lab history is not available right now.',
        );
    }
    const result = await deps.fetchLabHistory({
        token: deps.token,
        siteId: deps.siteId,
        pid: state.envelope.patient.pid,
        analyte: followUp.analyte,
        lookbackDays: UC2_LAB_HISTORY_LOOKBACK_DAYS,
        ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
    });
    return result.kind === 'ok'
        ? { analyte: followUp.analyte, observations: result.labs }
        : { kind: 'gap', reason: result.reason, message: result.message };
};

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
    const labHistory = await fetchLabHistoryIfRequested(deps, state);
    const snapshot = assembleFullSnapshot(chart, labHistory);
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
