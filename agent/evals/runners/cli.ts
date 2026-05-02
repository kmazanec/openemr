/**
 * Tiny CLI for the §3.6 LangSmith runners. Exists so `package.json`
 * can wire `npm run evals:upload-dataset` and `npm run evals:experiment`
 * to single tsx invocations. Both subcommands no-op when their
 * required env vars are unset, so wiring them into CI is safe even on
 * branches that don't have access to the LangSmith secret.
 */

import { runExperiment } from './experiment.js';
import { uploadDataset } from './langsmithDataset.js';

const usage = (): string =>
    'Usage: tsx evals/runners/cli.ts <upload-dataset|experiment>';

const main = async (): Promise<void> => {
    const cmd = process.argv[2];
    switch (cmd) {
        case 'upload-dataset': {
            const result = await uploadDataset();
            process.stdout.write(`${JSON.stringify(result)}\n`);
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
