import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import {
    createBearerAuthMiddleware,
    getPrincipal,
    getRawToken,
    type BearerAuthMiddlewareOptions,
} from '../auth/middleware.js';
import { createLocalKeyResolver, createRemoteKeyResolver } from '../auth/jwks.js';
import { createAgentJwtVerifier, type AgentJwtVerifier } from '../auth/verify.js';
import type { AssistantMessage, RequestEnvelope, SuggestedFollowUpParams } from '../graph/types.js';
import { createInMemoryCounters } from '../observability/counters.js';
import { createLogger } from '../observability/logger.js';
import { createCheckpointer } from '../state/checkpointer.js';
import { runMigrations } from '../state/migrations.js';
import {
    createPgConversationMessagesStore,
    type ConversationMessagesStore,
} from '../state/conversationMessages.js';
import {
    createPgConversationStore,
    type ConversationStore,
} from '../state/conversationStore.js';
import {
    createPgConversationSuggestionStore,
    type ConversationSuggestionStore,
} from '../state/conversationSuggestions.js';
import {
    createPgScheduleBriefingsLog,
    type ScheduleBriefingsLog,
} from '../state/scheduleBriefings.js';
import { stableId } from '../graph/followUps.js';
import { createPgUnverifiedClaimsLog } from '../verify/unverifiedClaimsLog.js';
import type { JWK } from 'jose';

import { encodeStreamEvent, type BriefingStreamEvent } from './briefingStream.js';
import {
    BriefingContractError,
    buildProductionBriefingRunner,
    type BriefingRunner,
} from './briefingRunner.js';
import { classifyBriefingError } from './errorClassifier.js';
import { createExtractHandler, type PipelineRunner } from './routes/extract.js';
import { randomUUID } from 'node:crypto';
import { parseSpacesEnv } from '../config/spacesEnv.js';
import { buildProductionPipelineRunner } from '../pipeline/production.js';
import { createPdfImgConvertRasterizer } from '../pipeline/rasterizer.js';
import { createAnthropicVisionInvocation } from '../pipeline/nodes/vision.js';
import { createAgentSpacesClient, createOpenEmrSpacesClient } from '../storage/spaces.js';
import { createOpenEmrDocumentReferenceClient } from '../storage/openemrDocumentReferenceClient.js';
import { createPgExtractionArtifactStore } from '../state/extractionArtifacts.js';
import { decodeChartSnapshot } from '../snapshot/decode.js';
import { createSnapshotClient } from '../tools/snapshotClient.js';

const DEFAULT_AUDIENCE = 'openemr-clinical-copilot-agent';

// Shared UUID-shape filter for query parameters. Used by every route
// that accepts a uuid in its query string (force-resume conversation
// id, schedule_briefings practitioner uuid). Matches RFC 4122 lower-
// or upper-case hex with dashes; no version-bit gating.
const UUID_QUERY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AppDeps {
    readonly auth: BearerAuthMiddlewareOptions;
    readonly briefingRunner: BriefingRunner;
    /**
     * §4.6 resume + §4.7 history wiring. Both `GET
     * /v1/agent/latest_conversation` (auto-resume + force-resume) and
     * `GET /v1/agent/conversation_history` (sidebar list) read through
     * this bag. When omitted (only legacy tests do this) the routes
     * return 404 / empty so the panel falls back to a fresh briefing.
     */
    readonly conversationApi?: {
        readonly conversationStore: ConversationStore;
        readonly conversationMessages: ConversationMessagesStore;
        readonly resumeWindowHours: number;
    };
    /**
     * Suggestion-chip provenance gate. When wired, follow-up turns whose
     * `followUp` params don't match a chip ID this conversation actually
     * surfaced are rejected as `unknown_chip_id` before the runner runs.
     * Optional so legacy tests stay green; production always sets this.
     */
    readonly conversationSuggestions?: ConversationSuggestionStore;
    /**
     * §5.3 morning-prep cache. Required by the `precompute=true` branch
     * of the briefing route; absent in legacy tests that exercise only
     * the interactive default-briefing path.
     */
    readonly scheduleBriefingsLog?: ScheduleBriefingsLog;
    /**
     * §B.8 ingestion pipeline runner. Required by the `/v1/agent/extract`
     * route. Optional so legacy tests that exercise only the
     * conversational graph stay green — the route returns 503 if the
     * dep isn't wired.
     */
    readonly pipeline?: PipelineRunner;
}

