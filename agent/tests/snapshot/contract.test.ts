import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    ChartSnapshotDecodeError,
    decodeChartSnapshot,
} from '../../src/snapshot/decode.js';
import type { ChartSnapshot } from '../../src/snapshot/types.js';

/**
 * Plan §A.5 cross-language contract: the PHP-side
 * `ChartSnapshotFixtureTest` writes one full-snapshot JSON per archetype
 * under `tests/Tests/Isolated/Modules/ClinicalCopilot/Snapshot/
 * fixtures/snapshot/`. This test consumes those fixtures with the
 * agent-side decoder. Drift in `ChartSnapshot::toArray()`, the @phpstan-typed
 * shape, or the TS decoder will fail one of these cases with a precise diff.
 *
 * Date fields are masked as `<DATE>` / `<DATETIME>` because Faker's dates
 * slide with the system clock — see the fixtures README. We substitute
 * pinned ISO strings before decoding so the decoder's string-typed date
 * fields pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(
    here,
    '../../../tests/Tests/Isolated/Modules/ClinicalCopilot/Snapshot/fixtures/snapshot',
);

const PINNED_DATE = '2026-04-30';
const PINNED_DATETIME = '2026-04-30T09:00:00+00:00';

const loadFixture = (filename: string): unknown => {
    const raw = readFileSync(join(fixturesDir, filename), 'utf8');
    const substituted = raw
        .replaceAll('"<DATE>"', JSON.stringify(PINNED_DATE))
        .replaceAll('"<DATETIME>"', JSON.stringify(PINNED_DATETIME));
    return JSON.parse(substituted);
};

const fixtureFiles = readdirSync(fixturesDir).filter((name) => name.endsWith('.json')).sort();

describe('ChartSnapshot cross-language contract', () => {
    it('finds fixtures under the PHP-side path', () => {
        // If this fails, the §2 ChartSnapshotFixtureTest moved or was
        // deleted. The TS contract anchor needs an updated path.
        expect(fixtureFiles.length).toBeGreaterThanOrEqual(6);
    });

    it.each(fixtureFiles)('decodes %s through the TS decoder', (filename) => {
        const raw = loadFixture(filename);
        let decoded: ChartSnapshot;
        try {
            decoded = decodeChartSnapshot(raw);
        } catch (err) {
            if (err instanceof ChartSnapshotDecodeError) {
                throw new Error(
                    `decodeChartSnapshot rejected fixture ${filename} at ${err.path}: ${err.message}. ` +
                        'Either the PHP ChartSnapshot::toArray() shape drifted, or the TS ' +
                        'decoder/types.ts no longer mirrors it. Update both sides together.',
                    { cause: err },
                );
            }
            throw err;
        }
        // Smoke: every fixture has a patient and the patient block decodes.
        expect(decoded.patient.uuid).toMatch(/[0-9a-f-]{36}/);
        expect(decoded.patient.pid).toBeGreaterThan(0);
    });

    it('diabetic archetype carries E11.9 and metformin (archetype invariants)', () => {
        const decoded = decodeChartSnapshot(loadFixture('diabetic.json'));
        const codes = decoded.diagnoses.map((d) => d.code);
        expect(codes).toContain('E11.9');
        const drugs = decoded.prescriptions.map((m) => m.name.toLowerCase());
        expect(drugs.some((d) => d.includes('metformin'))).toBe(true);
    });

    it('hypertensive archetype carries I10 and lisinopril (archetype invariants)', () => {
        const decoded = decodeChartSnapshot(loadFixture('hypertensive.json'));
        const codes = decoded.diagnoses.map((d) => d.code);
        expect(codes).toContain('I10');
        const drugs = decoded.prescriptions.map((m) => m.name.toLowerCase());
        expect(drugs.some((d) => d.includes('lisinopril'))).toBe(true);
    });

    it('healthy_adult archetype has no diagnoses or medications', () => {
        const decoded = decodeChartSnapshot(loadFixture('healthy_adult.json'));
        expect(decoded.diagnoses).toHaveLength(0);
        expect(decoded.prescriptions).toHaveLength(0);
    });

    it('every list item carries a non-empty source reference', () => {
        // The cross-cutting contract from ARCHITECTURE.md §"Source
        // Reference": every clinical fact must cite. If a future PHP
        // change emits a list item without a `source`, the decoder
        // already throws — this test makes the assertion visible.
        for (const filename of fixtureFiles) {
            const decoded = decodeChartSnapshot(loadFixture(filename));
            const items = [
                ...decoded.diagnoses,
                ...decoded.prescriptions,
                ...decoded.allergies,
                ...decoded.labs,
                ...decoded.encounters,
            ];
            for (const item of items) {
                expect(item.source.system).not.toBe('');
                expect(item.source.recordType).not.toBe('');
                expect(item.source.recordId).not.toBe('');
            }
        }
    });
});
