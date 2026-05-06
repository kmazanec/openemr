/**
 * §B.6 demographics matcher unit tests.
 *
 * The matcher is the sub-phase's structural-match contract: name and DOB
 * each produce one of {1.0, 0.6, 0.5, 0.0} so the patientMatch node can
 * route confident-match / partial / refuse without invoking any fuzzy
 * scoring at the model layer.
 *
 * Tests are deliberately exhaustive on the shape boundary — the
 * downstream `patientMatch` node tests cover the three-bucket
 * disposition end-to-end; this file pins the per-axis math so a future
 * change to one axis does not silently shift the disposition.
 */

import { describe, expect, it } from 'vitest';

import { matchDob, matchName } from '../../../src/pipeline/match/demographics.js';

describe('matchName', () => {
    it('exact case-insensitive match → 1.0', () => {
        expect(matchName('Margaret L. Chen', 'Margaret L. Chen')).toBe(1.0);
        expect(matchName('margaret l. chen', 'MARGARET L. CHEN')).toBe(1.0);
    });

    it('whitespace-only differences are still exact → 1.0', () => {
        expect(matchName('  Margaret L. Chen  ', 'Margaret L. Chen')).toBe(1.0);
        expect(matchName('Margaret  L.  Chen', 'Margaret L. Chen')).toBe(1.0);
    });

    it('same surname + same first-name initial → 0.6', () => {
        expect(matchName('Maggie Chen', 'Margaret Chen')).toBe(0.6);
        expect(matchName('M. Chen', 'Margaret Chen')).toBe(0.6);
        expect(matchName('Margaret L. Chen', 'M Chen')).toBe(0.6);
    });

    it('same surname but different first-name initial → 0.0', () => {
        expect(matchName('David Chen', 'Margaret Chen')).toBe(0.0);
    });

    it('different surname → 0.0 even with same first name', () => {
        expect(matchName('Margaret Chen', 'Margaret Whitaker')).toBe(0.0);
    });

    it('completely different name → 0.0', () => {
        expect(matchName('Robert Kowalski', 'Margaret Chen')).toBe(0.0);
    });

    it('empty / whitespace-only inputs → 0.0', () => {
        expect(matchName('', 'Margaret Chen')).toBe(0.0);
        expect(matchName('Margaret Chen', '')).toBe(0.0);
        expect(matchName('   ', 'Margaret Chen')).toBe(0.0);
    });

    it('single-token name on either side falls back to surname matcher', () => {
        // Single token treated as the surname (no first-initial axis).
        expect(matchName('Chen', 'Margaret Chen')).toBe(0.6);
        expect(matchName('Margaret Chen', 'Chen')).toBe(0.6);
    });

    it('inverted form "Surname, Given Middle" handled like "Given Middle Surname"', () => {
        expect(matchName('Chen, Margaret L.', 'Margaret L. Chen')).toBe(1.0);
        expect(matchName('Whitaker, James E.', 'James E. Whitaker')).toBe(1.0);
    });
});

describe('matchDob', () => {
    it('exact ISO match → 1.0', () => {
        expect(matchDob('1967-08-14', '1967-08-14')).toBe(1.0);
    });

    it('off by one day forward → 0.5', () => {
        expect(matchDob('1967-08-15', '1967-08-14')).toBe(0.5);
    });

    it('off by one day backward → 0.5', () => {
        expect(matchDob('1967-08-13', '1967-08-14')).toBe(0.5);
    });

    it('off by one day across a month boundary → 0.5', () => {
        expect(matchDob('1967-09-01', '1967-08-31')).toBe(0.5);
    });

    it('off by one day across a year boundary → 0.5', () => {
        expect(matchDob('1968-01-01', '1967-12-31')).toBe(0.5);
    });

    it('off by two days → 0.0', () => {
        expect(matchDob('1967-08-16', '1967-08-14')).toBe(0.0);
    });

    it('different year → 0.0', () => {
        expect(matchDob('1980-08-14', '1967-08-14')).toBe(0.0);
    });

    it('invalid extracted DOB string → 0.0 (do not crash)', () => {
        expect(matchDob('not-a-date', '1967-08-14')).toBe(0.0);
    });

    it('invalid chart DOB string → 0.0', () => {
        expect(matchDob('1967-08-14', 'not-a-date')).toBe(0.0);
    });

    it('null on either side → 0.0', () => {
        expect(matchDob(null, '1967-08-14')).toBe(0.0);
        expect(matchDob('1967-08-14', null)).toBe(0.0);
        expect(matchDob(null, null)).toBe(0.0);
    });

    it('accepts MM/DD/YYYY format on the extracted side and normalises', () => {
        // Vision sometimes returns the literal quoted form ("08/14/1967")
        // even when the schema's `value` is supposed to be ISO. Match
        // both — refusing on a format mismatch would be a false negative.
        expect(matchDob('08/14/1967', '1967-08-14')).toBe(1.0);
        expect(matchDob('08/15/1967', '1967-08-14')).toBe(0.5);
    });
});
