import { vi } from 'vitest';

import type { SnapshotClient } from '../../src/tools/snapshotClient.js';

/**
 * Test helpers for the four §3.1 tools. Each tool needs a `SnapshotClient`
 * with a controllable `fetchSnapshot` — and assertions on call args have
 * to dodge `@typescript-eslint/unbound-method` by holding the spy directly.
 */

export interface MockClient {
    readonly client: SnapshotClient;
    readonly fetch: ReturnType<typeof vi.fn>;
}

export const mockClientResolving = (value: unknown): MockClient => {
    const fetch = vi.fn().mockResolvedValue(value);
    return { client: { fetchSnapshot: fetch as SnapshotClient['fetchSnapshot'] }, fetch };
};

export const mockClientRejecting = (err: unknown): MockClient => {
    const fetch = vi.fn().mockRejectedValue(err);
    return { client: { fetchSnapshot: fetch as SnapshotClient['fetchSnapshot'] }, fetch };
};
