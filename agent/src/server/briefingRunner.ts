import type { BaseCheckpointSaver } from '@langchain/langgraph';

import { createBriefingGraph, type BriefingGraphDeps } from '../graph/index.js';
import { createLabHistoryFetcher, type LabHistoryFetcher } from '../graph/nodes/retrieve.js';
import { createAnthropicSynthesizer } from '../graph/nodes/synthesize.js';
import type { Synthesizer } from '../graph/nodes/synthesize.js';
import type { BriefingState } from '../graph/state.js';
import type { RequestEnvelope } from '../graph/types.js';
import type { Counters } from '../observability/counters.js';
import { createLogger } from '../observability/logger.js';
import { buildIdentityTags } from '../observability/traceMetadata.js';
import type { ConversationMessagesStore } from '../state/conversationMessages.js';
import type { ConversationStore } from '../state/conversationStore.js';
import type { ConversationSuggestionStore } from '../state/conversationSuggestions.js';
import { createAgentHttpClient } from '../tools/agentHttp.js';
import type { AgentHttpClient } from '../tools/agentHttp.js';
import { createSnapshotClient } from '../tools/snapshotClient.js';
import type { SnapshotClient } from '../tools/snapshotClient.js';
import type { UnverifiedClaimsLog } from '../verify/unverifiedClaimsLog.js';

import { eventsForBriefing, type BriefingStreamEvent } from './briefingStream.js';

/**
 * Per-request entry point that runs the briefing graph and produces the
 * §3.4 SSE event sequence. Token comes from the incoming `Authorization`
 * header — `Retrieve` forwards it to OpenEMR's snapshot endpoint, so it
 * never leaves this call frame.
 *
 * Contract by task (§4.6):
 *
 *   - `default_briefing` always mints a fresh conversation row. Any
 *     `conversationId` in the envelope is ignored — a default briefing
 *     is, by definition, the start of a new conversation. (Resume of an
 *     existing conversation is handled out-of-band by the panel via
 *     `GET /v1/agent/latest_conversation`; that path does NOT call the
 *     runner.)
 *
 *   - `follow_up` requires a UUID `conversationId` whose row is owned
 *     by the principal and scoped to the same patient. We re-check
 *     ownership against the store before appending so a leaked or
 *     guessed UUID can't smuggle a turn into someone else's thread.
 *     Both failures surface as a typed runner error which the SSE
 *     route maps to `invalid_envelope`.
 */
export type BriefingRunner = (input: {
    readonly envelope: RequestEnvelope;
    readonly token: string;
}) => Promise<readonly BriefingStreamEvent[]>;

export interface BriefingRunnerDeps {
    readonly snapshotClient: SnapshotClient;
    readonly synthesizer: Synthesizer;
    /**
     * §4.3 narrow-tool HTTP client. Used by the medication-change
     * graph branch to fetch prescription provenance. Optional so the
     * runner is backwards-compatible — tests that don't exercise UC3
     * may omit it, and the graph routes follow-ups through the
     * synthesizer when missing.
     */
    readonly agentHttpClient?: AgentHttpClient;
    /**
     * §4.3: OpenEMR base URL the medication-change branch composes
     * narrow-endpoint URLs against. Required when `agentHttpClient`
     * is set; ignored otherwise.
     */
    readonly openEmrBaseUrl?: string;
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
    readonly conversationStore: ConversationStore;
    /**
     * §4.2: lab-history fetcher for the UC2 trend path. Optional —
     * tests that don't drive a `lab_trend` envelope can omit it; if
     * a `lab_trend` turn arrives without a fetcher wired, Retrieve
     * files a `fetcher-unwired` gap so the graph still completes.
     */
    readonly fetchLabHistory?: LabHistoryFetcher;
    /**
     * §4.6: read-side store for the rendered conversation thread.
     * Append-only; written here on every persisted turn so the resume
     * endpoint and a future history UI can replay the conversation.
     */
    readonly conversationMessages: ConversationMessagesStore;
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
    /**
     * Persisted suggestion-chip set per default-briefing turn. Optional —
     * when omitted, the runner skips the chip recording (defense-in-depth
     * is degraded but the user-visible turn still completes). Production
     * always wires this and pairs it with the route-level validation.
     */
    readonly conversationSuggestions?: ConversationSuggestionStore;
}

/**
 * Typed contract violation: the envelope is structurally OK (passed the
 * Zod check at the route boundary) but doesn't satisfy the per-task
 * runner contract — e.g. a follow-up without a conversationId, or with
 * a UUID the principal does not own. The route handler maps this to
 * the SSE `invalid_envelope` error code so the browser shows the same
 * generic "request was malformed" message rather than a leaky reason.
 *
 * The reason field is for log/trace correlation only; never surface
 * it to the client.
 */
