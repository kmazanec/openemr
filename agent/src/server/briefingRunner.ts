import { createBriefingGraph, type BriefingGraphDeps } from '../graph/index.js';
import { createAnthropicSynthesizer } from '../graph/nodes/synthesize.js';
import type { Synthesizer } from '../graph/nodes/synthesize.js';
import type { BriefingState } from '../graph/state.js';
import type { RequestEnvelope } from '../graph/types.js';
import { createSnapshotClient } from '../tools/snapshotClient.js';
import type { SnapshotClient } from '../tools/snapshotClient.js';
import type { UnverifiedClaimsLog } from '../verify/unverifiedClaimsLog.js';

import { eventsForBriefing, type BriefingStreamEvent } from './briefingStream.js';

/**
 * Per-request entry point that runs the briefing graph and produces the
 * §3.4 SSE event sequence. Token comes from the incoming `Authorization`
 * header — `Retrieve` forwards it to OpenEMR's snapshot endpoint, so it
 * never leaves this call frame.
 */
export type BriefingRunner = (input: {
    readonly envelope: RequestEnvelope;
    readonly token: string;
}) => Promise<readonly BriefingStreamEvent[]>;

export interface BriefingRunnerDeps {
    readonly snapshotClient: SnapshotClient;
    readonly synthesizer: Synthesizer;
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
}

export const createBriefingRunner = (deps: BriefingRunnerDeps): BriefingRunner => {
    return async ({ envelope, token }) => {
        const graphDeps: BriefingGraphDeps = {
            retrieve: { client: deps.snapshotClient, token, siteId: envelope.siteId },
            synthesize: { synthesizer: deps.synthesizer },
            verify: { unverifiedClaimsLog: deps.unverifiedClaimsLog },
        };
        const graph = createBriefingGraph(graphDeps);
        const out: BriefingState = await graph.invoke({ envelope });
        if (out.formatted === null) {
            throw new Error('briefing graph completed without a formatted briefing');
        }
        if (out.persisted === null) {
            throw new Error('briefing graph completed without a persisted record');
        }
        return eventsForBriefing(envelope, out.formatted, out.persisted);
    };
};

export interface ProductionRunnerOptions {
    readonly openEmrBaseUrl: string;
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
}

/**
 * Build a runner from environment configuration. Used by `start()` so the
 * route handler never instantiates LLM clients or HTTP clients on its own.
 */
export const buildProductionBriefingRunner = (options: ProductionRunnerOptions): BriefingRunner => {
    const snapshotClient = createSnapshotClient({ baseUrl: options.openEmrBaseUrl });
    const synthesizer = createAnthropicSynthesizer();
    return createBriefingRunner({
        snapshotClient,
        synthesizer,
        unverifiedClaimsLog: options.unverifiedClaimsLog,
    });
};
