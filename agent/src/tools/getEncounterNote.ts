import { traceable } from 'langsmith/traceable';

import type { Counters } from '../observability/counters.js';
import { createNoopCounters } from '../observability/counters.js';
import { setRunMetadata } from '../observability/traceMetadata.js';
import type { EncounterNote } from '../snapshot/types.js';

import type { AgentHttpClient } from './agentHttp.js';
import { isFailOpenError, toGap, type FailOpenResult } from './failOpen.js';
import { decodeEncounterNotesResponse } from './narrowResponseDecoders.js';

/**
 * SOAP note(s) for a single encounter.
 *
 * Maps 1:1 to OpenEMR's `public/snapshot/encounter-note.php`, which
 * runs only the EncounterNoteAdapter and writes an `encounter-note`
 * audit row. Picked when the model needs to answer "what was
 * documented at the last visit?" without paying for a full chart
 * snapshot.
 *
 * One encounter can carry multiple SOAP rows (amendments, multi-
 * author docs); the response is an array even when the common case
 * is a single note. Fail-open: a transient endpoint failure renders
 * as a gap rather than crashing the conversation.
 */

const ENCOUNTER_NOTE_PATH =
    '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/encounter-note.php';

export interface GetEncounterNoteInput {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly pid: number;
    readonly encounterId: number;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

export type EncounterNoteResult = FailOpenResult<{ readonly notes: readonly EncounterNote[] }>;

const buildUrl = (input: GetEncounterNoteInput): string => {
    const params = new URLSearchParams({
        site: input.siteId,
        pid: String(input.pid),
        encounter_id: String(input.encounterId),
    });
    return `${input.openEmrBaseUrl.replace(/\/+$/, '')}${ENCOUNTER_NOTE_PATH}?${params.toString()}`;
};

const impl = async (input: GetEncounterNoteInput): Promise<EncounterNoteResult> => {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    if (!Number.isInteger(input.encounterId) || input.encounterId <= 0) {
        throw new Error('encounterId must be a positive integer');
    }
    if (input.siteId.length === 0) {
        throw new Error('siteId is required');
    }

    const counters = input.counters ?? createNoopCounters();
    const started = performance.now();
    try {
        try {
            const raw = await input.client.get({ url: buildUrl(input), token: input.token });
            return { kind: 'ok', notes: decodeEncounterNotesResponse(raw) };
        } catch (err) {
            if (isFailOpenError(err)) {
                return toGap(err, 'Encounter note');
            }
            throw err;
        }
    } finally {
        const latencyMs = performance.now() - started;
        counters.recordToolCall({ tool: 'getEncounterNote', latencyMs });
        setRunMetadata({ latency_ms: latencyMs, tool: 'getEncounterNote' });
    }
};

export const getEncounterNote = traceable(impl, { name: 'getEncounterNote', run_type: 'tool' });

export const getEncounterNoteTool = {
    name: 'getEncounterNote',
    description:
        "Fetch the SOAP note(s) attached to a single encounter for the patient: subjective, objective, assessment, and plan, plus the note date. An encounter can carry multiple notes (amendments, multi-author docs); the response is an array. Field strings are preserved verbatim so the verifier can quote them. Use this to answer 'what was documented at this visit?' or 'what did the last visit say?'. May fail-open with a gap if the endpoint is briefly unavailable.",
    input_schema: {
        type: 'object' as const,
        properties: {
            patientPid: {
                type: 'integer' as const,
                description:
                    'OpenEMR patient id (pid) — checked against the encounter to prevent cross-patient access.',
            },
            encounterId: {
                type: 'integer' as const,
                description:
                    'OpenEMR encounter id (form_encounter.encounter) to fetch the SOAP note for.',
            },
        },
        required: ['patientPid', 'encounterId'],
    },
} as const;