// `analyte` is an identifier we feed into a SQL `LIKE` pattern downstream.
// The PHP layer escapes `%` and `_` defensively, but rejecting glob chars at
// the boundary keeps a single hostile character (e.g. `%`) from ever reaching
// the database. The character class matches the real seed values today
// (`Hemoglobin A1c`, `Sodium`, etc.) — letters, digits, spaces, hyphens,
// slashes, parens, and dots — and excludes `_` because no seed analyte uses
// it and it doubles as a LIKE wildcard.
const ANALYTE_PATTERN = /^[A-Za-z0-9 \-/().]+$/;

const followUpParamsSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('lab_trend'),
        analyte: z
            .string()
            .min(1)
            .max(200)
            .regex(ANALYTE_PATTERN, 'analyte may not contain glob characters'),
    }),
    z.object({ type: z.literal('prescription_change'), prescriptionId: z.string().min(1).max(200) }),
    z.object({ type: z.literal('external_care'), lookbackDays: z.number().int().positive().max(3650) }),
    z.object({ type: z.literal('reminder_detail'), reminderId: z.string().min(1).max(200) }),
    z.object({
        type: z.literal('medication_statement_detail'),
        listId: z.string().min(1).max(200),
    }),
]);

const briefingRequestSchema = z
    .object({
        conversationId: z.string().min(1),
        requestId: z.string().min(1),
        siteId: z.string().min(1),
        patient: z.object({
            pid: z.number().int().positive(),
            // Browser callers don't always have the FHIR UUID handy; the
            // snapshot endpoint resolves the patient by pid behind the bearer
            // token, so the uuid travels in the envelope for tracing and
            // future cross-system references but is not load-bearing today.
            uuid: z.string().default(''),
        }),
        task: z.union([z.literal('default_briefing'), z.literal('follow_up')]).default('default_briefing'),
        // §4.5 free-text follow-up. Bounded to keep the prompt + trace logs
        // tractable; the panel composer enforces the same cap client-side.
        question: z.string().min(1).max(2000).optional(),
        // §4.1 typed suggested-follow-up parameter set. Mutually exclusive
        // with `question` — the boundary parses one or the other into the
        // envelope, never both.
        followUp: followUpParamsSchema.optional(),
        // §5.3 morning-prep precompute. When `true` the request is
        // routed through the schedule-briefings cache instead of the
        // interactive conversation store; `appointmentId` becomes
        // required and `practitionerUuid` (the cache's natural key)
        // is taken from the JWT subject. `force` overrides idempotency.
        precompute: z.boolean().default(false),
        practitionerUuid: z.string().min(1).optional(),
        appointmentId: z.string().min(1).optional(),
        force: z.boolean().default(false),
    })
    .refine(
        (v) => !(v.question !== undefined && v.followUp !== undefined),
        { message: 'question and followUp are mutually exclusive', path: ['followUp'] },
    )
    .refine(
        (v) => !v.precompute || (typeof v.appointmentId === 'string' && v.appointmentId.length > 0),
        { message: 'appointmentId is required when precompute=true', path: ['appointmentId'] },
    )
    .refine(
        (v) => !v.precompute || (typeof v.practitionerUuid === 'string' && v.practitionerUuid.length > 0),
        { message: 'practitionerUuid is required when precompute=true', path: ['practitionerUuid'] },
    );

/**
 * §4.1 → §4.2/§4.3/§4.4 transitional bridge. Stringifies a typed
 * follow-up parameter set into the deterministic question that the
 * §4.5 free-text path already understands. UC-specific graph branches
 * replace this one type at a time; the typed envelope shape stays.
 *
 * §4.2 + §4.3 have shipped: `lab_trend` and `prescription_change` no
 * longer go through this bridge — each flows as a typed `followUp`
 * envelope and the corresponding graph branch (UC2 synthesizer prompt
 * / UC3 deterministic prescriptionChangeBranch) reads the typed params
 * directly. Returning `null` here signals "do not bridge this type";
 * the route handler leaves `question` unset on the envelope and the
 * UC-specific branch wins. `external_care` still bridges until §4.4.
 */
export const stringifyFollowUp = (params: SuggestedFollowUpParams): string | null => {
    switch (params.type) {
        case 'lab_trend':
            return null;
        case 'prescription_change':
            return null;
        case 'reminder_detail':
            // §4.6.5 deterministic branch reads the typed params; no
            // bridging needed.
            return null;
        case 'medication_statement_detail':
            // §4.6.6 deterministic branch reads the typed params; no
            // bridging needed.
            return null;
        case 'external_care':
            return `Summarize external care from the last ${params.lookbackDays} days.`;
    }
};

