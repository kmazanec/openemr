/**
 * Pure-function tests for the Clinical Co-Pilot panel's trend-chart
 * renderer. The chart is a hand-rolled SVG (no external library) so the
 * helpers are testable from node without a DOM.
 *
 * Coverage:
 *
 *   - `parseTrendRange(raw)` — normalizes "<5.7" / ">100" / "70-180"
 *     reference-range strings into numeric bands; rejects unparsable
 *     formats so a malformed range never paints a misleading band.
 *   - `formatTrendDate(iso, includeYear)` — short axis labels, with
 *     year-tagged variant when the series spans multiple calendar years.
 *   - `trendChartCaption(chart)` — caption mirrors the decision rule
 *     so the doctor sees *why* a chart is being shown.
 *   - `renderTrendChartSvg(chart)` — produces an SVG payload
 *     (path + dots + axis labels + optional band) for a valid trend;
 *     refuses to draw when fewer than two points are present (matching
 *     the `decideTrendChart` server-side contract).
 *   - `renderTrendChart(chart)` — wraps the SVG in a `<figure>` with
 *     caption and reason metadata; returns the empty string for
 *     invalid input so the bubble HTML stays clean.
 */

const helpers = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

const {
    renderTrendChart,
    renderTrendChartSvg,
    trendChartCaption,
    parseTrendRange,
    formatTrendDate,
} = helpers;

const sampleChart = (overrides = {}) => ({
    analyte: 'Hemoglobin A1c',
    unit: '%',
    referenceRange: '<5.7',
    reason: 'fresh_lab_with_history',
    groundedInClaimIds: ['c1'],
    points: [
        { observedAt: '2024-09-01T00:00:00Z', value: 7.4, abnormal: true },
        { observedAt: '2025-04-01T00:00:00Z', value: 8.4, abnormal: true },
    ],
    ...overrides,
});

describe('parseTrendRange', () => {
    test('parses "<5.7" as upper-bound', () => {
        expect(parseTrendRange('<5.7')).toEqual({ lo: -Infinity, hi: 5.7 });
    });
    test('parses ">100" as lower-bound', () => {
        expect(parseTrendRange('>100')).toEqual({ lo: 100, hi: Infinity });
    });
    test('parses "70-180" as a closed range', () => {
        expect(parseTrendRange('70-180')).toEqual({ lo: 70, hi: 180 });
    });
    test('parses en-dash variant "70–180"', () => {
        expect(parseTrendRange('70–180')).toEqual({ lo: 70, hi: 180 });
    });
    test('returns null for null / unparsable input', () => {
        expect(parseTrendRange(null)).toBeNull();
        expect(parseTrendRange('')).toBeNull();
        expect(parseTrendRange('positive')).toBeNull();
        expect(parseTrendRange('5.7 to 7.0')).toBeNull();
    });
});

describe('formatTrendDate', () => {
    test('returns short month + day when within one year', () => {
        expect(formatTrendDate('2025-04-01T00:00:00Z', false)).toBe('Apr 1');
    });
    test('returns month + two-digit year when spanning years', () => {
        expect(formatTrendDate('2024-09-15T00:00:00Z', true)).toBe("Sep '24");
    });
    test('falls back to leading 10 chars on malformed input', () => {
        expect(formatTrendDate('not-a-date', false)).toBe('not-a-date');
    });
});

describe('trendChartCaption', () => {
    test('uses the "new value in context" wording for fresh_lab_with_history', () => {
        const caption = trendChartCaption(sampleChart());
        expect(caption).toBe('Hemoglobin A1c (%) — new value in context');
    });
    test('uses the "recent values" wording for follow_up_lab_question', () => {
        const caption = trendChartCaption(sampleChart({ reason: 'follow_up_lab_question' }));
        expect(caption).toBe('Hemoglobin A1c (%) — recent values');
    });
    test('omits the unit suffix when null', () => {
        const caption = trendChartCaption(sampleChart({ unit: null }));
        expect(caption).toBe('Hemoglobin A1c — new value in context');
    });
});

