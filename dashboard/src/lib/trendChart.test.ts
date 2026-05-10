import { describe, expect, it } from 'vitest';
import { formatTrendDate, parseTrendRange, projectChart, trendChartCaption } from './trendChart';
import type { AssistantMessageTrendChart, AssistantMessageTrendPoint } from './copilotTypes';

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

describe('parseTrendRange', () => {
  it('parses "<5.7" as upper-bound', () => {
    expect(parseTrendRange('<5.7')).toEqual({ lo: -Infinity, hi: 5.7 });
  });
  it('parses ">100" as lower-bound', () => {
    expect(parseTrendRange('>100')).toEqual({ lo: 100, hi: Infinity });
  });
  it('parses "70-180" as a closed range', () => {
    expect(parseTrendRange('70-180')).toEqual({ lo: 70, hi: 180 });
  });
  it('parses en-dash variant "70–180"', () => {
    expect(parseTrendRange('70–180')).toEqual({ lo: 70, hi: 180 });
  });
  it('returns null for null / unparsable input', () => {
    expect(parseTrendRange(null)).toBeNull();
    expect(parseTrendRange('')).toBeNull();
    expect(parseTrendRange('positive')).toBeNull();
    expect(parseTrendRange('5.7 to 7.0')).toBeNull();
  });
});

describe('formatTrendDate', () => {
  it('returns short month + day when within one year', () => {
    expect(formatTrendDate('2025-04-01T00:00:00Z', false)).toBe('Apr 1');
  });
  it('returns month + two-digit year when spanning years', () => {
    expect(formatTrendDate('2024-09-15T00:00:00Z', true)).toBe("Sep '24");
  });
  it('falls back to the input verbatim on malformed input ≤10 chars', () => {
    expect(formatTrendDate('not-a-date', false)).toBe('not-a-date');
  });
  it('falls back to a 10-char prefix when malformed input is longer', () => {
    expect(formatTrendDate('not-actually-a-date', false)).toBe('not-actual');
  });
});

describe('trendChartCaption', () => {
  it('uses the "new value in context" wording for fresh_lab_with_history', () => {
    expect(trendChartCaption(buildChart())).toBe('Hemoglobin A1c (%) — new value in context');
  });
  it('uses the "recent values" wording for follow_up_lab_question', () => {
    expect(trendChartCaption(buildChart({ reason: 'follow_up_lab_question' }))).toBe(
      'Hemoglobin A1c (%) — recent values',
    );
  });
  it('omits the unit suffix when null', () => {
    expect(trendChartCaption(buildChart({ unit: null }))).toBe(
      'Hemoglobin A1c — new value in context',
    );
  });
});

describe('projectChart', () => {
  it('returns null when fewer than two points are present', () => {
    expect(projectChart(buildChart({ points: [] }))).toBeNull();
    expect(projectChart(buildChart({ points: [point()] }))).toBeNull();
  });
  it('emits a path with one M and one L for two points', () => {
    const projected = projectChart(buildChart());
    expect(projected).not.toBeNull();
    if (projected === null) return;
    expect(projected.path.startsWith('M')).toBe(true);
    expect((projected.path.match(/[ML]/g) ?? []).length).toBe(2);
  });
  it('includes the reference-range band when the range is parsable', () => {
    const projected = projectChart(buildChart());
    expect(projected?.band).not.toBeNull();
  });
  it('omits the band when the range is unparsable', () => {
    const projected = projectChart(buildChart({ referenceRange: 'positive' }));
    expect(projected?.band).toBeNull();
  });
  it('emits a per-point numeric label using the same rounding as the y-axis', () => {
    const projected = projectChart(buildChart({
      referenceRange: '0-200',
      points: [
        point({ observedAt: '2024-01-01T00:00:00Z', value: 142.7, abnormal: false }),
        point({ observedAt: '2025-01-01T00:00:00Z', value: 7.42, abnormal: false }),
      ],
    }));
    expect(projected?.points[0]?.label).toBe('143');
    expect(projected?.points[1]?.label).toBe('7.4');
  });
  it('anchors labels above for low-half points and below for high-half points', () => {
    const projected = projectChart(buildChart({
      referenceRange: '0-100',
      points: [
        point({ observedAt: '2024-01-01T00:00:00Z', value: 10, abnormal: false }),
        point({ observedAt: '2025-01-01T00:00:00Z', value: 90, abnormal: true }),
      ],
    }));
    // Low-y-value (=10) sits visually near the bottom of the SVG → label above.
    expect(projected?.points[0]?.labelAnchor).toBe('above');
    // High-y-value (=90) sits visually near the top → label below.
    expect(projected?.points[1]?.labelAnchor).toBe('below');
  });
});
