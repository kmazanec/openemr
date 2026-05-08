import { describe, expect, it } from 'vitest';
import {
  BBOX_GRID,
  isFiniteBbox,
  isNormalizedBbox,
  overlayStyleForBbox,
  type Bbox,
} from './bbox';

describe('bbox helpers', () => {
  describe('isFiniteBbox', () => {
    it('accepts a four-tuple of finite non-negative numbers', () => {
      expect(isFiniteBbox([0, 0, 100, 100])).toBe(true);
      expect(isFiniteBbox([12, 34, 56, 78])).toBe(true);
    });

    it('rejects shapes that are not length-4 arrays', () => {
      expect(isFiniteBbox([0, 0, 100])).toBe(false);
      expect(isFiniteBbox([0, 0, 100, 100, 0])).toBe(false);
      expect(isFiniteBbox(null)).toBe(false);
      expect(isFiniteBbox('1,2,3,4')).toBe(false);
    });

    it('rejects negative or non-finite components', () => {
      expect(isFiniteBbox([-1, 0, 100, 100])).toBe(false);
      expect(isFiniteBbox([0, 0, Number.NaN, 100])).toBe(false);
      expect(isFiniteBbox([0, 0, Number.POSITIVE_INFINITY, 100])).toBe(false);
    });
  });

  describe('isNormalizedBbox', () => {
    it('returns true when x+w and y+h fit in the 0..1000 grid', () => {
      expect(isNormalizedBbox([100, 200, 300, 100] as Bbox)).toBe(true);
      // exactly on the upper bound is still normalized
      expect(isNormalizedBbox([0, 0, 1000, 1000] as Bbox)).toBe(true);
    });

    it('returns false for legacy raw-pixel-space bboxes', () => {
      // Pixel-space sample taken from the architecture comment:
      // [55, 228, 820, 38] — x+w = 875 (in-grid) but y+h = 266
      // (in-grid). Grid-space is [55, 228, 820, 38] which is fine.
      // A real legacy pixel space example would land beyond:
      expect(isNormalizedBbox([10, 10, 1500, 50] as Bbox)).toBe(false);
      expect(isNormalizedBbox([10, 900, 50, 200] as Bbox)).toBe(false);
    });
  });

  describe('overlayStyleForBbox', () => {
    it('emits CSS percentages for normalized bboxes with grid padding', () => {
      const style = overlayStyleForBbox([100, 200, 300, 50] as Bbox);
      // Padding (2 grid units) is applied symmetrically around the bbox.
      expect(style.left).toMatch(/^9\.8%$/);
      expect(style.top).toMatch(/^19\.8%$/);
      // Width grew by 2 * pad = 4 grid units -> 30.4%
      expect(style.width).toMatch(/^30\.4%$/);
      // Height grew by 2 * pad = 4 grid units -> 5.4%
      expect(style.height).toMatch(/^5\.4%$/);
    });

    it('clamps padding so the overlay never escapes the grid', () => {
      // Bbox sitting on the top-left corner — pad would push left/top
      // negative without clamping.
      const style = overlayStyleForBbox([0, 0, 100, 100] as Bbox);
      expect(style.left).toBe('0%');
      expect(style.top).toBe('0%');
    });

    it('falls back to absolute pixel positioning for legacy pixel-space bboxes', () => {
      const style = overlayStyleForBbox([55, 228, 820, 38] as Bbox);
      // Legacy bboxes — render as raw pixels; padding doesn't apply.
      // (55+820=875 ≤ 1000 → still grid; pick a clearly out-of-grid example)
      // Use one that's definitively legacy pixel-space:
      const legacy = overlayStyleForBbox([55, 228, 1500, 38] as Bbox);
      expect(legacy.left).toBe('55px');
      expect(legacy.top).toBe('228px');
      expect(legacy.width).toBe('1500px');
      expect(legacy.height).toBe('38px');
      // first style is grid-space; document the assertion
      expect(style.left.endsWith('%')).toBe(true);
    });

    it('treats a 1000-grid bbox bound exactly on the limit as normalized', () => {
      const style = overlayStyleForBbox([0, 0, BBOX_GRID, BBOX_GRID] as Bbox);
      expect(style.left).toBe('0%');
      expect(style.width).toBe('100%');
    });
  });
});
