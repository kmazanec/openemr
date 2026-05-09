/**
 * Unit tests for the §B.4b bbox-snap module. These cover the pure
 * helpers (format detection, xywh normalization, OCR-aware quote
 * matching) without spinning up Tesseract or making network calls;
 * the production snapper (`createBboxSnapper`) is covered by the
 * vision-node integration test which stubs `fetchBytes` and `ocrPage`.
 */

import { describe, expect, it } from 'vitest';

import {
    detectBboxFormat,
    pixelRectToGrid,
    snapExtractionBboxes,
    snapQuoteToOcr,
    toXywh,
    type GridBbox,
    type PageOcr,
} from '../../src/pipeline/bboxSnap.js';

const ocrWord = (
    text: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    line = 1,
    block = 1,
): PageOcr['words'][number] => ({ text, x1, y1, x2, y2, line, block });

const buildPage = (words: readonly PageOcr['words'][number][]): PageOcr => ({
    pageNum: 1,
    width: 1000,
    height: 1000,
    words,
});

describe('detectBboxFormat', () => {
    it('returns xywh when every box satisfies x+w<=1000 and y+h<=1000', () => {
        const boxes: GridBbox[] = [
            [100, 100, 200, 30],
            [300, 400, 100, 30],
        ];
        expect(detectBboxFormat(boxes)).toBe('xywh');
    });

    it('returns xyxy when the majority of boxes overflow the grid summed', () => {
        // Corners-encoded boxes: x+w would exceed 1000, but x2 < 1000.
        const boxes: GridBbox[] = [
            [100, 100, 800, 130],
            [300, 400, 950, 430],
        ];
        expect(detectBboxFormat(boxes)).toBe('xyxy');
    });

    it('breaks ambiguous mixes by majority count', () => {
        const boxes: GridBbox[] = [
            // Two clearly-corners (x+w > 1000)
            [100, 100, 900, 130],
            [200, 200, 950, 230],
            // One ambiguous (could be either)
            [10, 10, 50, 30],
        ];
        expect(detectBboxFormat(boxes)).toBe('xyxy');
    });
});

describe('toXywh', () => {
    it('passes xywh through unchanged', () => {
        expect(toXywh([100, 100, 200, 30], 'xywh')).toEqual([100, 100, 200, 30]);
    });

    it('converts xyxy corners to xywh', () => {
        expect(toXywh([100, 100, 800, 130], 'xyxy')).toEqual([100, 100, 700, 30]);
    });

    it('clamps inverted corners to zero width/height', () => {
        // x2 < x1 — degenerate box. Width clamps to 0 rather than going negative.
        expect(toXywh([500, 500, 100, 100], 'xyxy')).toEqual([500, 500, 0, 0]);
    });
});

describe('pixelRectToGrid', () => {
    it('round-trips a 10%-of-page rectangle to grid units', () => {
        const grid = pixelRectToGrid(
            { x1: 100, y1: 200, x2: 300, y2: 250 },
            { width: 1000, height: 1000 },
        );
        expect(grid).toEqual([100, 200, 200, 50]);
    });

    it('clamps a rectangle that overshoots the page edge', () => {
        // After rounding, x+w would exceed 1000; the helper clamps width
        // so the schema stays valid.
        const grid = pixelRectToGrid(
            { x1: 950, y1: 950, x2: 1010, y2: 1010 },
            { width: 1000, height: 1000 },
        );
        expect(grid[0] + grid[2]).toBeLessThanOrEqual(1000);
        expect(grid[1] + grid[3]).toBeLessThanOrEqual(1000);
    });
});

