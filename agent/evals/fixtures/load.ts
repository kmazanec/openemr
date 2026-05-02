import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChartSnapshot } from '../../src/snapshot/types.js';
import type { ArchetypeKey } from './regenerate.js';

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc1');

export const loadFixture = (archetype: ArchetypeKey): ChartSnapshot => {
    const path = resolve(FIXTURES_DIR, `${archetype}.json`);
    return JSON.parse(readFileSync(path, 'utf8')) as ChartSnapshot;
};
