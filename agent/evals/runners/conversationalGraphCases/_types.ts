/**
 * Shared types for the conversational-graph case modules.
 *
 * Each case module under this directory exports a typed `cases`
 * record keyed by case-id. The integration in
 * `conversationalGraphTarget.ts` walks every module's record to
 * produce the suite's combined `ConversationalGraphCaseId` union and
 * the `fixtureFor` switch.
 */

import type { BriefingSnapshot, RequestEnvelope } from '../../../src/graph/types.js';
import type { ExtractionArtifact } from '../../../src/state/extractionArtifacts.js';

export interface ScenarioFixture {
    readonly snapshot: BriefingSnapshot;
    readonly envelope: RequestEnvelope;
    readonly artifacts: readonly ExtractionArtifact[];
}

/**
 * Expected gate the live experiment row should reach. Matches the
 * `ConversationalGraphVerdict` union in `conversationalGraphTarget.ts`
 * (kept here as a literal string union to avoid a circular import).
 */
export type ExpectedGate =
    | 'verifier-accepted'
    | 'verifier-rejected'
    | 'gap-emitted'
    | 'hard-stop'
    | 'refusal';

export interface CaseSpec {
    /** Plain-language description of the case for the LangSmith UI. */
    readonly description: string;
    readonly expectedGate: ExpectedGate;
    readonly fixture: () => ScenarioFixture;
}
