import type { BaseCheckpointSaver } from '@langchain/langgraph';

import { createBriefingGraph, type BriefingGraphDeps } from '../graph/index.js';
import { createAnthropicSynthesizer } from '../graph/nodes/synthesize.js';
import type { Synthesizer } from '../graph/nodes/synthesize.js';
import type { BriefingState } from '../graph/state.js';
import type { RequestEnvelope } from '../graph/types.js';
import type { Counters } from '../observability/counters.js';
import { createLogger } from '../observability/logger.js';
import { buildIdentityTags } from '../observability/traceMetadata.js';
import type { ConversationStore } from '../state/conversationStore.js';
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
    readonly conversationStore: ConversationStore;
    /**
     * §3.5: optional. Wired in production so LangGraph durably persists
     * state under the canonical conversation id; tests omit it and run
     * each invocation as a fresh thread.
     */
    readonly checkpointer?: BaseCheckpointSaver;
    /**
     * §6.1: optional. Production wires an in-memory counters registry so
     * tool latency, model usage, and verification outcomes all reach the
     * same place per (clinician, patient) tuple. Tests can omit and the
     * graph nodes fall back to a noop sink.
     */
    readonly counters?: Counters;
}

export const createBriefingRunner = (deps: BriefingRunnerDeps): BriefingRunner => {
    const logger = createLogger('briefingRunner');
    return async ({ envelope, token }) => {
        // §3.5: resolve the canonical conversation for this (user, patient,
        // appointment?) tuple before running the graph. Subsequent opens by
        // the same actor on the same patient resume the same row, so the
        // LangGraph checkpointer (keyed by thread_id below) replays prior
        // turns instead of starting fresh. UC1 doesn't carry an appointment
        // context — `appointmentId` is null for now; UC2/4 will plumb it.
        const { conversation, created } = await deps.conversationStore.findOrCreate({
            userId: envelope.actor.userId,
            patientPid: envelope.patient.pid,
            appointmentId: null,
        });
        if (created) {
            logger.info(
                { conversationId: conversation.id, userId: envelope.actor.userId, patientPid: envelope.patient.pid },
                'created new conversation row',
            );
        }
        const canonicalEnvelope: RequestEnvelope = {
            ...envelope,
            conversationId: conversation.id,
        };
        const graphDeps: BriefingGraphDeps = {
            retrieve: {
                client: deps.snapshotClient,
                token,
                siteId: envelope.siteId,
                ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
            },
            synthesize: {
                synthesizer: deps.synthesizer,
                ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
            },
            verify: {
                unverifiedClaimsLog: deps.unverifiedClaimsLog,
                ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
            },
            ...(deps.checkpointer !== undefined ? { checkpointer: deps.checkpointer } : {}),
        };
        const graph = createBriefingGraph(graphDeps);
        const tags = buildIdentityTags({
            clinicianId: envelope.actor.userId,
            patientId: envelope.patient.uuid,
        });
        const out: BriefingState = await graph.invoke(
            { envelope: canonicalEnvelope },
            {
                configurable: { thread_id: conversation.id },
                tags: [`clinician:${tags.clinicianHash}`, `patient:${tags.patientHash}`],
                metadata: {
                    site_id: envelope.siteId,
                    task: envelope.task,
                    request_id: envelope.requestId,
                },
            },
        );
        if (deps.counters !== undefined) {
            deps.counters.recordBriefing({
                clinicianId: envelope.actor.userId,
                patientId: envelope.patient.uuid,
            });
        }
        if (out.formatted === null) {
            throw new Error('briefing graph completed without a formatted briefing');
        }
        if (out.persisted === null) {
            throw new Error('briefing graph completed without a persisted record');
        }
        return eventsForBriefing(canonicalEnvelope, out.formatted, out.persisted);
    };
};

export interface ProductionRunnerOptions {
    readonly openEmrBaseUrl: string;
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
    readonly conversationStore: ConversationStore;
    readonly checkpointer: BaseCheckpointSaver;
    readonly counters: Counters;
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
        conversationStore: options.conversationStore,
        checkpointer: options.checkpointer,
        counters: options.counters,
    });
};