describe('snapQuoteToOcr', () => {
    it('snaps a single-line quote to its OCR bounding box', () => {
        const page = buildPage([
            ocrWord('Patient', 100, 100, 200, 120),
            ocrWord('Name', 210, 100, 270, 120),
            // The quote tokens live on the same OCR line so the
            // sliding-window matcher can wrap them together.
            ocrWord('Chen,', 100, 150, 160, 170, 2),
            ocrWord('Margaret', 170, 150, 270, 170, 2),
        ]);
        const snap = snapQuoteToOcr('Chen, Margaret', { x: 200, y: 160 }, page);
        expect(snap).not.toBeNull();
        expect(snap!.x1).toBeLessThanOrEqual(100);
        expect(snap!.x2).toBeGreaterThanOrEqual(270);
        expect(snap!.y1).toBeLessThanOrEqual(150);
        expect(snap!.y2).toBeGreaterThanOrEqual(170);
    });

    it('uses the hint center to disambiguate repeated quote text', () => {
        // "Female" appears twice — once at (top-left), once at (top-right).
        // Hint near the right column should pick the right-column instance.
        const page = buildPage([
            ocrWord('Female', 100, 100, 180, 120, 1),
            ocrWord('Female', 600, 100, 680, 120, 1),
        ]);
        const left = snapQuoteToOcr('Female', { x: 130, y: 110 }, page);
        const right = snapQuoteToOcr('Female', { x: 640, y: 110 }, page);
        expect(left).not.toBeNull();
        expect(right).not.toBeNull();
        expect(left!.x1).toBeLessThan(200);
        expect(right!.x1).toBeGreaterThan(500);
    });

    it('returns null when no acceptable match exists on the page', () => {
        const page = buildPage([
            ocrWord('Glucose', 100, 100, 200, 120),
            ocrWord('120', 210, 100, 250, 120),
        ]);
        expect(snapQuoteToOcr('Hemoglobin A1c', { x: 200, y: 110 }, page)).toBeNull();
    });

    it('rejects matches that are too far from the model hint', () => {
        // Quote text exists but only on the opposite side of the page;
        // hint says "near top-left", so the match should be rejected
        // rather than snapping to the far-away token.
        const page = buildPage([ocrWord('Female', 800, 800, 880, 820, 1)]);
        const snap = snapQuoteToOcr('Female', { x: 50, y: 50 }, page);
        expect(snap).toBeNull();
    });
});

describe('snapExtractionBboxes', () => {
    it('snaps every cited bbox in a nested extraction tree', () => {
        const extraction = {
            patient_demographics: {
                name: {
                    value: 'CHEN, MARGARET',
                    page: 1,
                    bbox: [80, 95, 180, 110] as [number, number, number, number],
                    quote: 'CHEN, MARGARET',
                    confidence: 0.99,
                },
            },
            results: [
                {
                    analyte_name: 'Glucose',
                    value: '108',
                    unit: 'mg/dL',
                    collection_date: '2026-04-15',
                    page: 1,
                    bbox: [85, 195, 145, 215] as [number, number, number, number],
                    quote: 'Glucose 108',
                    confidence: 0.95,
                },
            ],
        };
        const page = buildPage([
            ocrWord('CHEN,', 100, 100, 160, 120),
            ocrWord('MARGARET', 170, 100, 280, 120),
            ocrWord('Glucose', 100, 200, 200, 220, 2),
            ocrWord('108', 210, 200, 250, 220, 2),
        ]);
        const summary = snapExtractionBboxes(extraction, [page]);
        expect(summary.totalBboxes).toBe(2);
        expect(summary.snappedBboxes).toBe(2);
        // After snap, the bbox should outline the OCR tokens:
        // CHEN, MARGARET spans (100..280)x(100..120) ≈ (10%..28%)x(10%..12%).
        const nameBbox = extraction.patient_demographics.name.bbox;
        expect(nameBbox[0]).toBeGreaterThanOrEqual(95);
        expect(nameBbox[0]).toBeLessThanOrEqual(105);
        expect(nameBbox[2]).toBeGreaterThanOrEqual(170); // width ≈ 180 grid units
    });

    it('normalizes corners to xywh even when no OCR snap happens', () => {
        // All bboxes use values where x+w > 1000 (triggering the xyxy
        // discriminator) — these can ONLY be corners, never xywh.
        const extraction = {
            patient_demographics: {
                name: {
                    value: 'INVENTED',
                    page: 1,
                    bbox: [100, 100, 800, 130] as [number, number, number, number],
                    quote: 'this quote is not in OCR output',
                    confidence: 0.5,
                },
            },
            results: [
                {
                    analyte_name: 'X',
                    page: 1,
                    bbox: [200, 200, 950, 230] as [number, number, number, number],
                    quote: 'also not in OCR',
                    confidence: 0.5,
                },
            ],
        };
        const page = buildPage([]);
        const summary = snapExtractionBboxes(extraction, [page]);
        expect(summary.formatDetected).toBe('xyxy');
        expect(summary.snappedBboxes).toBe(0);
        // Corners-encoded boxes get normalized to xywh in place.
        expect(extraction.patient_demographics.name.bbox).toEqual([100, 100, 700, 30]);
        expect(extraction.results[0]?.bbox).toEqual([200, 200, 750, 30]);
    });

    it('skips bboxes with empty quote and leaves them untouched', () => {
        const extraction = {
            results: [
                {
                    analyte_name: 'X',
                    page: 1,
                    bbox: [100, 100, 200, 30] as [number, number, number, number],
                    quote: '',
                    confidence: 0.9,
                },
            ],
        };
        const page = buildPage([ocrWord('X', 50, 50, 80, 70)]);
        const summary = snapExtractionBboxes(extraction, [page]);
        expect(summary.totalBboxes).toBe(1);
        expect(summary.snappedBboxes).toBe(0);
        expect(extraction.results[0]?.bbox).toEqual([100, 100, 200, 30]);
    });
});
