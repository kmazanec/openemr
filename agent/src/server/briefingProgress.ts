import type { BriefingStreamEvent, ProgressStage } from './briefingStream.js';

/**
 * User-visible progress stages, in the order they fire during a turn.
 *
 * The LangGraph DAG has one more node than this list (`persist`) but
 * it runs sub-millisecond and doesn't benefit a clinician watching the
 * panel — it'd flash and vanish. Labels are owned by the server so
 * adding a new stage is a one-file change (here) instead of a paired
 * backend+frontend update.
 */
export const PROGRESS_STAGES: readonly ProgressStage[] = [
    'retrieve',
    'synthesize',
    'verify',
    'format',
];

export const STAGE_LABELS: Readonly<Record<ProgressStage, string>> = {
    retrieve: 'Reading the chart',
    synthesize: 'Composing briefing',
    verify: 'Verifying citations',
    format: 'Finalizing',
};

/**
 * Map a LangGraph node name to the user-visible stage it belongs to,
 * or `null` if the node is plumbing (only `persist` after the runner
 * hoist) or a supervisor-internal retriever the panel doesn't paint.
 */
export const stageForNode = (nodeName: string): ProgressStage | null => {
    switch (nodeName) {
        case 'retrieveChart':
            return 'retrieve';
        case 'synthesize':
            return 'synthesize';
        case 'verify':
            return 'verify';
        case 'format':
            return 'format';
        default:
            return null;
    }
};

export const startedEvent = (stage: ProgressStage): BriefingStreamEvent => ({
    type: 'progress',
    stage,
    label: STAGE_LABELS[stage],
    status: 'started',
});

export const completedEvent = (stage: ProgressStage): BriefingStreamEvent => ({
    type: 'progress',
    stage,
    label: STAGE_LABELS[stage],
    status: 'completed',
});
