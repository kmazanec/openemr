/**
 * §B.10 fixture loader — bridges `agent/evals/fixtures/document-extraction/
 * source/manifest.json` and the eval target.
 *
 * Both the per-MR Vitest cases and the LangSmith experiment runner read
 * fixtures through this module so a single source decides:
 *
 *   - which 26 cases run,
 *   - which fixture file each case binds to,
 *   - what the expected pipeline outcome is per case.
 *
 * Stub demographics for the seven fixture archetypes live here too, so
 * the eval target's `fetchChartDemographics` boundary returns the same
 * value every test sees. The four `FixturePatient` archetypes (p01-chen,
 * p02-whitaker, p03-reyes, p04-kowalski) mirror
 * `bin/seed/FixturePatient.php` exactly. The three additional cohort-5
 * archetypes (p05-patel, p06-johnson, p07-nguyen) are demographics
 * fixtures owned by this file — the chart seed pipeline does not (yet)
 * include them, so an integration run of the live system would not
 * have a real chart to match against. The eval target stubs the
 * demographics fetch in both per-MR and experiment runs, so the
 * gap is invisible to the suite's assertions.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { ManifestEntry } from '../fixtures/regenerate-document-extraction.js';
import type { Demographics, SourceReference } from '../../src/snapshot/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURES_ROOT = join(HERE, '..', 'fixtures', 'document-extraction', 'source');
const MANIFEST_PATH = join(FIXTURES_ROOT, 'manifest.json');

interface ManifestFile {
    readonly version: number;
    readonly documents: readonly ManifestEntry[];
}

let cachedManifest: ManifestFile | null = null;

export const loadManifest = async (): Promise<ManifestFile> => {
    if (cachedManifest !== null) return cachedManifest;
    const buf = await readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(buf) as ManifestFile;
    cachedManifest = parsed;
    return parsed;
};

export const loadEntries = async (): Promise<readonly ManifestEntry[]> => {
    return (await loadManifest()).documents;
};

export const loadFixtureBytes = async (entry: ManifestEntry): Promise<Buffer> => {
    return readFile(join(FIXTURES_ROOT, entry.path));
};

/**
 * Stable archetype-keyed pid assignment. The eval target uses these
 * pids on the envelope; matching real-system pids is not required —
 * the production pipeline reads pid from the supervisor envelope, and
 * the eval target stubs the demographics fetch.
 */
const PID_BY_ARCHETYPE: Record<string, number> = Object.freeze({
    'p01-chen': 4001,
    'p02-whitaker': 4002,
    'p03-reyes': 4003,
    'p04-kowalski': 4004,
    'p05-patel': 4005,
    'p06-johnson': 4006,
    'p07-nguyen': 4007,
});

export const pidForArchetype = (archetype: string): number => {
    const pid = PID_BY_ARCHETYPE[archetype];
    if (pid === undefined) {
        throw new Error(`pidForArchetype: unknown archetype ${archetype}`);
    }
    return pid;
};

const dummySource = (): SourceReference => ({
    source_type: 'chart',
    source_id: 'fixture-chart',
    locator: {},
    quote: 'fixture',
});

interface DemographicsFixture {
    readonly displayName: string;
    readonly sex: 'male' | 'female' | 'other' | 'unknown';
    readonly dateOfBirth: string;
    readonly ageYears: number;
}

const DEMOGRAPHICS_BY_ARCHETYPE: Record<string, DemographicsFixture> = Object.freeze({
    'p01-chen': {
        displayName: 'Margaret L. Chen',
        sex: 'female',
        dateOfBirth: '1967-08-14',
        ageYears: 58,
    },
    'p02-whitaker': {
        displayName: 'James E. Whitaker',
        sex: 'male',
        dateOfBirth: '1958-11-03',
        ageYears: 67,
    },
    'p03-reyes': {
        displayName: 'Sofia M. Reyes',
        sex: 'female',
        dateOfBirth: '1983-12-19',
        ageYears: 42,
    },
    'p04-kowalski': {
        displayName: 'Robert Kowalski',
        sex: 'male',
        dateOfBirth: '1971-06-08',
        ageYears: 54,
    },
    'p05-patel': {
        displayName: 'Anita Patel',
        sex: 'female',
        dateOfBirth: '1979-03-22',
        ageYears: 47,
    },
    'p06-johnson': {
        displayName: 'Marcus Johnson',
        sex: 'male',
        dateOfBirth: '1962-09-11',
        ageYears: 63,
    },
    'p07-nguyen': {
        displayName: 'Linh Nguyen',
        sex: 'female',
        dateOfBirth: '1991-07-04',
        ageYears: 34,
    },
});

export const demographicsForArchetype = (archetype: string): Demographics => {
    const fix = DEMOGRAPHICS_BY_ARCHETYPE[archetype];
    if (fix === undefined) {
        throw new Error(`demographicsForArchetype: unknown archetype ${archetype}`);
    }
    return {
        pid: pidForArchetype(archetype),
        uuid: `uuid-${archetype}`,
        displayName: fix.displayName,
        sex: fix.sex,
        dateOfBirth: fix.dateOfBirth,
        ageYears: fix.ageYears,
        source: dummySource(),
    };
};