export const createApp = ({
    auth,
    briefingRunner,
    conversationApi,
    conversationSuggestions,
    scheduleBriefingsLog,
    pipeline,
}: AppDeps): Hono => {
    const app = new Hono();
    const logger = createLogger('server');

    app.get('/health', (c) => c.json({ status: 'ok' }));

    app.use('/v1/*', createBearerAuthMiddleware(auth));

    app.post('/v1/agent/respond', async (c) => {
        const principal = getPrincipal(c);
        const body: unknown = await c.req.json();
        return c.json({ received: body, fhirUser: principal.fhirUser });
    });

    // The stream-echo route from §1.6 is superseded by /v1/agent/briefing
    // below. Keeping the non-stream /v1/agent/respond echo for legacy
    // smoke-tests until §3.5 lands; the typed briefing path is the only
    // surface the §3.4 UI talks to.

    /**
     * §3.4 default-briefing entry point. The proxy mints a JWT with the
     * acting Practitioner's `fhirUser`; the request body carries the rest
     * of the envelope (conversation/request/patient/site). The runner runs
     * the LangGraph briefing graph and emits the section-by-section SSE
     * sequence defined in `briefingStream.ts`. On any internal failure we
     * still complete the SSE stream with a typed `error` event so the
     * browser's failure-state UI fires instead of seeing a hung connection.
     */
    app.post('/v1/agent/briefing', async (c) => {
        const principal = getPrincipal(c);
        const token = getRawToken(c);
        const rawBody: unknown = await c.req.json().catch(() => null);
        const parsed = briefingRequestSchema.safeParse(rawBody);

        return streamSSE(c, async (stream) => {
            const writeEvent = async (event: BriefingStreamEvent): Promise<void> => {
                await stream.write(encodeStreamEvent(event));
            };

            if (!parsed.success) {
                await writeEvent({ type: 'error', code: 'invalid_envelope' });
                return;
            }

            // Defense-in-depth: the JWT issuer pins which site the
            // physician was authenticated against. The browser-supplied
            // envelope must match — otherwise a stale tab or a bug in the
            // proxy could route a request across sites. The proxy already
            // gates this at mint time; refusing again here keeps the
            // contract local to whichever side reads the envelope last.
            if (parsed.data.siteId !== principal.siteId) {
                logger.warn(
                    {
                        envelopeSite: parsed.data.siteId,
                        principalSite: principal.siteId,
                        requestId: parsed.data.requestId,
                    },
                    'site mismatch between envelope and JWT — rejecting',
                );
                await writeEvent({ type: 'error', code: 'site_mismatch' });
                return;
            }

            // §5.3 morning-prep precompute branch. Short-circuits before
            // the chip-provenance gate and the follow-up bridge (neither
            // applies to a system-actor cron run). The conversation
            // store is bypassed entirely — precompute writes only to
            // `schedule_briefings`, which the schedule view reads
            // separately.
            if (parsed.data.precompute) {
                if (scheduleBriefingsLog === undefined) {
                    logger.error(
                        { requestId: parsed.data.requestId },
                        'precompute request received but scheduleBriefingsLog is not wired',
                    );
                    await writeEvent({ type: 'error', code: 'precompute_unavailable' });
                    return;
                }
                const practitionerUuid = parsed.data.practitionerUuid ?? '';
                const appointmentId = parsed.data.appointmentId ?? '';
                const today = new Date().toISOString().slice(0, 10);
                if (!parsed.data.force) {
                    const exists = await scheduleBriefingsLog.existsForToday(
                        { practitionerUuid, appointmentId },
                        today,
                    );
                    if (exists) {
                        await writeEvent({
                            type: 'done',
                            persistedAt: new Date().toISOString(),
                            precompute: { appointmentId, outcome: 'skipped_idempotent' },
                        });
                        return;
                    }
                }
                const precomputeEnvelope: RequestEnvelope = {
                    conversationId: parsed.data.conversationId,
                    requestId: parsed.data.requestId,
                    siteId: principal.siteId,
                    actor: { userId: principal.sub, fhirUser: principal.fhirUser },
                    patient: parsed.data.patient,
                    task: 'default_briefing',
                };
                try {
                    const events = await briefingRunner({
                        envelope: precomputeEnvelope,
                        token,
                        extraMetadata: { precompute: true },
                    });
                    let formattedMessage: AssistantMessage | null = null;
                    for (const event of events) {
                        if (event.type === 'assistantMessage') {
                            formattedMessage = event.message;
                        }
                    }
                    if (formattedMessage === null) {
                        logger.error(
                            { requestId: parsed.data.requestId },
                            'precompute runner produced no assistant message',
                        );
                        await writeEvent({ type: 'error', code: 'briefing_failed' });
                        return;
                    }
                    // Flags carry two families of short, machine-readable
                    // codes the schedule view chips off without
                    // re-rendering the full assistant message:
                    //
                    //   1. `gaps[].reason` — verifier-derived issues for
                    //      this turn (e.g. `safety-critical-rejected`).
                    //   2. `archetypeFlags`  — §5.5 snapshot-derived
                    //      labels (e.g. `archetype:diabetic_uncontrolled`).
                    //
                    // Both ride into `schedule_briefings.flags[]`; the
                    // §5.4 shim renders one chip per entry.
                    const flags = [
                        ...formattedMessage.gaps.map((gap) => gap.reason),
                        ...formattedMessage.archetypeFlags,
                    ];
                    const recordOutcome = await scheduleBriefingsLog.record(
                        {
                            key: { practitionerUuid, appointmentId },
                            summary: formattedMessage,
                            flags,
                            requestId: parsed.data.requestId,
                        },
                        { force: parsed.data.force },
                    );
                    await writeEvent({
                        type: 'done',
                        persistedAt: new Date().toISOString(),
                        precompute: {
                            appointmentId,
                            outcome: recordOutcome.outcome,
                        },
                    });
                } catch (err) {
                    const code = classifyBriefingError(err);
                    logger.error(
                        {
                            err,
                            code,
                            requestId: parsed.data.requestId,
                            appointmentId,
                        },
                        'precompute briefing runner failed',
                    );
                    await writeEvent({ type: 'error', code });
                }
                return;
            }

            // Suggestion-chip provenance gate. A typed `followUp` carries
            // params we can re-hash (`stableId(conversationId, params)`)
            // into the same chip ID the §4.1 generator emitted on a
            // previous default-briefing turn. Reject if no such ID was
            // ever shown in this conversation. Fail-closed by design:
            // if the briefingRunner failed to persist the chip set on
            // the prior turn (logged-and-swallowed there), the lookup
            // returns false and the follow-up is rejected — the panel
            // surfaces the same generic "request was malformed" UI the
            // user already understands.
            if (
                parsed.data.followUp !== undefined
                && conversationSuggestions !== undefined
            ) {
                const chipId = stableId(parsed.data.conversationId, parsed.data.followUp);
                const known = await conversationSuggestions.hasChip(
                    parsed.data.conversationId,
                    chipId,
                );
                if (!known) {
                    logger.warn(
                        {
                            conversationId: parsed.data.conversationId,
                            requestId: parsed.data.requestId,
                            followUpType: parsed.data.followUp.type,
                        },
                        'unknown chip ID — followUp rejected',
                    );
                    await writeEvent({ type: 'error', code: 'unknown_chip_id' });
                    return;
                }
            }

            // §4.1 → §4.2/§4.3/§4.4 transitional shim: bridge a typed
            // `followUp` into the §4.5 free-text path for follow-up
            // types whose UC-specific branch hasn't shipped yet. §4.2
            // shipped (`lab_trend`) and §4.3 shipped
            // (`prescription_change`), so both flow through their own
            // typed branches and `stringifyFollowUp` returns `null`
            // for them.
            const bridgedFromFollowUp = parsed.data.followUp !== undefined
                ? stringifyFollowUp(parsed.data.followUp)
                : null;
            const bridgedQuestion = parsed.data.question ?? bridgedFromFollowUp ?? undefined;
            const envelope: RequestEnvelope = {
                conversationId: parsed.data.conversationId,
                requestId: parsed.data.requestId,
                siteId: principal.siteId,
                actor: { userId: principal.sub, fhirUser: principal.fhirUser },
                patient: parsed.data.patient,
                task: parsed.data.task,
                ...(bridgedQuestion !== undefined ? { question: bridgedQuestion } : {}),
                ...(parsed.data.followUp !== undefined ? { followUp: parsed.data.followUp } : {}),
            };

            try {
                // Pass the SSE writer as the runner's live event sink
                // so `meta`, `progress`, `assistantMessage` and `done`
                // events flush to the browser as they happen — the
                // panel sees the stage spinner advance during the run
                // instead of one batch at the end. When `onEvent` is
                // set the runner returns an empty array (already
                // streamed); the iteration below is the fallback for
                // mock runners in tests that ignore the callback.
                const events = await briefingRunner({ envelope, token, onEvent: writeEvent });
                for (const event of events) {
                    await writeEvent(event);
                }
            } catch (err) {
                if (err instanceof BriefingContractError) {
                    logger.warn(
                        {
                            reason: err.reason,
                            requestId: envelope.requestId,
                            task: envelope.task,
                        },
                        'briefing contract violation',
                    );
                    await writeEvent({ type: 'error', code: 'invalid_envelope' });
                    return;
                }
                const code = classifyBriefingError(err);
                logger.error(
                    {
                        err,
                        code,
                        requestId: envelope.requestId,
                        conversationId: envelope.conversationId,
                    },
                    'briefing runner failed',
                );
                await writeEvent({ type: 'error', code });
            }
        });
    });

    /**
     * §4.6 resume + §4.7 force-resume entry point.
     *
     * Two modes, distinguished by query string:
     *   - default ("auto-resume"): no `conversation` param → resolves
     *     the most recent conversation for the (principal, patient)
     *     pair whose `updated_at` is within the resume window (12h),
     *     or 404 if none. The panel hits this on cold load.
     *   - explicit ("force-resume"): `?conversation=<uuid>` → loads
     *     that specific conversation, regardless of recency, after
     *     verifying the principal owns it (`findOwnedById`). The
     *     sidebar history click hits this. Ownership check uses the
     *     same authorization seam as follow-up turns.
     *
     * Both modes return the same payload shape so the panel renders
     * them identically.
     */
    app.get('/v1/agent/latest_conversation', async (c) => {
        if (conversationApi === undefined) {
            return c.json({ code: 'resume_unavailable' }, 404);
        }
        const principal = getPrincipal(c);
        const pidRaw = c.req.query('pid');
        const pid = pidRaw !== undefined ? Number.parseInt(pidRaw, 10) : Number.NaN;
        if (!Number.isInteger(pid) || pid <= 0) {
            return c.json({ code: 'invalid_pid' }, 400);
        }
        const explicitId = c.req.query('conversation');
        let convId: string;
        let updatedAt: string;
        if (explicitId !== undefined) {
            // Force-resume path. The id must be a UUID (cheap structural
            // check) and the row must be owned by the principal AND
            // scoped to the same patient — `findOwnedById` enforces
            // both, returning null if either invariant fails.
            if (!UUID_QUERY_RE.test(explicitId)) {
                return c.json({ code: 'invalid_conversation_id' }, 400);
            }
            const owned = await conversationApi.conversationStore.findOwnedById(
                explicitId,
                principal.sub,
                pid,
            );
            if (owned === null) {
                return c.json({ code: 'conversation_not_found' }, 404);
            }
            convId = owned.id;
            updatedAt = owned.updatedAt;
        } else {
            const found = await conversationApi.conversationStore.findResumable(
                principal.sub,
                pid,
                conversationApi.resumeWindowHours,
            );
            if (found === null) {
                return c.json({ code: 'no_resumable_conversation' }, 404);
            }
            convId = found.id;
            updatedAt = found.updatedAt;
        }
        const messages = await conversationApi.conversationMessages.listForConversation(convId);
        // Project the persisted rows into the panel's render shape.
        // Assistant messages keep their full `AssistantMessage` payload
        // (segments + claims + sources); user turns collapse to plain text.
        const thread = messages.map((m) =>
            m.role === 'assistant'
                ? { role: 'assistant' as const, message: m.message }
                : { role: 'user' as const, text: m.text },
        );
        return c.json({
            conversationId: convId,
            updatedAt,
            thread,
        });
    });

    /**
     * §4.7 history sidebar feed. Returns the most recent conversations
     * for the (principal, patient) pair, paged. Empty list (200) when
     * the user has no conversations on this patient — that's a normal
     * "new patient" state, not an error.
     *
     * Query params:
     *   - `pid` (required, positive integer)
     *   - `limit` (optional, default 50, capped at 100 server-side)
     *   - `before_updated_at` + `before_id` (optional cursor pair from
     *     the previous page's last item)
     */
    app.get('/v1/agent/conversation_history', async (c) => {
        if (conversationApi === undefined) {
            return c.json({ items: [], nextBefore: null });
        }
        const principal = getPrincipal(c);
        const pidRaw = c.req.query('pid');
        const pid = pidRaw !== undefined ? Number.parseInt(pidRaw, 10) : Number.NaN;
        if (!Number.isInteger(pid) || pid <= 0) {
            return c.json({ code: 'invalid_pid' }, 400);
        }
        const limitRaw = c.req.query('limit');
        const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : 50;
        if (!Number.isInteger(limit) || limit <= 0) {
            return c.json({ code: 'invalid_limit' }, 400);
        }
        const beforeUpdatedAt = c.req.query('before_updated_at');
        const beforeId = c.req.query('before_id');
        // Both cursor parts must come together; one without the other
        // is a contract error rather than a silent fallback to the
        // first page (which would hide a UI bug).
        if ((beforeUpdatedAt === undefined) !== (beforeId === undefined)) {
            return c.json({ code: 'invalid_cursor' }, 400);
        }
        const items = await conversationApi.conversationStore.listForUserAndPatient(
            principal.sub,
            pid,
            {
                limit,
                ...(beforeUpdatedAt !== undefined && beforeId !== undefined
                    ? { before: { updatedAt: beforeUpdatedAt, id: beforeId } }
                    : {}),
            },
        );
        // The next-page cursor is the last item's `(updatedAt, id)`,
        // emitted only when the page was full — a short page implies
        // we've hit the tail.
        const nextBefore = items.length === limit && items.length > 0
            ? { updatedAt: items[items.length - 1]!.updatedAt, id: items[items.length - 1]!.id }
            : null;
        return c.json({
            items: items.map((it) => ({
                conversationId: it.id,
                createdAt: it.createdAt,
                updatedAt: it.updatedAt,
                messageCount: it.messageCount,
                firstQuestion: it.firstQuestion,
            })),
            nextBefore,
        });
    });

    /**
     * §5.4 schedule-view annotations read path. Returns the cached
     * briefings the §5.3 precompute job already wrote for the
     * requesting practitioner. Keyed by (practitioner_uuid, date) and
     * scoped self-only — the principal must equal the requested
     * practitioner_uuid. The PHP shim that fronts this endpoint
     * collapses any non-200 response to "no annotations" so the
     * calendar render never blocks on a misconfigured agent.
     */
    app.get('/v1/agent/schedule_briefings', async (c) => {
        if (scheduleBriefingsLog === undefined) {
            return c.json({ code: 'briefings_unavailable' }, 503);
        }
        const principal = getPrincipal(c);
        const practitionerUuid = c.req.query('practitioner_uuid');
        if (practitionerUuid === undefined || !UUID_QUERY_RE.test(practitionerUuid)) {
            return c.json({ code: 'invalid_practitioner_uuid' }, 400);
        }
        const date = c.req.query('date');
        if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return c.json({ code: 'invalid_date' }, 400);
        }
        const parsed = new Date(`${date}T00:00:00.000Z`);
        // `Date` accepts overflow dates like 2026-13-01 by silently
        // rolling them forward; round-trip the parsed value back to a
        // YYYY-MM-DD string and compare to catch the rollover.
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
            return c.json({ code: 'invalid_date' }, 400);
        }
        if (principal.sub !== practitionerUuid) {
            return c.json({ code: 'not_self' }, 403);
        }
        const rows = await scheduleBriefingsLog.listForPractitionerDay({
            practitionerUuid,
            dateUtc: date,
        });
        return c.json({
            briefings: rows.map((r) => ({
                appointment_id: r.appointmentId,
                flags: r.flags,
                generated_at: r.generatedAt,
            })),
        });
    });

    /**
     * §B.8 ingestion pipeline trigger. Path A: panel uploads a doc
     * during a conversation; OpenEMR's `agent.php` proxy mints a
     * scoped JWT and forwards the body here, then pipes the SSE
     * response back to the panel. Pipeline progress is surfaced as
     * `pipeline.*.complete` events, terminal status as `pipeline.exit`,
     * failures as `pipeline.error`.
     *
     * Wired only when the pipeline dep is supplied. Boot wires the
     * production pipeline; legacy tests that don't construct one see a
     * 503 with `pipeline_unavailable` instead.
     */
    app.post('/v1/agent/extract', async (c) => {
        if (pipeline === undefined) {
            return c.json({ code: 'pipeline_unavailable' }, 503);
        }
        return createExtractHandler({ pipeline })(c);
    });

    // Smoke-test endpoint paired with the proxy's `echo` action. End-to-end
    // smoke verifies the trust boundary works before any real LLM lands.
    app.post('/v1/agent/echo', async (c) => {
        const principal = getPrincipal(c);
        let received: unknown = null;
        const raw = await c.req.text();
        if (raw.length > 0) {
            try {
                received = JSON.parse(raw);
            } catch {
                received = raw;
            }
        }
        return streamSSE(c, async (stream) => {
            await stream.writeSSE({
                data: JSON.stringify({
                    ok: true,
                    action: 'echo',
                    fhirUser: principal.fhirUser,
                    received,
                }),
            });
        });
    });

    return app;
};

