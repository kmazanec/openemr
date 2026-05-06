import type { AssistantMessage, PersistedRecord, RequestEnvelope } from '../graph/types.js';
import type { PipelineStreamEvent } from './pipelineStream.js';

/**
 * §3.4 SSE event protocol, reshaped in §4.5 around a single
 * `assistantMessage` event instead of seven per-section events. The proxy
 * passes these events through verbatim, so the wire format is also the
 * contract the browser renderer reads. `AssistantMessage.segments` carry
 * `Claim` objects with `SourceReference` arrays untouched — the citation
 * tag is a structured field, not a string the proxy or browser has to
 * re-parse.
 *
 * Why one event per assistant turn rather than streaming each segment as
 * its own event: the §4.5 UI renders a chat thread in which a turn is the
 * smallest meaningful unit (one bubble). Per-segment streaming would let
 * us animate prose in faster, but it complicates the failure-state UI —
 * a dropped segment mid-stream reads identically to a healthy turn that
 * happens to be short. Future incremental-render work can split this
 * into `segmentStart` / `segmentDelta` / `segmentEnd` events without
 * changing the message-level contract.
 */

/**
 * Pipeline stages exposed to the renderer as a `progress` event. A
 * subset of the LangGraph node names — only the ones a clinician
 * benefits from seeing while waiting (the sub-millisecond `persist`
 * plumbing node is deliberately omitted). The `label` rides the wire
 * so the server is the single source of truth for user-facing text;
 * future stages can be added without a paired frontend change.
 */
export type ProgressStage = 'retrieve' | 'synthesize' | 'verify' | 'format';

export type BriefingStreamEvent =
    | {
          readonly type: 'meta';
          readonly conversationId: string;
          readonly requestId: string;
          readonly siteId: string;
      }
    | {
          readonly type: 'progress';
          readonly stage: ProgressStage;
          readonly label: string;
          readonly status: 'started' | 'completed';
      }
    | {
          /**
           * Model-decided one-sentence description of the supervisor's
           * next action, written for the clinician (e.g. "Pulling
           * prior lipid panels to compare."). Emitted once per
           * non-terminal supervisor decision so the panel's progress
           * line tracks the agent's intent dynamically rather than the
           * fixed retrieve→synthesize→verify→format stages. Carrying
           * `handoff` lets the renderer style narration differently
           * for the document-extraction handoff (which also emits
           * `pipelineEvent` chips) versus the others.
           */
          readonly type: 'supervisorNarration';
          readonly handoff: string;
          readonly text: string;
      }
    | {
          readonly type: 'assistantMessage';
          readonly message: AssistantMessage;
      }
    | {
          readonly type: 'done';
          readonly persistedAt: string;
          /**
           * §5.3 precompute outcome. Present only on the precompute
           * route (`/v1/agent/briefing` with `precompute: true`); absent
           * on the interactive default-briefing path. Lets the
           * orchestrator distinguish a fresh write from an idempotent
           * skip without parsing the assistant message.
           */
          readonly precompute?: {
              readonly appointmentId: string;
              readonly outcome: 'inserted' | 'overwritten' | 'skipped_idempotent';
          };
      }
    | {
          readonly type: 'error';
          readonly code: string;
      }
    | {
          /**
           * §B.9 forwarded ingestion-pipeline event when the
           * conversational supervisor's `kickoffExtraction` handoff
           * fires synchronously inside the turn. The event vocabulary
           * is the disjoint set defined in `pipelineStream.ts`; the
           * outer `pipelineEvent` wrapper keeps the conversation
           * stream's own event names from colliding with the
           * pipeline's. The renderer can listen on
           * `addEventListener('pipelineEvent', …)` and switch on the
           * inner `event.type` to decide what to render (start chip,
           * page-count chip, terminal exit/error).
           */
          readonly type: 'pipelineEvent';
          readonly event: PipelineStreamEvent;
      };

export const eventsForBriefing = (
    envelope: RequestEnvelope,
    message: AssistantMessage,
    persisted: PersistedRecord,
): readonly BriefingStreamEvent[] => {
    return [
        {
            type: 'meta',
            conversationId: envelope.conversationId,
            requestId: envelope.requestId,
            siteId: envelope.siteId,
        },
        { type: 'assistantMessage', message },
        { type: 'done', persistedAt: persisted.persistedAt },
    ];
};

/**
 * SSE wire format: `event: <type>\ndata: <json>\n\n`. The `event:` line is
 * convenience for `EventSource.addEventListener('assistantMessage', …)`;
 * the data payload still carries `type` so consumers that only listen on
 * `message` can discriminate.
 */
export const encodeStreamEvent = (event: BriefingStreamEvent): string => {
    const data = JSON.stringify(event);
    return `event: ${event.type}\ndata: ${data}\n\n`;
};
