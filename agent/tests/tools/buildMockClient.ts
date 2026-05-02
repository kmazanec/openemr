import { vi } from 'vitest';

import type { AgentHttpClient } from '../../src/tools/agentHttp.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';

/**
 * Test helpers for the §3.1 tools.
 *
 * The four narrow tools (getPrescriptions, getRecentLabs,
 * getRecentEncounters, getPatientContext) take an
 * {@link AgentHttpClient}; the briefing-path `loadChartSnapshot`
 * still takes a {@link SnapshotClient}. Helpers for both keep the
 * test surface tight.
 */

export interface MockAgentHttpClient {
    readonly client: AgentHttpClient;
    readonly get: ReturnType<typeof vi.fn>;
}

export const mockAgentHttpResolving = (value: unknown): MockAgentHttpClient => {
    const get = vi.fn().mockResolvedValue(value);
    return { client: { get: get as AgentHttpClient['get'] }, get };
};

export const mockAgentHttpRejecting = (err: unknown): MockAgentHttpClient => {
    const get = vi.fn().mockRejectedValue(err);
    return { client: { get: get as AgentHttpClient['get'] }, get };
};

export interface MockSnapshotClient {
    readonly client: SnapshotClient;
    readonly fetch: ReturnType<typeof vi.fn>;
}

export const mockClientResolving = (value: unknown): MockSnapshotClient => {
    const fetch = vi.fn().mockResolvedValue(value);
    return { client: { fetchSnapshot: fetch as SnapshotClient['fetchSnapshot'] }, fetch };
};

export const mockClientRejecting = (err: unknown): MockSnapshotClient => {
    const fetch = vi.fn().mockRejectedValue(err);
    return { client: { fetchSnapshot: fetch as SnapshotClient['fetchSnapshot'] }, fetch };
};
