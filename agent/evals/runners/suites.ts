/**
 * Eval suite registry. The CLI and experiment runner iterate this
 * list rather than knowing about individual suites — adding a new
 * suite means writing a sibling `*Suite.ts` file and appending it
 * here.
 */

import { briefingGraphSuite } from './briefingGraphSuite.js';
import { conversationalGraphSuite } from './conversationalGraphSuite.js';
import { documentExtractionSuite } from './documentExtractionSuite.js';

import type { EvalSuite } from './shared.js';

export const SUITES: readonly EvalSuite[] = [
    briefingGraphSuite,
    conversationalGraphSuite,
    documentExtractionSuite,
];
