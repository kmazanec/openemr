import type { AssistantMessageTrendChart, AssistantMessageTrendPoint } from './copilotTypes';

/**
 * Pure helpers behind the inline `TrendChart` component.
 *
 * Lives in `lib/` rather than alongside the component because Vite's
 * react-refresh plugin warns when a `.tsx` file exports both
 * components and non-component values. Splitting the math out keeps
 * fast-refresh happy and lets unit tests poke the helpers without
 * mounting any DOM.
 *
 * The math mirrors the legacy panel.js renderer one-to-one — the two
 * UIs paint the same shape so a future side-by-side comparison stays
 * apples-to-apples.
 */

const WIDTH = 480;
const HEIGHT = 160;
const PAD = { top: 16, right: 16, bottom: 28, left: 40 } as const;

export const TREND_CHART_DIMENSIONS = { WIDTH, HEIGHT, PAD } as const;

/**
 * Parse a reference-range string like `<5.7` / `>100` / `70-180`
 * into a numeric band. Returns `null` for unparsable formats so a
 * malformed range doesn't paint a misleading band — the chart still
 * renders the line on its own.
 */
export function parseTrendRange(raw: string | null): { lo: number; hi: number } | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;
  const ltMatch = /^<\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (ltMatch !== null) {
    const hi = Number(ltMatch[1]);
    if (Number.isFinite(hi)) return { lo: -Infinity, hi };
  }
  const gtMatch = /^>\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (gtMatch !== null) {
    const lo = Number(gtMatch[1]);
    if (Number.isFinite(lo)) return { lo, hi: Infinity };
  }
  const rangeMatch = /^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (rangeMatch !== null) {
    const lo = Number(rangeMatch[1]);
    const hi = Number(rangeMatch[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
      return { lo, hi };
    }
  }
  return null;
}

/**
 * Format an ISO-8601 timestamp as a short axis label. `Apr 1` for
 * single-year series, `Apr '25` for multi-year. Falls back to the
 * leading 10 chars of the input on parse failure so a malformed
 * `observedAt` doesn't blank the axis.
 */
export function formatTrendDate(iso: string, includeYear: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.length > 10 ? iso.slice(0, 10) : iso;
  }
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  if (includeYear) {
    const yy = String(d.getUTCFullYear()).slice(-2);
    return `${month} '${yy}`;
  }
  return `${month} ${String(d.getUTCDate())}`;
}

/**
 * Caption above the chart — reason-driven so the doctor sees *why*
 * a chart is here. `follow_up_lab_question` covers both trend-style
 * and plain-lookup phrasings, so "recent values" reads naturally
 * for either.
 */
export function trendChartCaption(chart: AssistantMessageTrendChart): string {
  const unit = chart.unit !== null ? ` (${chart.unit})` : '';
  if (chart.reason === 'fresh_lab_with_history') {
    return `${chart.analyte}${unit} — new value in context`;
  }
  return `${chart.analyte}${unit} — recent values`;
}

export interface ProjectedPoint extends AssistantMessageTrendPoint {
  cx: number;
  cy: number;
}

export interface ProjectedChart {
  readonly points: readonly ProjectedPoint[];
  readonly path: string;
  readonly band: { y: number; height: number } | null;
  readonly yAxis: {
    yLabelMin: string;
    yLabelMax: string;
    yMinPx: number;
    yMaxPx: number;
  };
  readonly xAxis: { firstLabel: string; lastLabel: string };
}

/**
 * Project the chart input into pixel coordinates the SVG renderer
 * can drop into attributes. Returns `null` for fewer than two
 * points; the renderer treats `null` as "draw nothing".
 */
export function projectChart(chart: AssistantMessageTrendChart): ProjectedChart | null {
  const points = chart.points;
  if (points.length < 2) return null;

  const xs = points.map((p) => {
    const t = Date.parse(p.observedAt);
    return Number.isFinite(t) ? t : 0;
  });
  const ys = points.map((p) => p.value);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = xMax - xMin || 1;

  const range = parseTrendRange(chart.referenceRange);
  const yCandidates = ys.slice();
  if (range !== null) {
    if (Number.isFinite(range.lo)) yCandidates.push(range.lo);
    if (Number.isFinite(range.hi)) yCandidates.push(range.hi);
  }
  const yMinRaw = Math.min(...yCandidates);
  const yMaxRaw = Math.max(...yCandidates);
  const ySpanRaw = yMaxRaw - yMinRaw || Math.max(Math.abs(yMaxRaw), 1) * 0.1;
  const yPad = ySpanRaw * 0.12;
  const yMin = yMinRaw - yPad;
  const yMax = yMaxRaw + yPad;
  const ySpan = yMax - yMin || 1;

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const xPx = (x: number): number => PAD.left + ((x - xMin) / xSpan) * plotW;
  const yPx = (y: number): number => PAD.top + (1 - (y - yMin) / ySpan) * plotH;

  let band: { y: number; height: number } | null = null;
  if (range !== null) {
    const bandHi = Number.isFinite(range.hi) ? Math.min(range.hi, yMax) : yMax;
    const bandLo = Number.isFinite(range.lo) ? Math.max(range.lo, yMin) : yMin;
    if (bandHi > bandLo) {
      const yTop = yPx(bandHi);
      const yBottom = yPx(bandLo);
      band = { y: yTop, height: yBottom - yTop };
    }
  }

  const projected: ProjectedPoint[] = points.map((p, i) => ({
    ...p,
    cx: xPx(xs[i]!),
    cy: yPx(ys[i]!),
  }));
  const path = projected
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${String(p.cx)},${String(p.cy)}`)
    .join(' ');

  const yLabel = (val: number): string => {
    const rounded = Math.abs(val) >= 100 ? Math.round(val) : Math.round(val * 10) / 10;
    return String(rounded);
  };
  const firstYear = new Date(points[0]!.observedAt).getUTCFullYear();
  const lastYear = new Date(points[points.length - 1]!.observedAt).getUTCFullYear();
  const includeYear =
    Number.isFinite(firstYear) && Number.isFinite(lastYear) && firstYear !== lastYear;

  return {
    points: projected,
    path,
    band,
    yAxis: {
      yLabelMin: yLabel(yMinRaw),
      yLabelMax: yLabel(yMaxRaw),
      yMinPx: yPx(yMinRaw),
      yMaxPx: yPx(yMaxRaw),
    },
    xAxis: {
      firstLabel: formatTrendDate(points[0]!.observedAt, includeYear),
      lastLabel: formatTrendDate(points[points.length - 1]!.observedAt, includeYear),
    },
  };
}
