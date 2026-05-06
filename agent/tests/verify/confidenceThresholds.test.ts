import { describe, expect, it } from 'vitest';

import {
    ALLERGY_CONFIDENCE_THRESHOLD,
    EXTRACTION_CONFIDENCE_THRESHOLD,
    isLowConfidence,
    parseConfidenceSignal,
} from '../../src/verify/confidenceThresholds.js';

describe('confidenceThresholds — combined-signal rule', () => {
    it('exports the architecture-pinned thresholds (0.7) verbatim', () => {
        // Pinned by W2_ARCHITECTURE.md §"Hard stops on extraction
        // confidence". A future tuning sweep will land in this file
        // (per the architecture: "tuned against eval-suite output");
        // this test keeps the pin honest until that sweep ships.
        expect(EXTRACTION_CONFIDENCE_THRESHOLD).toBe(0.7);
        expect(ALLERGY_CONFIDENCE_THRESHOLD).toBe(0.7);
    });

    it('is high confidence when self-reported >= threshold AND no schema warnings AND full patient match', () => {
        expect(
            isLowConfidence({
                selfReported: 0.95,
                schemaWarningCount: 0,
                patientMatch: 'full',
            }),
        ).toBe(false);
    });

    it('is high confidence at exactly the threshold (>=, not >)', () => {
        expect(
            isLowConfidence({
                selfReported: 0.7,
                schemaWarningCount: 0,
                patientMatch: 'full',
            }),
        ).toBe(false);
    });

    it('is low confidence when self-reported is below the threshold', () => {
        expect(
            isLowConfidence({
                selfReported: 0.65,
                schemaWarningCount: 0,
                patientMatch: 'full',
            }),
        ).toBe(true);
    });

    it('is low confidence when at least one schema warning fired', () => {
        expect(
            isLowConfidence({
                selfReported: 0.95,
                schemaWarningCount: 1,
                patientMatch: 'full',
            }),
        ).toBe(true);
    });

    it('is low confidence on partial patient-match', () => {
        // Architecture pins partial-match as the boundary case the
        // pipeline's patientMatch node flags (typo-shaped DOB,
        // middle-initial difference). The verifier treats partial as
        // failing the full-match condition.
        expect(
            isLowConfidence({
                selfReported: 0.95,
                schemaWarningCount: 0,
                patientMatch: 'partial',
            }),
        ).toBe(true);
    });

    it('treats a missing self-reported number as low confidence (fail-closed default)', () => {
        // Pre-pipeline-shipping artifacts (B.4–B.6 still in flight)
        // can have `selfReported = undefined`. The verifier must not
        // treat absence as high-confidence — the safer default for an
        // unknown signal is "fail closed" so a missing field doesn't
        // accidentally promote a low-quality claim.
        expect(
            isLowConfidence({
                schemaWarningCount: 0,
                patientMatch: 'full',
            }),
        ).toBe(true);
    });
});

describe('confidenceThresholds — parseConfidenceSignal', () => {
    it('parses a fully-shaped signal', () => {
        const out = parseConfidenceSignal({
            self_reported: 0.85,
            schema_warning_count: 0,
            patient_match: 'full',
        });
        expect(out).toEqual({
            selfReported: 0.85,
            schemaWarningCount: 0,
            patientMatch: 'full',
        });
    });

    it('returns null on a non-object input', () => {
        // The artifact's `confidenceSignal` column is `unknown` until
        // the B.4–B.6 pipeline pins the shape. The verifier needs a
        // forgiving parse: a null/undefined/garbage column produces
        // `null`, and the caller treats `null` as "no signal" — which
        // the combined-signal rule resolves to low-confidence per the
        // fail-closed default.
        expect(parseConfidenceSignal(null)).toBeNull();
        expect(parseConfidenceSignal(undefined)).toBeNull();
        expect(parseConfidenceSignal('not-an-object')).toBeNull();
        expect(parseConfidenceSignal(42)).toBeNull();
    });

    it('drops self-reported when it is not a finite number in [0,1]', () => {
        // Garbage value: NaN, out-of-range, wrong type — drop the
        // field rather than poison the combined check with a value
        // we cannot trust.
        expect(parseConfidenceSignal({ self_reported: 'x' })).toEqual({
            schemaWarningCount: 0,
            patientMatch: 'full',
        });
        expect(parseConfidenceSignal({ self_reported: 1.5 })).toEqual({
            schemaWarningCount: 0,
            patientMatch: 'full',
        });
    });

    it('defaults missing signals to "high confidence" inputs (so isLowConfidence keys on real failures)', () => {
        // Empty-object signal: every field absent. parseConfidenceSignal
        // returns sensible defaults (no warnings, full match) so a
        // future pipeline that emits only `self_reported` resolves
        // cleanly. The fail-closed handling for a *missing* signal
        // happens in `isLowConfidence` (no `selfReported` → low),
        // not here.
        expect(parseConfidenceSignal({})).toEqual({
            schemaWarningCount: 0,
            patientMatch: 'full',
        });
    });

    it('treats schema_warning_count > 0 as the "warning fired" boolean signal', () => {
        const out = parseConfidenceSignal({ schema_warning_count: 3 });
        expect(out?.schemaWarningCount).toBe(3);
    });

    it('coerces unknown patient_match values to partial (fail-closed)', () => {
        const out = parseConfidenceSignal({ patient_match: 'mystery-bucket' });
        expect(out?.patientMatch).toBe('partial');
    });
});
