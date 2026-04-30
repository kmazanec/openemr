import type { FormattedBriefing, Gap, PersistedRecord, RequestEnvelope } from '../graph/types.js';
import type { SourceReference } from '../snapshot/types.js';

/**
 * §3.4 SSE event protocol. The proxy passes these events through verbatim,
 * so the wire format is also the contract the browser renderer reads. Each
 * event has a typed `type` discriminator and a JSON payload that mirrors
 * the matching slice of `FormattedBriefing`. Section payloads carry
 * `SourceReference` objects untouched — the citation tag is a structured
 * field, not a string the proxy or browser has to re-parse.
 *
 * Why one section per event rather than streaming the whole briefing as a
 * single payload: the SSE framing gives the browser an explicit "section
 * arrived" trigger, which keeps the failure-state UI obvious — a section
 * that never arrives reads differently from a section that arrived as a
 * `Gap`. The graph today produces all sections in one shot inside `Format`;
 * if §3.5 lifts the synthesizer to LangGraph token streaming, the section
 * boundaries already exist for incremental rendering.
 */

export type SectionName =
    | 'appointment'
    | 'demographics'
    | 'activeDiagnoses'
    | 'currentMedications'
    | 'recentLabs'
    | 'allergies'
    | 'recentEncounters';

export type SectionPayload =
    | { readonly text: string; readonly source: SourceReference | null }
    | readonly { readonly text: string; readonly source: SourceReference }[]
    | Gap;

export type BriefingStreamEvent =
    | {
          readonly type: 'meta';
          readonly conversationId: string;
          readonly requestId: string;
          readonly siteId: string;
      }
    | {
          readonly type: 'section';
          readonly section: SectionName;
          readonly payload: SectionPayload;
      }
    | {
          readonly type: 'done';
          readonly persistedAt: string;
      }
    | {
          readonly type: 'error';
          readonly code: string;
      };

const SECTION_ORDER: readonly SectionName[] = [
    'appointment',
    'demographics',
    'activeDiagnoses',
    'currentMedications',
    'allergies',
    'recentLabs',
    'recentEncounters',
];

export const eventsForBriefing = (
    envelope: RequestEnvelope,
    formatted: FormattedBriefing,
    persisted: PersistedRecord,
): readonly BriefingStreamEvent[] => {
    const events: BriefingStreamEvent[] = [
        {
            type: 'meta',
            conversationId: envelope.conversationId,
            requestId: envelope.requestId,
            siteId: envelope.siteId,
        },
    ];
    for (const section of SECTION_ORDER) {
        events.push({ type: 'section', section, payload: formatted[section] });
    }
    events.push({ type: 'done', persistedAt: persisted.persistedAt });
    return events;
};

/**
 * SSE wire format: `event: <type>\ndata: <json>\n\n`. The `event:` line is
 * convenience for `EventSource.addEventListener('section', …)`; the data
 * payload still carries `type` so consumers that only listen on `message`
 * can discriminate.
 */
export const encodeStreamEvent = (event: BriefingStreamEvent): string => {
    const data = JSON.stringify(event);
    return `event: ${event.type}\ndata: ${data}\n\n`;
};
