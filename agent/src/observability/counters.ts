/**
 * §6.1 cost-projection counters. Lightweight in-process tallies keyed by
 * clinician + patient so a future cost-analysis step (Phase 6.2) has the
 * raw inputs it needs without forcing a Prometheus dependency or coupling
 * to LangSmith's aggregation.
 *
 * IDs are kept in-memory and never logged in raw form by the counters
 * module itself. Callers are expected to treat patient/clinician keys
 * as PHI-equivalent and emit them only through the redacting logger or a
 * hashed tag (see `hashIdForTrace` in `traceMetadata.ts`).
 */

export interface RecordBriefingInput {
    readonly clinicianId: string;
    readonly patientId: string;
}

export interface RecordToolCallInput {
    readonly tool: string;
    readonly latencyMs: number;
}

export interface RecordModelUsageInput {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
}

export interface RecordVerificationInput {
    readonly passed: boolean;
    readonly accepted: number;
    readonly rejected: number;
    readonly promptInjections: number;
}

export interface ToolCounter {
    count: number;
    totalLatencyMs: number;
}

export interface ModelUsageCounter {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    calls: number;
}

export interface VerificationCounter {
    passed: number;
    failed: number;
    acceptedClaims: number;
    rejectedClaims: number;
    promptInjections: number;
}

export interface CountersSnapshot {
    totalBriefings: number;
    briefingsByClinician: Record<string, number>;
    briefingsByPatient: Record<string, number>;
    toolCalls: Record<string, ToolCounter>;
    modelUsage: Record<string, ModelUsageCounter>;
    verification: VerificationCounter;
}

export interface Counters {
    recordBriefing(input: RecordBriefingInput): void;
    recordToolCall(input: RecordToolCallInput): void;
    recordModelUsage(input: RecordModelUsageInput): void;
    recordVerification(input: RecordVerificationInput): void;
    snapshot(): CountersSnapshot;
}

const emptySnapshot = (): CountersSnapshot => ({
    totalBriefings: 0,
    briefingsByClinician: {},
    briefingsByPatient: {},
    toolCalls: {},
    modelUsage: {},
    verification: {
        passed: 0,
        failed: 0,
        acceptedClaims: 0,
        rejectedClaims: 0,
        promptInjections: 0,
    },
});

export const createInMemoryCounters = (): Counters => {
    const state = emptySnapshot();
    return {
        recordBriefing: ({ clinicianId, patientId }) => {
            state.totalBriefings += 1;
            state.briefingsByClinician[clinicianId] = (state.briefingsByClinician[clinicianId] ?? 0) + 1;
            state.briefingsByPatient[patientId] = (state.briefingsByPatient[patientId] ?? 0) + 1;
        },
        recordToolCall: ({ tool, latencyMs }) => {
            const existing = state.toolCalls[tool] ?? { count: 0, totalLatencyMs: 0 };
            existing.count += 1;
            existing.totalLatencyMs += latencyMs;
            state.toolCalls[tool] = existing;
        },
        recordModelUsage: ({ model, inputTokens, outputTokens, costUsd }) => {
            const existing = state.modelUsage[model] ?? {
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                calls: 0,
            };
            existing.inputTokens += inputTokens;
            existing.outputTokens += outputTokens;
            existing.costUsd += costUsd;
            existing.calls += 1;
            state.modelUsage[model] = existing;
        },
        recordVerification: ({ passed, accepted, rejected, promptInjections }) => {
            if (passed) {
                state.verification.passed += 1;
            } else {
                state.verification.failed += 1;
            }
            state.verification.acceptedClaims += accepted;
            state.verification.rejectedClaims += rejected;
            state.verification.promptInjections += promptInjections;
        },
        snapshot: () => ({
            totalBriefings: state.totalBriefings,
            briefingsByClinician: { ...state.briefingsByClinician },
            briefingsByPatient: { ...state.briefingsByPatient },
            toolCalls: Object.fromEntries(
                Object.entries(state.toolCalls).map(([k, v]) => [k, { ...v }]),
            ),
            modelUsage: Object.fromEntries(
                Object.entries(state.modelUsage).map(([k, v]) => [k, { ...v }]),
            ),
            verification: { ...state.verification },
        }),
    };
};

export const createNoopCounters = (): Counters => ({
    recordBriefing: () => undefined,
    recordToolCall: () => undefined,
    recordModelUsage: () => undefined,
    recordVerification: () => undefined,
    snapshot: () => emptySnapshot(),
});
