/**
 * §3.6 LangSmith experiment runner. Drives the briefing graph against
 * the `clinical-copilot-uc1-golden-v1` dataset and posts results as a
 * LangSmith experiment tagged with the current git SHA. Run nightly
 * from CI (`test:agent-evals-nightly`) — the per-MR gate is the Vitest
 * suite, which is fast and deterministic.
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
 * metadata so a future cost-analysis step (Phase 6.2) can correlate
 * accept-rate / token-usage with the commit that produced them.
 */

import { evaluate } from 'langsmith/evaluation';

import { createBriefingGraph } from '../../src/graph/index.js';
import { createAnthropicSynthesizer } from '../../src/graph/nodes/synthesize.js';
import type { ChartSnapshot } from '../../src/snapshot/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

import { DATASET_NAME } from './langsmithDataset.js';

interface RunResult {
    readonly ranExperiment: boolean;
    readonly experimentName?: string;
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

/**
 * The briefing graph's snapshot client, but instead of HTTPing OpenEMR,
 * it returns the dataset example's pre-recorded `inputs.snapshot`.
 * Because the experiment loop calls our target once per example and
 * passes that example's input verbatim, we resolve the snapshot from
 * the closure rather than the URL.
 */
const datasetClient = (snapshot: ChartSnapshot): SnapshotClient => ({
    fetchSnapshot: () => Promise.resolve(snapshot),
});

export const runExperiment = async (options: RunOptions = {}): Promise<RunResult> => {
    const langsmithApiKey = options.langsmithApiKey ?? process.env['LANGSMITH_API_KEY'];
    const anthropicApiKey = options.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (langsmithApiKey === undefined || langsmithApiKey.length === 0) {
        return { ranExperiment: false, skippedReason: 'LANGSMITH_API_KEY not set' };
    }
    if (anthropicApiKey === undefined || anthropicApiKey.length === 0) {
        return { ranExperiment: false, skippedReason: 'ANTHROPIC_API_KEY not set' };
    }

    const gitSha = options.gitSha ?? process.env['CI_COMMIT_SHA'] ?? 'local';
    const synthesizer = createAnthropicSynthesizer({ apiKey: anthropicApiKey });

    /**
     * Each example feeds its `snapshot` to a per-call graph (the
     * snapshot client is closed over the example, so the graph reads
     * the dataset row instead of HTTPing OpenEMR). The target returns
     * the verifier's accepted/rejected counts and the structured
     * ground-truth assertions; LangSmith's UI compares those to the
     * dataset row's `outputs` automatically.
     */
    const target = async (input: { snapshot: ChartSnapshot; archetype: string }) => {
        const graph = createBriefingGraph({
            retrieve: { client: datasetClient(input.snapshot), token: 'experiment', siteId: 'default' },
            synthesize: { synthesizer },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });
        const out = await graph.invoke({
            envelope: {
                conversationId: `exp-${input.archetype}`,
                requestId: `exp-${input.archetype}`,
                siteId: 'default',
                actor: { userId: 'experiment', fhirUser: 'https://emr/Practitioner/experiment' },
                patient: { pid: input.snapshot.patient.pid, uuid: input.snapshot.patient.uuid },
                task: 'default_briefing',
            },
        });
        const accepted = out.verified?.accepted ?? [];
        return {
            verifierPassed: out.verified?.passed === true,
            acceptedCount: accepted.length,
            rejectedCount: out.verified?.rejected.length ?? 0,
            hardStops: out.verified?.safetyHardStops ?? [],
            diagnosisCodes: accepted
                .filter((c) => c.category === 'diagnosis')
                .map((c) => c.text),
            medicationNames: accepted
                .filter((c) => c.category === 'medication')
                .map((c) => c.text),
        };
    };

    const results = await evaluate(target, {
        data: DATASET_NAME,
        experimentPrefix: `uc1-${gitSha.slice(0, 7)}`,
        metadata: { git_sha: gitSha, suite: 'uc1-golden-v1' },
    });

    return { ranExperiment: true, experimentName: results.experimentName };
};
