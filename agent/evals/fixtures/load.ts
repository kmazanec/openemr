import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BriefingSnapshot } from '../../src/graph/types.js';
import type { ChartSnapshot } from '../../src/snapshot/types.js';

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc1');

/**
 * Load a UC1 fixture and adapt it to the in-graph `BriefingSnapshot`
 * shape. UC1 fixtures are pinned `ChartSnapshot` JSON; the only
 * difference between the two shapes is `labHistory`, which UC1 turns
 * never populate (UC2 has its own fixture loader).
 *
 * Per user direction, §4.3 keeps UC3 fixtures colocated under `uc1/`
 * rather than splitting into a `uc3/` sibling — loader accepts any
 * string key (UC1's ArchetypeKey or one of the §4.3 named fixtures
 * like `lisinopril_recent_start`); the file must exist under
 * `evals/fixtures/uc1/`.
 */
export const loadFixture = (archetype: string): BriefingSnapshot => {
    const path = resolve(FIXTURES_DIR, `${archetype}.json`);
    const chart = JSON.parse(readFileSync(path, 'utf8')) as ChartSnapshot;
    return {
        ...chart,
        labHistory: null,
    };
};

const UC2_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc2');

export type Uc2Scenario = 'a1c_trend_up' | 'a1c_trend_stable' | 'no_lab_history';

/**
 * Load a §4.2 UC2 fixture. Returns a `BriefingSnapshot` whose
 * `labHistory` slot is populated — that's the whole point of UC2.
 * Unlike `loadFixture`, no adaptation is needed: the regenerator
 * emits BriefingSnapshot directly.
 */
export const loadUc2Fixture = (scenario: Uc2Scenario): BriefingSnapshot => {
    const path = resolve(UC2_FIXTURES_DIR, `${scenario}.json`);
    return JSON.parse(readFileSync(path, 'utf8')) as BriefingSnapshot;
};
