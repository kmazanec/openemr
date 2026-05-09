// Type definitions for the Clinical Co-Pilot stream contract, kept in
// sync with `agent/src/graph/types.ts` and
// `agent/src/server/briefingStream.ts`. We redeclare them here rather
// than importing from the agent package because the dashboard ships
// as its own bundle and shouldn't pull in agent build artifacts.
//
// The contract test that pins these to the agent's TS definitions
// would live in agent/tests if we wanted strict cross-package
// enforcement; for now the duplication is small and the events the UI
// reads are stable.

export interface SourceReference {
  source_type: 'chart' | 'extracted_document' | 'guideline';
  source_id: string;
  locator: {
    page?: number;
    bbox?: readonly [number, number, number, number];
    section?: string;
    field?: string;
  };
  quote: string;
  confidence?: number;
  meta?: {
    document_uuid?: string;
    extractor_version?: string;
    rerank_score?: number;
    record_recorded_at?: string;
    publication?: string;
    title?: string;
    year?: number;
    url?: string;
    section?: string;
  };
}

export type ClaimCategory =
  | 'diagnosis'
  | 'medication'
  | 'allergy'
  | 'lab'
  | 'family_history'
  | 'encounter'
  | 'appointment'
  | 'identity'
  | 'reminder'
  | 'medication_statement';

export interface Claim {
  id: string;
  text: string;
  category: ClaimCategory;
  sourceReferences: readonly SourceReference[];
  safetyCritical: boolean;
}

export interface AssistantMessageSegment {
  text: string;
  claims: readonly Claim[];
  redacted: boolean;
}

export interface Gap {
  reason: string;
  message: string;
}

export interface SuggestedFollowUp {
  id: string;
  displayText: string;
  // Free-text the panel re-submits when the user clicks the chip.
  // For our UI we just send displayText as the next question.
}

export interface AssistantMessage {
  segments: readonly AssistantMessageSegment[];
  claimGroups: unknown; // we don't render the side panel — leave opaque
  gaps: readonly Gap[];
  suggestedFollowUps: readonly SuggestedFollowUp[];
  archetypeFlags: readonly string[];
}

// A subset of the agent's `BriefingStreamEvent` discriminated union —
// only the events the dashboard renders. Pipeline / precompute /
// supervisor narration events are ignored on the floor here.
export type CopilotStreamEvent =
  | { type: 'meta'; conversationId: string; requestId: string; siteId: string }
  | {
      type: 'progress';
      stage: 'retrieve' | 'synthesize' | 'verify' | 'format';
      label: string;
      status: 'started' | 'completed';
    }
  | { type: 'supervisorNarration'; handoff: string; text: string }
  | { type: 'assistantMessage'; message: AssistantMessage }
  | { type: 'done'; persistedAt: string }
  | { type: 'error'; code: string }
  // Catch-all for events we don't render — keeps the parser permissive.
  | { type: 'pipelineEvent'; event: unknown };
