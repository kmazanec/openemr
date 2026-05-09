/**
 * §B.8 SSE event protocol for `/v1/agent/extract`.
 *
 * The browser → OpenEMR proxy → agent path streams pipeline progress
 * back to the panel as SSE. The conversational graph already has its
 * own progress vocabulary (`briefingStream.ts`); the pipeline emits a
 * disjoint set of events because the two graphs are structurally
 * different (producer vs consumer) and conflating their event names
 * would force the renderer to discriminate by graph identity instead
 * of by event shape.
 *
 * The event vocabulary mirrors the LangGraph node names — one
 * `*.complete` event per node that is interesting to a clinician
 * watching the panel. `cleanup` is omitted from the per-node events
 * because it runs on every path (success and failure) and the `exit`
 * event already carries the terminal state. `schemaValidate` and
 * `patientMatch` are also omitted as a default — they run synchronously
 * after `vision` and a clinician has no useful action to take while
 * they execute. Adding them later is a one-line change here.
 */

import type { PipelineErrorCode } from '../pipeline/state.js';

export type PipelineStreamEvent =
    | {
          readonly type: 'pipeline.start';
          readonly documentUuid: string;
          readonly docType: 'lab_pdf' | 'intake_form' | 'referral_letter';
          readonly triggerSource: 'panel' | 'autosweep' | 'cli';
      }
    | {
          readonly type: 'pipeline.rasterize.complete';
          readonly pageCount: number;
      }
    | {
          readonly type: 'pipeline.vision.complete';
      }
    | {
          readonly type: 'pipeline.persist.complete';
          readonly artifactId: string;
      }
    | {
          readonly type: 'pipeline.exit';
          readonly status: 'persisted' | 'failed';
          readonly artifactId: string | null;
      }
    | {
          readonly type: 'pipeline.error';
          readonly code: PipelineErrorCode;
          readonly message: string;
      };

/**
 * SSE wire format mirrors `briefingStream.encodeStreamEvent`: an
 * `event:` line lets a future `EventSource.addEventListener` discriminate
 * without parsing the data payload, and the data payload still carries
 * `type` so consumers reading from `onmessage` can switch on the same
 * field.
 */
export const encodePipelineEvent = (event: PipelineStreamEvent): string => {
    const data = JSON.stringify(event);
    return `event: ${event.type}\ndata: ${data}\n\n`;
};