describe('renderTrendChartSvg', () => {
    test('returns the empty string for fewer than two points', () => {
        expect(renderTrendChartSvg(sampleChart({ points: [] }))).toBe('');
        expect(renderTrendChartSvg(sampleChart({ points: [{ observedAt: 'x', value: 1, abnormal: false }] }))).toBe('');
    });
    test('emits a path with one M and one L for two points', () => {
        const svg = renderTrendChartSvg(sampleChart());
        const paths = svg.match(/<path[^>]*d="([^"]+)"/);
        expect(paths).not.toBeNull();
        const d = paths[1];
        expect(d.startsWith('M')).toBe(true);
        // One M command and one L command for a 2-point series.
        expect((d.match(/[ML]/g) || []).length).toBe(2);
    });
    test('emits one circle per point with abnormal modifier when set', () => {
        const svg = renderTrendChartSvg(sampleChart());
        const dotMatches = svg.match(/<circle[^>]*data-role="trend-dot"/g);
        expect(dotMatches).toHaveLength(2);
        expect(svg).toContain('copilot-trend__dot--abnormal');
    });
    test('emits a numeric label per point so values are readable in-chart', () => {
        const svg = renderTrendChartSvg(sampleChart());
        const labelMatches = svg.match(/<text[^>]*data-role="trend-point-label"/g);
        expect(labelMatches).toHaveLength(2);
        // The two abnormal lab values are 7.4 and 8.4 — both should
        // appear as label text, with the abnormal modifier class.
        expect(svg).toContain('>7.4</text>');
        expect(svg).toContain('>8.4</text>');
        expect(svg).toContain('copilot-trend__point-label--abnormal');
    });
    test('rounds large-magnitude point labels to whole numbers', () => {
        const svg = renderTrendChartSvg(sampleChart({
            referenceRange: '0-200',
            points: [
                { observedAt: '2024-01-01T00:00:00Z', value: 142.7, abnormal: false },
                { observedAt: '2025-01-01T00:00:00Z', value: 199.4, abnormal: false },
            ],
        }));
        expect(svg).toContain('>143</text>');
        expect(svg).toContain('>199</text>');
    });
    test('emits a reference-range band for parseable ranges', () => {
        const svg = renderTrendChartSvg(sampleChart());
        expect(svg).toContain('data-role="trend-band"');
    });
    test('omits the band when the reference range is unparsable', () => {
        const svg = renderTrendChartSvg(sampleChart({ referenceRange: 'positive' }));
        expect(svg).not.toContain('data-role="trend-band"');
    });
    test('uses the year-tagged x-axis labels when the series spans years', () => {
        const svg = renderTrendChartSvg(sampleChart({
            points: [
                { observedAt: '2023-09-01T00:00:00Z', value: 7.4, abnormal: true },
                { observedAt: '2025-04-01T00:00:00Z', value: 8.4, abnormal: true },
            ],
        }));
        // The single-quote in the year label is escaped as &#39; for safety.
        expect(svg).toContain('Sep &#39;23');
        expect(svg).toContain('Apr &#39;25');
    });
    test('escapes special chars in unit / observedAt in tooltip text', () => {
        const svg = renderTrendChartSvg(sampleChart({
            unit: '<weird>',
            points: [
                { observedAt: '2024-01-01T00:00:00Z', value: 1, abnormal: false },
                { observedAt: '2025-01-01T00:00:00Z', value: 2, abnormal: false },
            ],
        }));
        // The literal "<weird>" must NOT appear unescaped — escapeSvg
        // turns "<" into "&lt;".
        expect(svg).not.toContain('<weird>');
        expect(svg).toContain('&lt;weird&gt;');
    });
});

describe('renderTrendChart', () => {
    test('returns the empty string for null / non-object input', () => {
        expect(renderTrendChart(null)).toBe('');
        expect(renderTrendChart(undefined)).toBe('');
        expect(renderTrendChart('not-an-object')).toBe('');
    });
    test('returns the empty string when the SVG body is empty', () => {
        expect(renderTrendChart(sampleChart({ points: [] }))).toBe('');
    });
    test('wraps the SVG in a figure with caption and reason metadata', () => {
        const html = renderTrendChart(sampleChart());
        expect(html).toContain('data-role="trend-chart"');
        expect(html).toContain('data-reason="fresh_lab_with_history"');
        expect(html).toContain('<figcaption');
        expect(html).toContain('Hemoglobin A1c');
        expect(html).toContain('<svg');
    });
});
