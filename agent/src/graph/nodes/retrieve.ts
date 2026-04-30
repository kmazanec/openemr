import { getMedications } from '../../tools/getMedications.js';
import { getPatientContext } from '../../tools/getPatientContext.js';
import { getRecentEncounters } from '../../tools/getRecentEncounters.js';
import { getRecentLabs } from '../../tools/getRecentLabs.js';
import type { SnapshotClient } from '../../tools/snapshotClient.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { BriefingSnapshot } from '../types.js';

/**
 * §3.2 `Retrieve` node. Fans out to the four §3.1 tools in parallel.
 * Fail-closed tools (`getPatientContext`, `getMedications`) propagate;
 * fail-open tools (`getRecentLabs`, `getRecentEncounters`) return gaps
 * so `Format` can surface them explicitly.
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
}

export const createRetrieve = (
    deps: RetrieveDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    return async (state) => {
        const pid = state.envelope.patient.pid;
        const args = { client: deps.client, token: deps.token, siteId: deps.siteId, pid };

        const [patientContext, medications, labsResult, encountersResult] = await Promise.all([
            getPatientContext(args),
            getMedications(args),
            getRecentLabs(args),
            getRecentEncounters(args),
        ]);

        const snapshot: BriefingSnapshot = {
            patient: patientContext.patient,
            appointment: null,
            diagnoses: patientContext.diagnoses,
            medications,
            allergies: patientContext.allergies,
            labs: labsResult.kind === 'ok' ? labsResult.labs : labsResult,
            encounters:
                encountersResult.kind === 'ok' ? encountersResult.encounters : encountersResult,
        };

        return { snapshot };
    };
};
