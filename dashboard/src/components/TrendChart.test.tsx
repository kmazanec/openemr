import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrendChart } from './TrendChart';
import type { AssistantMessageTrendChart, AssistantMessageTrendPoint } from '../lib/copilotTypes';

function point(overrides: Partial<AssistantMessageTrendPoint> = {}): AssistantMessageTrendPoint {
  return {
    observedAt: '2025-04-01T00:00:00Z',
    value: 7.0,
    abnormal: false,
    ...overrides,
  };
}

function buildChart(
  overrides: Partial<AssistantMessageTrendChart> = {},
): AssistantMessageTrendChart {
  return {
    analyte: 'Hemoglobin A1c',
    unit: '%',
    referenceRange: '<5.7',
    points: [
      point({ observedAt: '2024-09-01T00:00:00Z', value: 7.4, abnormal: true }),
      point({ observedAt: '2025-04-01T00:00:00Z', value: 8.4, abnormal: true }),
    ],
    reason: 'fresh_lab_with_history',
    groundedInClaimIds: ['c1'],
    ...overrides,
  };
}

describe('<TrendChart />', () => {
  it('renders nothing when chart prop is undefined', () => {
    const { container } = render(<TrendChart chart={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when fewer than two points are present', () => {
    const { container } = render(<TrendChart chart={buildChart({ points: [point()] })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a figure with caption and SVG when valid', () => {
    render(<TrendChart chart={buildChart()} />);
    const figure = screen.getByTestId('copilot-trend-chart');
    expect(figure).toHaveAttribute('data-reason', 'fresh_lab_with_history');
    expect(figure.textContent).toContain('Hemoglobin A1c (%) — new value in context');
    expect(screen.getByTestId('copilot-trend-svg')).toBeInTheDocument();
  });

  it('emits one circle per point with the abnormal modifier set per-point', () => {
    render(
      <TrendChart
        chart={buildChart({
          points: [
            point({ observedAt: '2024-01-01T00:00:00Z', value: 5.5, abnormal: false }),
            point({ observedAt: '2025-04-01T00:00:00Z', value: 8.4, abnormal: true }),
          ],
        })}
      />,
    );
    const dots = screen.getAllByTestId('copilot-trend-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute('data-abnormal', 'false');
    expect(dots[0]?.getAttribute('class')).not.toContain('--abnormal');
    expect(dots[1]).toHaveAttribute('data-abnormal', 'true');
    expect(dots[1]?.getAttribute('class')).toContain('--abnormal');
  });

  it('renders a reference-range band when the range is parsable', () => {
    render(<TrendChart chart={buildChart()} />);
    expect(screen.getByTestId('copilot-trend-band')).toBeInTheDocument();
  });

  it('omits the band when the reference range is unparsable', () => {
    render(<TrendChart chart={buildChart({ referenceRange: 'positive' })} />);
    expect(screen.queryByTestId('copilot-trend-band')).toBeNull();
  });

  it('uses year-tagged x-axis labels when the series spans calendar years', () => {
    render(
      <TrendChart
        chart={buildChart({
          points: [
            point({ observedAt: '2023-09-01T00:00:00Z', value: 7.4, abnormal: true }),
            point({ observedAt: '2025-04-01T00:00:00Z', value: 8.4, abnormal: true }),
          ],
        })}
      />,
    );
    const svg = screen.getByTestId('copilot-trend-svg');
    expect(svg.textContent).toContain("Sep '23");
    expect(svg.textContent).toContain("Apr '25");
  });

  it('exposes value, observedAt, and tooltip text on each dot', () => {
    render(<TrendChart chart={buildChart()} />);
    const dots = screen.getAllByTestId('copilot-trend-dot');
    expect(dots[0]).toHaveAttribute('data-value', '7.4');
    expect(dots[0]).toHaveAttribute('data-observed-at', '2024-09-01T00:00:00Z');
    expect(dots[0]?.querySelector('title')?.textContent).toBe('7.4 % on 2024-09-01');
  });
});
