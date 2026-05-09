import type { BaseCheckpointSaver } from '@langchain/langgraph';

import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

import { createBriefingGraph, type BriefingGraphDeps } from '../graph/index.js';
import type { DocumentEvidenceRetrieverDeps } from '../graph/nodes/documentEvidenceRetriever.js';
import type { EvidenceRetrieverDeps } from '../graph/nodes/evidenceRetriever.js';
import {
    createAnthropicSupervisorDecide,
    type SupervisorDeps,
} from '../graph/nodes/supervisor.js';
import { createAnthropicSynthesizer } from '../graph/nodes/synthesize.js';
import type { Synthesizer } from '../graph/nodes/synthesize.js';
import type { BriefingState } from '../graph/state.js';
import type { RequestEnvelope } from '../graph/types.js';
import type { Counters } from '../observability/counters.js';
import { createLogger } from '../observability/logger.js';
import { buildIdentityTags } from '../observability/traceMetadata.js';
import { createCohereRerankClient } from '../retrievers/cohere.js';
import { loadCorpusBM25Stats } from '../retrievers/corpusLoader.js';
import { createPineconeRetriever } from '../retrievers/pinecone.js';
import type { ConversationMessagesStore } from '../state/conversationMessages.js';
import type { ConversationStore } from '../state/conversationStore.js';
import type { ExtractionArtifactStore } from '../state/extractionArtifacts.js';
import type { PipelineStreamEvent } from './pipelineStream.js';
import type { PipelineRunner } from './routes/extract.js';
import type { AgentHttpClient } from '../tools/agentHttp.js';
import { createAgentHttpClient } from '../tools/agentHttp.js';
import { createSnapshotClient } from '../tools/snapshotClient.js';
import type { SnapshotClient } from '../tools/snapshotClient.js';
import type { UnverifiedClaimsLog } from '../verify/unverifiedClaimsLog.js';

import {
    PROGRESS_STAGES,
    completedEvent,
    stageForNode,
    startedEvent,
} from './briefingProgress.js';
import { eventsForBriefing, type BriefingStreamEvent, type ProgressStage } from './briefingStream.js';
import { enrichPendingUploadsWithChartDocuments } from './enrichPendingUploads.js';
import { prepareBriefingState } from './prepareBriefingState.js';

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
    /**
     * §5.3: extra LangSmith run metadata merged into the graph
     * invocation's metadata block. Used by the precompute path to set
     * `precompute: true` so the dashboard rolls up morning-prep cost
     * separately from interactive briefings. Keys here must be
     * non-PHI — the metadata object is uploaded to LangSmith.
     */
    readonly extraMetadata?: Readonly<Record<string, string | number | boolean>>;
    /**
     * Live event sink for the SSE route. When set, the runner pushes
     * each `BriefingStreamEvent` (meta, progress, assistantMessage,
     * done) through this callback as it happens — the panel sees
     * stage-by-stage progress instead of a single batch at the end.
     *
     * When omitted, all events are buffered and returned in the
     * resolved array exactly like the pre-streaming runner. The
     * precompute route uses the buffered path (it only needs the
     * terminal `assistantMessage`/`done` events) and tests can omit
     * it for deterministic snapshotting.
     */
    readonly onEvent?: (event: BriefingStreamEvent) => Promise<void> | void;
}) => Promise<readonly BriefingStreamEvent[]>;

