import { traceable } from 'langsmith/traceable';

import { createLogger } from '../../observability/logger.js';
import { setRunMetadata } from '../../observability/traceMetadata.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';

/**
 * §A.7 Phase-A no-op stubs for the W2 retrievers (`kickoffExtraction`,
 * `documentEvidenceRetriever`, `evidenceRetriever`). The handoff
 * manifest names them so the supervisor's contract is stable across
 * phases; B and C will swap each stub's body for a real implementation
 * without changing the manifest, the wiring, or the supervisor's
 * routing surface.
 *
 * Each stub:
 *  - emits a "stub invoked" trace event,
 *  - logs a structured warn-level pino entry,
 *  - returns control to the supervisor with no state changes (empty
 *    update object).
 *
 * Returning an empty update is intentional — the supervisor's cycle
 * detector sees "this handoff was picked and produced no new state"
 * and the next iteration's supervisor LLM has the chance to either
 * change course or hit the iteration cap.
 */

const logger = createLogger('graph:stub');

type StubNode = (state: BriefingState) => Promise<BriefingStateUpdate>;

const buildStub = (name: string): StubNode => {
    const impl: StubNode = (_state) => {
        setRunMetadata({
            stub_event: 'invoked',
            stub_name: name,
        });
        logger.warn({ stub: name }, 'phase-A stub invoked; returning to supervisor');
        return Promise.resolve({});
    };
    return traceable(impl, { name, run_type: 'chain' });
};

export const kickoffExtractionStub = buildStub('kickoffExtraction');
export const documentEvidenceRetrieverStub = buildStub('documentEvidenceRetriever');
export const evidenceRetrieverStub = buildStub('evidenceRetriever');
