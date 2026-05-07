/**
 * LangSmith experiment runner. Iterates every suite in the registry,
 * driving the briefing graph against each suite's dataset and posting
 * results as a LangSmith experiment tagged with the current git SHA.
 * Run nightly from CI (`test:agent-evals-nightly`) — the per-MR gate
 * is the Vitest suite, which is fast and deterministic.
 *
 * Behavior is conditional on environment:
 *
 *   - LANGSMITH_API_KEY unset → skip with `skippedReason`. No-op.
 *   - ANTHROPIC_API_KEY  unset → skip with `skippedReason`. The
 *     synthesizer needs a real model to produce a real ledger; running
 *     the experiment with a stub would just measure the stub.
 *
 * `git_sha` defaults to `process.env.CI_COMMIT_SHA` (GitLab) and falls
 * back to whatever the caller passes. Both end up as experiment
 * metadata so a future cost-analysis step can correlate accept-rate
 * and token-usage with the commit that produced them.
 */

import { SUITES } from './suites.js';
import type { ExperimentRunResult } from './shared.js';

interface RunResult {
    readonly ranExperiment: boolean;
    readonly results: readonly ExperimentRunResult[];
    readonly skippedReason?: string;
}

interface RunOptions {
    readonly gitSha?: string;
    /**
     * Optional per-test-environment overrides. Production callers omit
     * both — env vars drive everything.
     */
    readonly langsmithApiKey?: string;
    readonly anthropicApiKey?: string;
}

export const runExperiment = async (options: RunOptions = {}): Promise<RunResult> => {
    const langsmithApiKey = options.langsmithApiKey ?? process.env['LANGSMITH_API_KEY'];
    const anthropicApiKey = options.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (langsmithApiKey === undefined || langsmithApiKey.length === 0) {
        return { ranExperiment: false, results: [], skippedReason: 'LANGSMITH_API_KEY not set' };
    }
    if (anthropicApiKey === undefined || anthropicApiKey.length === 0) {
        return { ranExperiment: false, results: [], skippedReason: 'ANTHROPIC_API_KEY not set' };
    }

    const gitSha = options.gitSha ?? process.env['CI_COMMIT_SHA'] ?? 'local';

    // Suites run concurrently — each posts to its own LangSmith
    // dataset/experiment, so they are independent. CI wall-clock is
    // dominated by the slowest suite (~3-5 min per W2 architecture
    // estimate) rather than the sum, which keeps the per-PR gate fast.
    // Progress logs from `evaluate()` interleave; the structured
    // results below are the canonical per-suite signal.
    const results = await Promise.all(SUITES.map((suite) => suite.runExperiment({ anthropicApiKey, gitSha })));

    return { ranExperiment: true, results };
};
