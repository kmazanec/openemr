/**
 * Eval suite registry. The CLI and experiment runner iterate this
 * list rather than knowing about individual suites — adding a new
 * suite means writing a sibling `*Suite.ts` file and appending it
 * here.
 */

import { archetypesSuite } from './archetypesSuite.js';
import { documentExtractionSuite } from './documentExtractionSuite.js';
import { labTrendsSuite } from './labTrendsSuite.js';
import { morningPrepSuite } from './morningPrepSuite.js';

import type { EvalSuite } from './shared.js';

export const SUITES: readonly EvalSuite[] = [
    archetypesSuite,
    labTrendsSuite,
    morningPrepSuite,
    documentExtractionSuite,
];
