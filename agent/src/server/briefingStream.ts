import type { AssistantMessage, PersistedRecord, RequestEnvelope } from '../graph/types.js';

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

export type BriefingStreamEvent =
    | {
          readonly type: 'meta';
          readonly conversationId: string;
          readonly requestId: string;
          readonly siteId: string;
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
