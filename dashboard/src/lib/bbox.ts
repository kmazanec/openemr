// Bounding-box helpers shared by the document viewer.
//
// The vision pipeline records bboxes as `[x, y, w, h]` integers on a
// 0..1000 grid (thousandths of the page's width/height) — see the
// rationale in W2_ARCHITECTURE.md §"Click-to-source UI" and the
// legacy implementation at
// interface/modules/.../public/js/documentViewer.js. The 1000-grid
// is independent of rasterizer DPI, vision-API resize, and our own
// PDF.js render scale, so we can render with CSS percentages and
// the overlay scales with whatever pixel size the page lands at.
//
// Older snapshots produced before the convention landed carried
// bboxes in raw pixel space (x+w well beyond 1000). We treat any
// bbox where `x+w > 1000` or `y+h > 1000` as "legacy pixel-space"
// and fall back to absolute pixel positioning so old conversations
// still render a defensible highlight.

export const BBOX_GRID = 1000;

// Two grid units (~0.2% of page; ~3px on a 1456-tall image) of
// padding on each side absorbs sub-pixel float drift after the
// percent → CSS conversion without making the highlight noticeably
// wider or taller than the row itself.
export const BBOX_PAD = 2;

export type Bbox = readonly [number, number, number, number];

export function isFiniteBbox(bbox: unknown): bbox is Bbox {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  return bbox.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

export function isNormalizedBbox(bbox: Bbox): boolean {
  const [x, y, w, h] = bbox;
  return x + w <= BBOX_GRID && y + h <= BBOX_GRID;
}

export interface OverlayStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

/**
 * Build the absolute-positioned overlay CSS for a given bbox. The
 * caller positions a `<div>` inside a containing block whose
 * coordinate system matches the bbox (the `<canvas>` wrapper for
 * PDFs, the `<img>` wrapper for images).
 *
 * Returns CSS percentage values for normalized bboxes and pixel
 * values for legacy pixel-space bboxes — the discriminator is
 * `isNormalizedBbox`.
 */
export function overlayStyleForBbox(bbox: Bbox): OverlayStyle {
  const [x, y, w, h] = bbox;
  if (isNormalizedBbox(bbox)) {
    const px = Math.max(0, x - BBOX_PAD);
    const py = Math.max(0, y - BBOX_PAD);
    const pw = Math.min(BBOX_GRID - px, w + 2 * BBOX_PAD);
    const ph = Math.min(BBOX_GRID - py, h + 2 * BBOX_PAD);
    return {
      left: `${(px / BBOX_GRID) * 100}%`,
      top: `${(py / BBOX_GRID) * 100}%`,
      width: `${(pw / BBOX_GRID) * 100}%`,
      height: `${(ph / BBOX_GRID) * 100}%`,
    };
  }
  return {
    left: `${Math.max(0, x)}px`,
    top: `${Math.max(0, y)}px`,
    width: `${w}px`,
    height: `${h}px`,
  };
}
