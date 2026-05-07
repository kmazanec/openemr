/**
 * Unit tests for the per-case demographics overrides in
 * `documentExtractionFixtures`.
 *
 * The cohort-5 fax-packet TIFFs and the W2 lab/intake PDFs were
 * authored independently and pin different identities for the same
 * archetype tag. `chartDemographicsForCase` /
 * `documentDemographicsForCase` resolve which identity a given
 * manifest entry should use so the chart side and document side
 * agree at `patientMatch` time. These tests pin that resolution so a
 * future refactor cannot silently put us back in the "Margaret L.
 * Chen 1967-08-14" vs "Margaret Chen 1968-03-12" mismatch state that
 * caused the fax-packet rebaseline regression.
 */

import { describe, expect, it } from 'vitest';

import type { ManifestEntry } from '../fixtures/regenerate-document-extraction.js';

import {
    chartDemographicsForCase,
    demographicsForArchetype,
    documentDemographicsForCase,
} from './documentExtractionFixtures.js';

const buildEntry = (overrides: Partial<ManifestEntry> = {}): ManifestEntry => ({
    id: 'lab-chen-fax-packet',
    caseKind: 'lab-pdf-fax-packet',
    path: 'tiffs/p01-chen-fax-packet.tiff',
    docType: 'lab_pdf',
    mime: 'image/tiff',
    pageCount: 1,
    patient: { archetype: 'p01-chen', displayName: 'Chen' },
    expectedStatus: 'persisted',
    notes: 'fixture',
    ...overrides,
});

describe('chartDemographicsForCase', () => {
    it('returns the TIFF override identity for a fax-packet path', () => {
        const demo = chartDemographicsForCase(buildEntry());
        expect(demo.displayName).toBe('Margaret Chen');
        expect(demo.dateOfBirth).toBe('1968-03-12');
    });

    it('falls back to the archetype default for a lab PDF path with no override', () => {
        const demo = chartDemographicsForCase(
            buildEntry({
                id: 'lab-chen-lipid-panel',
                caseKind: 'lab-pdf-multi-panel',
                path: 'lab-results/p01-chen-lipid-panel.pdf',
                mime: 'application/pdf',
            }),
        );
        expect(demo.displayName).toBe('Margaret L. Chen');
        expect(demo.dateOfBirth).toBe('1967-08-14');
    });

    it('uses the envelope archetype (not the document) for adversarial-wrong-patient', () => {
        // Document is Chen's lab PDF, envelope is Kowalski. Chart side
        // must come from Kowalski so patientMatch can refuse.
        const demo = chartDemographicsForCase(
            buildEntry({
                id: 'adversarial-wrong-patient',
                caseKind: 'adversarial-wrong-patient',
                path: 'lab-results/p01-chen-lipid-panel.pdf',
                mime: 'application/pdf',
                patient: { archetype: 'p04-kowalski', displayName: 'Kowalski' },
            }),
        );
        expect(demo.displayName).toBe('Robert Kowalski');
        expect(demo.dateOfBirth).toBe('1971-06-08');
    });

    it('falls back to archetype for synthetic fixtures with no document identity', () => {
        const demo = chartDemographicsForCase(
            buildEntry({
                id: 'degraded-blank',
                caseKind: 'degraded-blank',
                path: 'synthetic/blank.pdf',
                mime: 'application/pdf',
            }),
        );
        // Same as the archetype default — synthetic docs have no
        // patient identity so patientMatch never runs (earlier nodes
        // refuse first).
        expect(demo.displayName).toBe(demographicsForArchetype('p01-chen').displayName);
    });

    it('returns the same TIFF identity for both lab and intake fax-packet uses', () => {
        // intake-johnson-fax-packet and degraded-smudged both bind to
        // the same p06 TIFF. Both must resolve to the same identity.
        const intake = chartDemographicsForCase(
            buildEntry({
                id: 'intake-johnson-fax-packet',
                caseKind: 'intake-form-image',
                path: 'tiffs/p06-johnson-fax-packet.tiff',
                docType: 'intake_form',
                patient: { archetype: 'p06-johnson', displayName: 'Johnson' },
            }),
        );
        const degraded = chartDemographicsForCase(
            buildEntry({
                id: 'degraded-smudged',
                caseKind: 'degraded-smudged',
                path: 'tiffs/p06-johnson-fax-packet.tiff',
                docType: 'lab_pdf',
                patient: { archetype: 'p06-johnson', displayName: 'Johnson' },
            }),
        );
        expect(intake.displayName).toBe('Marcus Johnson');
        expect(intake.dateOfBirth).toBe('1954-02-08');
        expect(degraded.displayName).toBe(intake.displayName);
        expect(degraded.dateOfBirth).toBe(intake.dateOfBirth);
    });
});

describe('documentDemographicsForCase', () => {
    it('returns the TIFF override identity for a fax-packet path', () => {
        const demo = documentDemographicsForCase(buildEntry());
        expect(demo.displayName).toBe('Margaret Chen');
        expect(demo.dateOfBirth).toBe('1968-03-12');
    });

    it('returns Chen for adversarial-wrong-patient (document is Chen, not the envelope)', () => {
        // The stub vision invoker uses this so its output mirrors what
        // real vision would extract from the actual document bytes
        // (Chen's lab PDF), not the envelope archetype (Kowalski).
        const demo = documentDemographicsForCase(
            buildEntry({
                id: 'adversarial-wrong-patient',
                caseKind: 'adversarial-wrong-patient',
                path: 'lab-results/p01-chen-lipid-panel.pdf',
                mime: 'application/pdf',
                patient: { archetype: 'p04-kowalski', displayName: 'Kowalski' },
            }),
        );
        expect(demo.displayName).toBe('Margaret L. Chen');
    });

    it('chart and document identities agree for non-adversarial fax-packet cases', () => {
        // The patientMatch invariant: chart and document demographics
        // align so a clean fax-packet case persists rather than failing.
        const entry = buildEntry();
        expect(chartDemographicsForCase(entry)).toEqual(documentDemographicsForCase(entry));
    });
});
