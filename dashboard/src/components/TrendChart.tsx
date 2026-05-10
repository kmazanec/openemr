import type { ReactElement } from 'react';
import type { AssistantMessageTrendChart } from '../lib/copilotTypes';
import { TREND_CHART_DIMENSIONS, projectChart, trendChartCaption } from '../lib/trendChart';

/**
 * Inline trend-chart attachment for the React copilot panel.
 *
 * Hand-rolled SVG line chart — same visual contract as the legacy
 * panel's `renderTrendChart` in `panel.js`, ported to a typed
 * component. No external charting library:
 *
 *   - Zero dependency footprint and zero new asset to load.
 *   - Pure React: no canvas instance to manage on re-render.
 *   - The chart is intentionally simple — single line over time,
 *     ≤24 points, optional reference-range band.
 *
 * If a future requirement (rich tooltips, multi-series overlays)
 * outgrows the SVG, swapping in a chart library is a self-contained
 * change — the wire shape (`AssistantMessageTrendChart`) is
 * renderer-agnostic and stays put.
 *
 * Pure helpers (range parser, date formatter, projection math) live
 * in `lib/trendChart.ts` so this `.tsx` only exports a component —
 * keeps Vite's react-refresh plugin happy.
 */

const { WIDTH, HEIGHT, PAD } = TREND_CHART_DIMENSIONS;

export function TrendChart({
  chart,
}: {
  chart: AssistantMessageTrendChart | undefined;
}): ReactElement | null {
  if (chart === undefined) return null;
  const projected = projectChart(chart);
  if (projected === null) return null;
  const caption = trendChartCaption(chart);

  return (
    <figure
      className="copilot-trend mt-2 mb-0 p-2 bg-white border rounded"
      data-testid="copilot-trend-chart"
      data-reason={chart.reason}
    >
      <figcaption className="copilot-trend__caption small fw-semibold mb-1 text-secondary-emphasis">
        {caption}
      </figcaption>
      <svg
        className="copilot-trend__svg w-100"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="img"
        aria-label={`${chart.analyte} trend`}
        data-testid="copilot-trend-svg"
      >
        {projected.band !== null && (
          <rect
            className="copilot-trend__band"
            x={PAD.left}
            y={projected.band.y}
            width={WIDTH - PAD.left - PAD.right}
            height={projected.band.height}
            data-testid="copilot-trend-band"
          />
        )}
        <path className="copilot-trend__line" d={projected.path} data-testid="copilot-trend-line" />
        {projected.points.map((p, i) => (
          <circle
            key={`${p.observedAt}-${String(i)}`}
            className={
              p.abnormal ? 'copilot-trend__dot copilot-trend__dot--abnormal' : 'copilot-trend__dot'
            }
            cx={p.cx}
            cy={p.cy}
            r={3.5}
            data-testid="copilot-trend-dot"
            data-value={String(p.value)}
            data-observed-at={p.observedAt}
            data-abnormal={p.abnormal ? 'true' : 'false'}
          >
            <title>
              {String(p.value)}
              {chart.unit !== null ? ` ${chart.unit}` : ''} on {p.observedAt.slice(0, 10)}
            </title>
          </circle>
        ))}
        {projected.points.map((p, i) => (
          <text
            key={`label-${p.observedAt}-${String(i)}`}
            className={
              p.abnormal
                ? 'copilot-trend__point-label copilot-trend__point-label--abnormal'
                : 'copilot-trend__point-label'
            }
            x={p.cx}
            y={p.labelAnchor === 'above' ? p.cy - 7 : p.cy + 14}
            textAnchor="middle"
            data-testid="copilot-trend-point-label"
            data-anchor={p.labelAnchor}
          >
            {p.label}
          </text>
        ))}
        <text
          className="copilot-trend__axis-label"
          x={PAD.left - 6}
          y={projected.yAxis.yMaxPx}
          textAnchor="end"
          dominantBaseline="middle"
        >
          {projected.yAxis.yLabelMax}
        </text>
        <text
          className="copilot-trend__axis-label"
          x={PAD.left - 6}
          y={projected.yAxis.yMinPx}
          textAnchor="end"
          dominantBaseline="middle"
        >
          {projected.yAxis.yLabelMin}
        </text>
        <text className="copilot-trend__axis-label" x={PAD.left} y={HEIGHT - 8} textAnchor="start">
          {projected.xAxis.firstLabel}
        </text>
        <text
          className="copilot-trend__axis-label"
          x={WIDTH - PAD.right}
          y={HEIGHT - 8}
          textAnchor="end"
        >
          {projected.xAxis.lastLabel}
        </text>
      </svg>
    </figure>
  );
}