export interface BriefingRunnerDeps {
    readonly snapshotClient: SnapshotClient;
    readonly synthesizer: Synthesizer;
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
    readonly conversationStore: ConversationStore;
    /**
     * Read-side store for the rendered conversation thread.
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
     * LLM-driven supervisor. When wired, the conversational graph routes
     * through the model-backed supervisor manifest; when omitted, the
     * graph falls back to a default `decide` that short-circuits to
     * `synthesize`. Production always wires this; per-MR Vitest cases
     * inject a deterministic stub.
     */
    readonly supervisor?: SupervisorDeps;
    /**
     * §C.3 evidence retriever (Pinecone hybrid + Cohere rerank). When
     * wired, the supervisor can pick `evidenceRetriever` and the
     * synthesizer sees guideline snippets in the prompt. Omit when the
     * upstream credentials/index aren't available — the graph falls
     * back to the C.3 stub and guideline-typed claims fail verification.
     */
    readonly evidenceRetriever?: EvidenceRetrieverDeps;
    /**
     * §C.1 document evidence retriever. When wired, the supervisor can
     * pick `documentEvidenceRetriever` and the synthesizer sees
     * extraction-fact snippets for previously uploaded documents.
     */
    readonly documentEvidenceRetriever?: DocumentEvidenceRetrieverDeps;
    /**
     * §B.9 ingestion pipeline runner. When set, the briefing graph's
     * `kickoffExtraction` handoff calls into this runner synchronously
     * for path A (panel upload during a conversation). Optional —
     * tests omit it and the A.7 stub continues to run, so the
     * conversational graph compiles end-to-end without a full
     * pipeline boot.
     *
     * Production wires the same `PipelineRunner` instance into both
     * the `/v1/agent/extract` route and this slot so the two callers
     * share one factory.
     */
    readonly pipeline?: PipelineRunner;
    /**
     * Chart-document discovery seam. When wired, the runner queries
     * OpenEMR's `documents` table for Clinical-Copilot-categorized
     * chart documents and splices unprocessed ones onto
     * `envelope.pendingUploads` before the graph runs. Optional —
     * tests that don't exercise this path can omit it; the briefing
     * runs without enrichment and behaves as it did before the fix.
     *
     * Both `httpClient` and `extractionArtifactStore` are required
     * together: the HTTP client fetches the chart-document list from
     * OpenEMR's MySQL via the snapshot endpoint, and the store
     * filters out already-extracted documents on the agent's
     * Postgres. Each side stays responsible for its own database.
     */
    readonly chartDocumentDiscovery?: {
        readonly httpClient: AgentHttpClient;
        readonly extractionArtifactStore: ExtractionArtifactStore;
        readonly openEmrBaseUrl: string;
    };
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
    return async ({ envelope, token, extraMetadata, onEvent }) => {
        // Two transport modes: when `onEvent` is set, push events
        // through it as they happen (live SSE) and return an empty
        // array so the route's legacy `for (event of events)` loop
        // doesn't double-emit. When `onEvent` is omitted, accumulate
        // every event into a buffer and return it — keeps the
        // pre-streaming contract intact for the precompute path and
        // for tests that mock the runner without a callback.
        const buffer: BriefingStreamEvent[] = [];
        const emit = async (event: BriefingStreamEvent): Promise<void> => {
            if (onEvent !== undefined) {
                await onEvent(event);
            } else {
                buffer.push(event);
            }
        };
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
        let canonicalEnvelope: RequestEnvelope = {
            ...envelope,
            conversationId,
        };

        // Discover Clinical-Copilot-categorized chart documents that
        // haven't been extracted yet and splice them onto
        // `pendingUploads`. The supervisor's existing routing rule
        // ("when pendingUploads has an unprocessed entry, fire
        // kickoffExtraction") then handles chart-uploaded documents
        // exactly the way it handles chat-panel uploads. Best-effort:
        // failures fail open and the briefing proceeds with the
        // un-enriched envelope.
        if (deps.chartDocumentDiscovery !== undefined) {
            canonicalEnvelope = await enrichPendingUploadsWithChartDocuments(
                {
                    httpClient: deps.chartDocumentDiscovery.httpClient,
                    extractionArtifactStore: deps.chartDocumentDiscovery.extractionArtifactStore,
                    openEmrBaseUrl: deps.chartDocumentDiscovery.openEmrBaseUrl,
                    logger,
                },
                { envelope: canonicalEnvelope, token },
            );
        }

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
            retrieveChart: {
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
            ...(deps.supervisor !== undefined ? { supervisor: deps.supervisor } : {}),
            ...(deps.evidenceRetriever !== undefined
                ? { evidenceRetriever: deps.evidenceRetriever }
                : {}),
            ...(deps.documentEvidenceRetriever !== undefined
                ? { documentEvidenceRetriever: deps.documentEvidenceRetriever }
                : {}),
            // §B.9: when a pipeline runner is wired, the supervisor's
            // `kickoffExtraction` handoff invokes the production
            // pipeline synchronously. Pipeline events forward through
            // `onPipelineEvent` so the panel sees the same
            // `pipeline.*.complete` chips it would on the
            // `/v1/agent/extract` path.
            ...(deps.pipeline !== undefined
                ? {
                    kickoffExtraction: {
                        pipeline: deps.pipeline,
                        openemrToken: token,
                        openemrSiteId: envelope.siteId,
                        conversationId,
                        onPipelineEvent: async (event: PipelineStreamEvent) => {
                            await emit({ type: 'pipelineEvent', event });
                        },
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
        // W2 §"Conversational graph": loadState/planContext are no
        // longer graph nodes. The runner-side seed validates the task
        // (defense-in-depth against an unknown-task envelope reaching
        // the graph), projects `conversation_messages` into the §A.5
        // `priorTurnContext` slot, and produces the BriefingState
        // slot map the graph invokes against.
        const initialState = await prepareBriefingState({
            envelope: canonicalEnvelope,
            conversationMessages: deps.conversationMessages,
            logger,
        });
        // Emit `meta` first so the panel adopts the canonical
        // conversationId before any progress paints.
        await emit({
            type: 'meta',
            conversationId: canonicalEnvelope.conversationId,
            requestId: canonicalEnvelope.requestId,
            siteId: canonicalEnvelope.siteId,
        });
        // Open the first user-visible stage immediately so the panel
        // shows progress as soon as the stream starts.
        await emit(startedEvent('retrieve'));
        let openStage: ProgressStage | null = 'retrieve';

        // Stream the graph in `updates` mode so we see one chunk per
        // node completion, plus `values` mode so the final chunk
        // carries the full BriefingState. The values chunks are also
        // the easiest way to recover the terminal state without
        // re-running the graph.
        const stream = await graph.stream(
            initialState,
            {
                configurable: { thread_id: conversationId },
                tags: [`clinician:${tags.clinicianHash}`, `patient:${tags.patientHash}`],
                metadata: {
                    site_id: envelope.siteId,
                    task: envelope.task,
                    request_id: envelope.requestId,
                    ...(extraMetadata ?? {}),
                },
                streamMode: ['updates', 'values'],
            },
        );

        let finalState: BriefingState | null = null;
        for await (const chunk of stream) {
            // With `streamMode` as a 2-element array, each chunk is a
            // `[mode, payload]` tuple. `updates` payloads are
            // `{nodeName: nodeReturn}`; `values` payloads are the full
            // accumulated state at that step.
            if (!Array.isArray(chunk) || chunk.length !== 2) continue;
            const [mode, payload] = chunk as [string, unknown];
            if (mode === 'updates' && payload !== null && typeof payload === 'object') {
                // Supervisor narration: each supervisor decision appends
                // one entry to `supervisorDecisionHistory`. Project the
                // newest entry's `narration` + `handoff` into a
                // `supervisorNarration` SSE event so the panel can show
                // the model-decided next-step text instead of (or
                // alongside) a fixed stage label. Skip when the
                // decision is `synthesize` — the assistant message
                // landing right after is its own end-of-turn signal,
                // and a duplicate "Drafting your briefing." line right
                // before it just adds noise.
                const supervisorPayload = (payload as Record<string, unknown>)['supervisor'];
                if (
                    supervisorPayload !== undefined
                    && supervisorPayload !== null
                    && typeof supervisorPayload === 'object'
                ) {
                    const history = (supervisorPayload as Record<string, unknown>)[
                        'supervisorDecisionHistory'
                    ];
                    if (Array.isArray(history) && history.length > 0) {
                        const latest: unknown = history[history.length - 1];
                        if (
                            latest !== null
                            && typeof latest === 'object'
                            && typeof (latest as Record<string, unknown>)['handoff'] === 'string'
                            && typeof (latest as Record<string, unknown>)['narration'] === 'string'
                        ) {
                            const handoff = (latest as Record<string, unknown>)['handoff'] as string;
                            const text = (latest as Record<string, unknown>)['narration'] as string;
                            if (handoff !== 'synthesize') {
                                await emit({ type: 'supervisorNarration', handoff, text });
                            }
                        }
                    }
                }
                for (const nodeName of Object.keys(payload)) {
                    const completedStage = stageForNode(nodeName);
                    if (completedStage === null) continue;
                    const completedIdx = PROGRESS_STAGES.indexOf(completedStage);
                    const openIdx = openStage === null
                        ? -1
                        : PROGRESS_STAGES.indexOf(openStage);
                    if (completedIdx < openIdx) {
                        // A second branch under the same stage finished
                        // (e.g. UC2/UC3/UC4 fan-out). Don't double-emit.
                        continue;
                    }
                    // Close every open stage up through `completedStage`.
                    // In practice the runner advances one stage at a time
                    // because the graph is sequential, so this loop fires
                    // once. The bounded loop is defense-in-depth in case a
                    // future graph rev skips a stage entirely.
                    for (let i = Math.max(openIdx, 0); i <= completedIdx; i++) {
                        const stage = PROGRESS_STAGES[i];
                        if (stage === undefined) continue;
                        if (i > openIdx) {
                            // Stage we never explicitly opened — open it
                            // before closing so the renderer's stage list
                            // doesn't have a gap.
                            await emit(startedEvent(stage));
                        }
                        await emit(completedEvent(stage));
                    }
                    // Open the next stage so the renderer shows its
                    // spinner immediately, even before the next node
                    // returns. The final stage (`format`) has no
                    // successor, so we just leave openStage at it.
                    const nextIdx = completedIdx + 1;
                    const nextStage = PROGRESS_STAGES[nextIdx];
                    if (nextStage !== undefined) {
                        await emit(startedEvent(nextStage));
                        openStage = nextStage;
                    } else {
                        openStage = null;
                    }
                }
            } else if (mode === 'values') {
                finalState = payload as BriefingState;
            }
        }
        if (finalState === null) {
            throw new Error('briefing graph completed without a final state');
        }
        const out: BriefingState = finalState;
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

        // We emitted `meta` up-front, plus interleaved `progress`
        // events as the graph ran. Now flush the terminal pair
        // (`assistantMessage`, `done`) — `eventsForBriefing` would
        // re-emit `meta` so we slice it off.
        const tail = eventsForBriefing(canonicalEnvelope, out.formatted, out.persisted)
            .filter((e) => e.type !== 'meta');
        for (const event of tail) {
            await emit(event);
        }
        return buffer;
    };
};

export interface ProductionRunnerOptions {
    readonly openEmrBaseUrl: string;
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
    readonly conversationStore: ConversationStore;
    readonly conversationMessages: ConversationMessagesStore;
    readonly checkpointer: BaseCheckpointSaver;
    readonly counters: Counters;
    /**
     * §C.1 store seam for the document-evidence retriever. Already
     * constructed at boot for the ingestion pipeline; passed through so
     * the briefing graph can use the same Postgres-backed implementation.
     */
    readonly extractionArtifactStore: ExtractionArtifactStore;
    /**
     * §B.9 ingestion pipeline runner — same instance the
     * `/v1/agent/extract` route consumes. When set, the supervisor's
     * `kickoffExtraction` handoff fires the real pipeline; when
     * omitted, the §A.7 stub continues to no-op so the briefing
     * runner is still constructible in environments where the
     * pipeline boot prerequisites aren't met (e.g. the precompute
     * route running without `SPACES_*` env vars).
     */
    readonly pipeline?: PipelineRunner;
}

/**
 * Build the §C.3 evidence retriever's vendor clients from environment
 * configuration. Returns `null` when any required key is missing — the
 * runner then falls back to the A.7 stub, which is the right behavior
 * for non-cloud-credential setups (CI sandboxes, local-dev without a
 * Pinecone account). Logs the missing-key list once at boot so an
 * operator who expected guideline retrieval to be on can see why it
 * isn't.
 */
const buildEvidenceRetrieverDeps = async (): Promise<EvidenceRetrieverDeps | null> => {
    const logger = createLogger('briefingRunner');
    const openaiKey = process.env['OPENAI_API_KEY'] ?? '';
    const pineconeKey = process.env['PINECONE_API_KEY'] ?? '';
    const indexName = process.env['PINECONE_INDEX_NAME'] ?? '';
    const cohereKey = process.env['COHERE_API_KEY'] ?? '';
    const namespace = process.env['PINECONE_NAMESPACE'] ?? 'guidelines-v1';

    const missing: string[] = [];
    if (openaiKey.length === 0) missing.push('OPENAI_API_KEY');
    if (pineconeKey.length === 0) missing.push('PINECONE_API_KEY');
    if (indexName.length === 0) missing.push('PINECONE_INDEX_NAME');
    if (cohereKey.length === 0) missing.push('COHERE_API_KEY');
    if (missing.length > 0) {
        logger.warn(
            { missing },
            'evidenceRetriever deps not wired — set the listed env vars to enable guideline retrieval',
        );
        return null;
    }

    // Boot-time corpus load. The BM25 stats fitted here must match what
    // the index-time `grounding:reindex-corpus` script wrote — `bm25.ts`'s
    // weights are query-side adjustable but the doc-side weights are
    // baked into Pinecone.
    const { stats, chunkCount } = await loadCorpusBM25Stats();
    if (chunkCount === 0) {
        logger.warn(
            'evidenceRetriever corpus is empty — guideline retrieval will return no hits',
        );
    } else {
        logger.info({ chunkCount }, 'evidenceRetriever BM25 stats fitted');
    }

    const openai = new OpenAI({ apiKey: openaiKey });
    const pinecone = new Pinecone({ apiKey: pineconeKey });
    const pineconeRetriever = createPineconeRetriever({
        pinecone,
        indexName,
        namespace,
        embeddings: openai.embeddings,
        bm25Stats: stats,
    });
    const cohereRerank = createCohereRerankClient({ apiKey: cohereKey });
    return { pineconeRetriever, cohereRerank };
};

/**
 * Build a runner from environment configuration. Used by `start()` so the
 * route handler never instantiates LLM clients or HTTP clients on its own.
 *
 * Async because the §C.3 evidence retriever needs the BM25 corpus loaded
 * before any briefing can fan out into Pinecone — fitting stats lazily
 * on the first turn would couple boot ordering to an arbitrary user
 * action and double-load the corpus on a cold parallel burst.
 */
export const buildProductionBriefingRunner = async (
    options: ProductionRunnerOptions,
): Promise<BriefingRunner> => {
    const snapshotClient = createSnapshotClient({ baseUrl: options.openEmrBaseUrl });
    const synthesizer = createAnthropicSynthesizer();
    // LLM supervisor. The architecture pins this as the production
    // router across the handoff manifest — without it the graph runs the
    // fallback `decide` which never picks `evidenceRetriever`, so every
    // follow-up bypasses guideline retrieval. Sonnet is the default per
    // the price-vs-routing-accuracy tradeoff in the supervisor module.
    const supervisor: SupervisorDeps = {
        decide: createAnthropicSupervisorDecide(),
        counters: options.counters,
    };

    const evidenceRetriever = await buildEvidenceRetrieverDeps();
    const documentEvidenceRetriever: DocumentEvidenceRetrieverDeps = {
        store: options.extractionArtifactStore,
    };

    // Chart-side document discovery. Reuses the same OpenEMR base URL
    // every other snapshot tool uses; a dedicated logger-name on the
    // HTTP client lets operators distinguish chart-doc 5xx's from
    // briefing-snapshot 5xx's in the agent log.
    const chartDocumentDiscovery = {
        httpClient: createAgentHttpClient({ loggerName: 'agentHttp:chart-documents' }),
        extractionArtifactStore: options.extractionArtifactStore,
        openEmrBaseUrl: options.openEmrBaseUrl,
    };

    return createBriefingRunner({
        snapshotClient,
        synthesizer,
        unverifiedClaimsLog: options.unverifiedClaimsLog,
        conversationStore: options.conversationStore,
        conversationMessages: options.conversationMessages,
        checkpointer: options.checkpointer,
        counters: options.counters,
        supervisor,
        documentEvidenceRetriever,
        chartDocumentDiscovery,
        ...(evidenceRetriever !== null ? { evidenceRetriever } : {}),
        ...(options.pipeline !== undefined ? { pipeline: options.pipeline } : {}),
    });
};