const buildVerifier = (): AgentJwtVerifier => {
    const issuer = process.env['AGENT_JWT_ISSUER'] ?? '';
    if (issuer.length === 0) {
        throw new Error('AGENT_JWT_ISSUER is required');
    }
    const audience = process.env['AGENT_JWT_AUDIENCE'] ?? DEFAULT_AUDIENCE;

    const jwksUri = process.env['OPENEMR_JWKS_URL'] ?? '';
    const staticJwk = process.env['AGENT_JWT_PUBLIC_KEY'] ?? '';

    if (jwksUri.length > 0) {
        return createAgentJwtVerifier({
            keyResolver: createRemoteKeyResolver({ jwksUri: new URL(jwksUri) }),
            issuer,
            audience,
        });
    }
    if (staticJwk.length > 0) {
        const jwk = JSON.parse(staticJwk) as JWK;
        return createAgentJwtVerifier({
            keyResolver: createLocalKeyResolver([jwk]),
            issuer,
            audience,
        });
    }
    throw new Error('one of OPENEMR_JWKS_URL or AGENT_JWT_PUBLIC_KEY must be set');
};

export const start = async (port: number): Promise<void> => {
    const logger = createLogger('server');
    // §6.1: belt-and-braces PHI suppression for LangSmith. We default
    // these to "true" if the operator did not set them — uploading a
    // briefing prompt that contains the chart in the clear would defeat
    // the rest of the trust boundary. An operator who knows what they
    // are doing can override (`...HIDE_INPUTS=false`) for ad-hoc
    // debugging in a non-PHI environment.
    process.env['LANGSMITH_HIDE_INPUTS'] = process.env['LANGSMITH_HIDE_INPUTS'] ?? 'true';
    process.env['LANGSMITH_HIDE_OUTPUTS'] = process.env['LANGSMITH_HIDE_OUTPUTS'] ?? 'true';
    const databaseUrl = process.env['DATABASE_URL'] ?? '';
    if (databaseUrl.length === 0) {
        logger.error('DATABASE_URL is not set; cannot boot agent state store');
        throw new Error('DATABASE_URL is required');
    }
    const openEmrBaseUrl = process.env['OPENEMR_BASE_URL'] ?? '';
    if (openEmrBaseUrl.length === 0) {
        logger.error('OPENEMR_BASE_URL is not set; agent cannot reach the snapshot endpoint');
        throw new Error('OPENEMR_BASE_URL is required');
    }
    // Apply schema migrations *before* any state-store factory wires up
    // a pool. A pending migration that fails throws — the agent refuses
    // to serve briefings against a half-applied schema. Keeps the
    // application code free of CREATE TABLE IF NOT EXISTS noise; every
    // schema change is a numbered file under `agent/migrations/`.
    await runMigrations({ databaseUrl });

    const verify = buildVerifier();
    // LangGraph's `PostgresSaver` owns its own `checkpoint*` tables and
    // its own `setup()`. We don't migrate those — the third-party
    // module manages its own schema lifecycle.
    const checkpointer = createCheckpointer(databaseUrl);
    await checkpointer.setup();
    logger.info('LangGraph Postgres checkpointer ready');

    const unverifiedClaimsLog = createPgUnverifiedClaimsLog({ connectionString: databaseUrl });
    const conversationStore = createPgConversationStore({ connectionString: databaseUrl });
    const conversationMessages = createPgConversationMessagesStore({ connectionString: databaseUrl });
    const conversationSuggestions = createPgConversationSuggestionStore({ connectionString: databaseUrl });
    const scheduleBriefingsLog = createPgScheduleBriefingsLog({ connectionString: databaseUrl });
    // §B.1 `extractionArtifactStore` is constructed at C.1's wiring point
    // (when the conversational graph's documentEvidenceRetriever takes it
    // as a dep). The schema is provisioned at boot by `runMigrations`
    // above, so we don't need to construct the store here just to ensure
    // the table exists.

    const counters = createInMemoryCounters();
    const briefingRunner = buildProductionBriefingRunner({
        openEmrBaseUrl,
        unverifiedClaimsLog,
        conversationStore,
        conversationMessages,
        conversationSuggestions,
        checkpointer,
        counters,
    });
    // §6.1: log the rolling cost-projection snapshot once a minute so the
    // numbers are searchable in the agent's stdout without needing a
    // metrics scrape. PHI keys (raw clinician/patient ids) stay in-process;
    // only counts and totals reach the log line.
    setInterval(() => {
        const snap = counters.snapshot();
        logger.info(
            {
                totalBriefings: snap.totalBriefings,
                clinicians: Object.keys(snap.briefingsByClinician).length,
                patients: Object.keys(snap.briefingsByPatient).length,
                toolCalls: snap.toolCalls,
                modelUsage: snap.modelUsage,
                verification: snap.verification,
            },
            'agent counters snapshot',
        );
    }, 60_000).unref();

    // §B.8 ingestion pipeline. The route is path A only (panel
    // upload during a conversation). The rasterizer + vision invoker
    // are constructed once at boot — both are stateless and the per-
    // call values (token, canonicalExt, conversationId) thread through
    // `PipelineCallContext` so the production runner builds a fresh
    // `PipelineDeps` per `stream()`.
    const spacesEnv = parseSpacesEnv();
    const openemrSpaces = createOpenEmrSpacesClient(spacesEnv);
    const agentSpaces = createAgentSpacesClient(spacesEnv);
    const extractionArtifactStore = createPgExtractionArtifactStore({ connectionString: databaseUrl });
    const documentReferenceClient = createOpenEmrDocumentReferenceClient({ baseUrl: openEmrBaseUrl });
    const snapshotClient = createSnapshotClient({ baseUrl: openEmrBaseUrl });
    // Both pipeline-side fetch boundaries hit the same snapshot
    // endpoint with the same category set; the demographics fetcher
    // just projects `.patient` off the result. Sharing the fetch
    // keeps a single source of truth for the category list.
    const fetchSnapshotForCtx = (ctx: { openemrToken: string; openemrSiteId: string }) =>
        async (pid: number) =>
            decodeChartSnapshot(
                await snapshotClient.fetchSnapshot({
                    pid,
                    categories: [
                        'diagnosis',
                        'allergy',
                        'lab',
                        'encounter',
                        'reminder',
                        'medication_statement',
                        'prescription',
                    ],
                    token: ctx.openemrToken,
                    siteId: ctx.openemrSiteId,
                }),
            );
    const pipelineRunner: PipelineRunner = buildProductionPipelineRunner({
        artifactStore: extractionArtifactStore,
        openemrSpaces,
        agentSpaces,
        rasterizer: createPdfImgConvertRasterizer(),
        visionInvoker: createAnthropicVisionInvocation(),
        documentReferenceClient,
        buildFetchChartDemographics: (ctx) => {
            const fetch = fetchSnapshotForCtx(ctx);
            return async (pid) => (await fetch(pid)).patient;
        },
        buildFetchChartSnapshot: (ctx) => fetchSnapshotForCtx(ctx),
        transientPrefix: spacesEnv.transientPrefix,
        bucketName: spacesEnv.bucket,
        artifactIdGenerator: () => randomUUID(),
        logger,
    });

    const app = createApp({
        auth: { verify },
        briefingRunner,
        conversationApi: {
            conversationStore,
            conversationMessages,
            resumeWindowHours: 12,
        },
        conversationSuggestions,
        scheduleBriefingsLog,
        pipeline: pipelineRunner,
    });
    serve({ fetch: app.fetch, port });
    logger.info({ port }, 'agent service listening');
};

const entry = process.argv[1] ?? '';
if (import.meta.url === `file://${entry}` || entry.endsWith('/src/server/index.ts')) {
    const port = Number(process.env['PORT'] ?? 8080);
    start(port).catch((err: unknown) => {
        createLogger('server').error({ err }, 'failed to start agent service');
        process.exit(1);
    });
}
