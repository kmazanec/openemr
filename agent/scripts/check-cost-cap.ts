/**
 * Pre-flight cost estimator for the per-MR `evals:gate` CI job.
 *
 * The W2 architecture pins a hard cap of $5 per PR for the eval gate.
 * This script estimates the cost of running every suite's experiment
 * against real models given the current dataset case counts and the
 * vendor unit prices below, and exits non-zero if the estimate exceeds
 * the cap. The CI job runs this before launching any vendor calls so a
 * runaway dataset growth blocks the pipeline before burning money.
 *
 * The model is intentionally rough — exact cost depends on per-case
 * token counts which only LangSmith knows after the fact. We use the
 * suite's per-case allowance recorded in production observability
 * (median tokens per case at HEAD) and round up. The cap is the
 * decision boundary, not a precision target.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExamples as buildBriefingGraphExamples } from '../evals/runners/briefingGraphSuite.js';
import { buildExamples as buildConversationalGraphExamples } from '../evals/runners/conversationalGraphSuite.js';
import { buildExamples as buildDocumentExtractionExamples } from '../evals/runners/documentExtractionSuite.js';
import { buildExamples as buildEndToEndExamples } from '../evals/runners/endToEndSuite.js';

/** Hard cap per PR run, in USD. From W2_ARCHITECTURE.md §"Eval Architecture". */
export const HARD_CAP_USD = 5.0;

/**
 * Per-suite cost-per-case in USD. Derived from production median token
 * usage at HEAD plus vendor list prices (Anthropic Sonnet 4.6,
 * OpenAI text-embedding-3-large, Pinecone Standard p1, Cohere
 * rerank-english-v3). Conservative — round up so the estimate biases
 * toward "would block" rather than "would burn $5+".
 *
 * The numbers are not load-bearing for correctness — the gate fires
 * iff cases × per-case > $5. Adjust when:
 *   - the synthesizer model changes (commit a new estimate alongside)
 *   - a suite's average tokens-per-case shifts materially (re-derive
 *     from a recent LangSmith experiment)
 */
export const PER_CASE_USD: Readonly<Record<string, number>> = {
    // Briefing graph: one synthesizer + verifier pass per case, no
    // retrievers. Smallest unit.
    'briefing-graph': 0.04,
    // Conversational graph runs the supervisor + retrievers (Pinecone
    // + Cohere) for ~3 turns. Higher unit.
    'conversational-graph': 0.10,
    // Document extraction is one vision-mode synthesizer pass per
    // case. Document images → structured output.
    'document-extraction': 0.06,
    // End-to-end exercises the full pipeline → conversational handoff.
    // Largest unit.
    'end-to-end': 0.15,
};

export interface CostEstimate {
    readonly perSuite: Readonly<Record<string, { caseCount: number; estimatedUsd: number }>>;
    readonly totalUsd: number;
    readonly hardCapUsd: number;
    readonly underCap: boolean;
}

interface EstimateOptions {
    /**
     * Override case counts in tests. Production callers omit; the script
     * reads the live dataset case counts from each suite's
     * `buildExamples`.
     */
    readonly caseCounts?: Readonly<Record<string, number>>;
    /** Override per-case unit prices in tests. */
    readonly perCaseUsd?: Readonly<Record<string, number>>;
    readonly hardCapUsd?: number;
}

export const estimateCost = async (options: EstimateOptions = {}): Promise<CostEstimate> => {
    const perCase = options.perCaseUsd ?? PER_CASE_USD;
    const hardCap = options.hardCapUsd ?? HARD_CAP_USD;
    const counts =
        options.caseCounts ?? {
            'briefing-graph': buildBriefingGraphExamples().length,
            'conversational-graph': buildConversationalGraphExamples().length,
            'document-extraction': (await buildDocumentExtractionExamples()).length,
            'end-to-end': buildEndToEndExamples().length,
        };

    const perSuite: Record<string, { caseCount: number; estimatedUsd: number }> = {};
    let totalUsd = 0;
    for (const [suite, caseCount] of Object.entries(counts)) {
        const unit = perCase[suite];
        if (unit === undefined) {
            throw new Error(`unknown suite: ${suite} (no per-case unit price)`);
        }
        const usd = caseCount * unit;
        perSuite[suite] = { caseCount, estimatedUsd: round2(usd) };
        totalUsd += usd;
    }
    return {
        perSuite,
        totalUsd: round2(totalUsd),
        hardCapUsd: hardCap,
        underCap: totalUsd <= hardCap,
    };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolve to a stable path so callers from any cwd hit the same script.
export const SCRIPT_PATH = join(HERE, 'check-cost-cap.ts');

const main = async (): Promise<void> => {
    const estimate = await estimateCost();
    process.stdout.write(`${JSON.stringify(estimate, null, 2)}\n`);
    if (!estimate.underCap) {
        process.stderr.write(
            `check-cost-cap: estimate $${estimate.totalUsd.toFixed(2)} exceeds hard cap $${estimate.hardCapUsd.toFixed(2)}.\n` +
                `Either trim a suite's case count or document a justified bump in W2_ARCHITECTURE.md and update HARD_CAP_USD.\n`,
        );
        process.exit(1);
    }
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    void main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`check-cost-cap: ${message}\n`);
        process.exit(1);
    });
}
