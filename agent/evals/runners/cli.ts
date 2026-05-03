/**
 * Tiny CLI for the LangSmith runners. `package.json` wires
 * `npm run evals:upload-dataset` and `npm run evals:experiment` to
 * single tsx invocations. Both subcommands no-op when their required
 * env vars are unset, so wiring them into CI is safe even on
 * branches without LangSmith access.
 *
 * Both subcommands iterate every suite in `suites.ts` — adding a new
 * suite means writing `<name>Suite.ts` and appending it to the
 * registry; this file does not change.
 */

import { runExperiment } from './experiment.js';
import { SUITES } from './suites.js';

const usage = (): string => 'Usage: tsx evals/runners/cli.ts <upload-dataset|experiment>';

const main = async (): Promise<void> => {
    const cmd = process.argv[2];
    switch (cmd) {
        case 'upload-dataset': {
            // Each uploader is idempotent (no-op if the dataset
            // already exists). Run them sequentially so a single
            // missing API key surfaces the same `skippedReason`
            // shape for every suite.
            const results = await Promise.all(SUITES.map((s) => s.uploadDataset()));
            const summary = Object.fromEntries(
                SUITES.map((s, i) => [s.name, results[i]]),
            );
            process.stdout.write(`${JSON.stringify(summary)}\n`);
            return;
        }
        case 'experiment': {
            const result = await runExperiment();
            process.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        default:
            process.stderr.write(`unknown command: ${String(cmd)}\n${usage()}\n`);
            process.exit(2);
    }
};

void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