export class BriefingContractError extends Error {
    public readonly reason: string;
    public constructor(reason: string) {
        super(`briefing contract: ${reason}`);
        this.name = 'BriefingContractError';
        this.reason = reason;
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

export const createBriefingRunner = (deps: BriefingRunnerDeps): BriefingRunner => {
    const logger = createLogger('briefingRunner');
    return async ({ envelope, token }) => {
        // Resolve the conversation row for this turn based on the task.
        // Default briefings always mint; follow-ups must target an
        // existing row the principal owns.
        let conversationId: string;
        if (envelope.task === 'default_briefing') {
            const created = await deps.conversationStore.create({
                userId: envelope.actor.userId,
                patientPid: envelope.patient.pid,
                appointmentId: null,
            });
            conversationId = created.id;
            logger.info(
                { conversationId, userId: envelope.actor.userId, patientPid: envelope.patient.pid },
                'created new conversation row',
            );
        } else {
            // Follow-up: require a UUID and verify ownership.
            const claimed = envelope.conversationId;
            if (!isUuid(claimed)) {
                throw new BriefingContractError('follow_up without authoritative conversationId');
            }
            const owned = await deps.conversationStore.findOwnedById(
                claimed,
                envelope.actor.userId,
                envelope.patient.pid,
            );
            if (owned === null) {
                logger.warn(
                    {
                        conversationId: claimed,
                        userId: envelope.actor.userId,
                        patientPid: envelope.patient.pid,
                    },
                    'follow_up rejected — conversation not owned by principal or wrong patient',
                );
                throw new BriefingContractError('follow_up conversation not owned by principal');
            }
            conversationId = owned.id;
        }
        const canonicalEnvelope: RequestEnvelope = {
            ...envelope,
            conversationId,
        };

        // §4.6: persist the user turn (free-text follow-up) before the
        // graph runs, so a mid-flight failure still leaves the question
        // visible on resume. Default-briefing turns have no user text.
        if (canonicalEnvelope.task === 'follow_up' && typeof canonicalEnvelope.question === 'string') {
            await deps.conversationMessages.append({
                conversationId,
                role: 'user',
                text: canonicalEnvelope.question,
            });
            await deps.conversationStore.touch(conversationId);
        }

        const graphDeps: BriefingGraphDeps = {
            retrieve: {
                client: deps.snapshotClient,
                token,
                siteId: envelope.siteId,
                ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
                ...(deps.fetchLabHistory !== undefined ? { fetchLabHistory: deps.fetchLabHistory } : {}),
            },
            synthesize: {
                synthesizer: deps.synthesizer,
                ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
            },
            verify: {
                unverifiedClaimsLog: deps.unverifiedClaimsLog,
                ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
            },
            // §4.3: wire the UC3 medication-change branch when the
            // narrow-tool HTTP client is available. Both must be set
            // for the branch to fire — otherwise medication_change
            // follow-ups fall back to the synthesizer path.
            ...(deps.agentHttpClient !== undefined && deps.openEmrBaseUrl !== undefined
                ? {
                    medChange: {
                        client: deps.agentHttpClient,
                        token,
                        siteId: envelope.siteId,
                        openEmrBaseUrl: deps.openEmrBaseUrl,
                        ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
                    },
                }
                : {}),
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
                configurable: { thread_id: conversationId },
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

        // §4.6: persist the assistant turn after the graph (and the
        // verification gate inside it) finishes. `out.formatted` is the
        // post-verifier AssistantMessage, so anything we mirror here is
        // already cleared for the renderer.
        await deps.conversationMessages.append({
            conversationId,
            role: 'assistant',
            message: out.formatted,
        });
        await deps.conversationStore.touch(conversationId);

        // Record the suggestion-chip IDs offered on a default-briefing
        // turn. Validation is the route's job; this side-channel only has
        // to land before the next user turn arrives, so failures are
        // logged-and-swallowed — the panel still gets its briefing, and
        // the next follow-up will fail closed against the missing chip set.
        if (
            canonicalEnvelope.task === 'default_briefing'
            && deps.conversationSuggestions !== undefined
            && out.formatted.suggestedFollowUps.length > 0
        ) {
            const chipIds = out.formatted.suggestedFollowUps.map((s) => s.id);
            try {
                await deps.conversationSuggestions.record({
                    conversationId,
                    requestId: canonicalEnvelope.requestId,
                    chipIds,
                });
            } catch (err: unknown) {
                logger.warn(
                    {
                        err,
                        conversationId,
                        requestId: canonicalEnvelope.requestId,
                        chipCount: chipIds.length,
                    },
                    'failed to record suggested-follow-up chip IDs; continuing',
                );
            }
        }

        return eventsForBriefing(canonicalEnvelope, out.formatted, out.persisted);
    };
};

export interface ProductionRunnerOptions {
    readonly openEmrBaseUrl: string;
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
    readonly conversationStore: ConversationStore;
    readonly conversationMessages: ConversationMessagesStore;
    readonly conversationSuggestions: ConversationSuggestionStore;
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
    // A single AgentHttpClient powers all narrow tools (UC2's
    // `getLabHistory`, UC3's `getMedicationProvenance`, future
    // ones). Keeps the bulk-snapshot client's wiring untouched and
    // gives the narrow tools their own retry policy + tracing
    // namespace under one logger.
    const narrowHttpClient = createAgentHttpClient({ loggerName: 'narrowHttp' });
    const fetchLabHistory = createLabHistoryFetcher({
        client: narrowHttpClient,
        openEmrBaseUrl: options.openEmrBaseUrl,
    });
    return createBriefingRunner({
        snapshotClient,
        synthesizer,
        agentHttpClient: narrowHttpClient,
        openEmrBaseUrl: options.openEmrBaseUrl,
        unverifiedClaimsLog: options.unverifiedClaimsLog,
        conversationStore: options.conversationStore,
        conversationMessages: options.conversationMessages,
        conversationSuggestions: options.conversationSuggestions,
        checkpointer: options.checkpointer,
        counters: options.counters,
        fetchLabHistory,
    });
};
