/**
 * Unified fixture regenerator. Calls each suite's per-suite
 * regenerator (`regenerate-archetypes`, `regenerate-lab-trends`,
 * `regenerate-morning-prep`) in order and prints a one-line summary
 * per file written.
 *
 * Always edit the per-suite regenerators (or this wrapper) and run
 * `npm run evals:regenerate-fixtures`; never hand-edit the generated
 * JSON.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { regenerate as regenerateArchetypes } from './regenerate-archetypes.js';
import { regenerate as regenerateLabTrends } from './regenerate-lab-trends.js';
import { regenerate as regenerateMorningPrep } from './regenerate-morning-prep.js';

const main = (): void => {
    for (const { archetype, path } of regenerateArchetypes()) {
        process.stdout.write(`wrote ${archetype} → ${path}\n`);
    }
    for (const { name, path } of regenerateLabTrends()) {
        process.stdout.write(`wrote ${name} → ${path}\n`);
    }
    const morningPrep = regenerateMorningPrep();
    process.stdout.write(
        `wrote ${String(morningPrep.slotCount)} slots → ${morningPrep.path}\n`,
    );
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    main();
}
