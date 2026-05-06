/**
 * Pure-function tests for the Clinical Co-Pilot panel's W2 source-type
 * rendering helpers. The panel script is loaded as a plain `<script>` in
 * the browser, so the helpers under test live in panel.js wrapped in a
 * UMD-style `module.exports` guard — node sees them, the browser ignores
 * the export.
 *
 * Coverage:
 *
 *   - `sourceLinkUrl(sourceRef)` — W2 chart refs translate back to the
 *     existing OpenEMR record-page URLs (W1 carry-forward).
 *   - `chipTooltipText(sourceRef)` — variant-aware tooltip text per
 *     `source_type`: chart shows record kind + id, extracted_document
 *     shows page + document uuid prefix, guideline shows publication
 *     (derived from `source_id` prefix) + section.
 *   - `claimGroupsToSections(claimGroups)` — projects the wire shape
 *     (`{chart?, extractedDocument?, guideline?}`) into the renderer's
 *     ordered section list, omitting empty buckets per the C.6 spec.
 */

const helpers = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

const {
    sourceLinkUrl,
    chipTooltipText,
    claimGroupsToSections,
} = helpers;

const chartRef = (overrides = {}) => ({
    source_type: 'chart',
    source_id: 'rx-1',
    locator: { field: 'medication.name' },
    quote: 'Metformin 500mg',
    meta: { record_recorded_at: '2024-03-15T00:00:00Z' },
    ...overrides,
});

const docRef = (overrides = {}) => ({
    source_type: 'extracted_document',
    source_id: 'artifact-7',
    locator: { page: 2, bbox: [0.1, 0.2, 0.3, 0.05] },
    quote: 'A1c 8.4%',
    meta: { document_uuid: 'doc-uuid-abcdef0123456789' },
    ...overrides,
});

const guidelineRef = (overrides = {}) => ({
    source_type: 'guideline',
    source_id: 'uspstf::colorectal-cancer-screening--recommendation-summary',
    locator: { section: 'Recommendation Summary' },
    quote: 'Adults 45–75 should be screened for colorectal cancer.',
    meta: { rerank_score: 0.91 },
    ...overrides,
});

describe('sourceLinkUrl — W2 chart refs map back to OpenEMR record pages', () => {
    test('chart MedicationRequest field links to stats_full', () => {
        const url = sourceLinkUrl(chartRef({ locator: { field: 'medication.name' } }));
        expect(url).toMatch(/patient_file\/summary\/stats_full\.php/);
    });

    test('chart Patient field links to demographics with set_pid', () => {
        const url = sourceLinkUrl(chartRef({
            source_id: '42',
            locator: { field: 'patient.name' },
        }));
        expect(url).toMatch(/patient_file\/summary\/demographics\.php\?set_pid=42/);
    });

    test('chart Encounter field links to encounter_top with set_encounter', () => {
        const url = sourceLinkUrl(chartRef({
            source_id: 'enc-9',
            locator: { field: 'encounter.date' },
        }));
        expect(url).toMatch(/patient_file\/encounter\/encounter_top\.php\?set_encounter=enc-9/);
    });

    test('chart with unknown locator.field has no deep link', () => {
        const url = sourceLinkUrl(chartRef({ locator: { field: 'something.unknown' } }));
        expect(url).toBeNull();
    });

    test('extracted_document is tooltip-only — no link', () => {
        // Layer-1 PDF.js bbox overlay defers to F.5; D.2 chips never link.
        expect(sourceLinkUrl(docRef())).toBeNull();
    });

    test('guideline is tooltip-only — no link', () => {
        // Layer-2 popover defers to F; D.2 chips never link.
        expect(sourceLinkUrl(guidelineRef())).toBeNull();
    });

    test('null-ish input is safe', () => {
        expect(sourceLinkUrl(null)).toBeNull();
        expect(sourceLinkUrl(undefined)).toBeNull();
        expect(sourceLinkUrl({})).toBeNull();
    });
});

describe('chipTooltipText — variant per source_type', () => {
    test('chart shows record kind + id (W1 carry-forward)', () => {
        const text = chipTooltipText(chartRef({
            source_id: 'rx-1',
            locator: { field: 'medication.name' },
        }));
        expect(text).toContain('Medication');
        expect(text).toContain('rx-1');
    });

    test('extracted_document shows page + document uuid prefix', () => {
        const text = chipTooltipText(docRef());
        expect(text).toContain('page 2');
        // First few chars of document_uuid for a stable, scan-friendly anchor.
        expect(text).toContain('doc-uuid');
    });

    test('extracted_document with missing document_uuid shows page only', () => {
        const text = chipTooltipText(docRef({ meta: undefined }));
        expect(text).toContain('page 2');
        expect(text).not.toContain('document');
    });

    test('guideline shows publication (from source_id prefix) + section', () => {
        const text = chipTooltipText(guidelineRef());
        expect(text).toContain('USPSTF');
        expect(text).toContain('Recommendation Summary');
    });

    test('guideline with unrecognized source_id prefix falls back to section only', () => {
        const text = chipTooltipText(guidelineRef({ source_id: 'unknown::chunk-1' }));
        expect(text).toContain('Recommendation Summary');
    });

    test('null-ish input returns a safe fallback string', () => {
        expect(typeof chipTooltipText(null)).toBe('string');
        expect(typeof chipTooltipText({})).toBe('string');
    });
});

describe('claimGroupsToSections — documents + evidence; chart bucket dropped', () => {
    const claim = (id) => ({
        id,
        text: `claim ${id}`,
        category: 'diagnosis',
        sourceReferences: [chartRef()],
        safetyCritical: false,
    });

    test('all three populated → only documents and evidence sections render', () => {
        // The chart bucket still ships on the wire (the verifier and
        // any future consumer keep reading it), but the renderer
        // deliberately drops it: the inline-prose chart citations
        // already cover that ground, and the dedicated bottom section
        // duplicates it noisily.
        const sections = claimGroupsToSections({
            chart: { subsections: [{ category: 'diagnosis', claims: [claim('a')] }] },
            extractedDocument: { cards: [{ documentUuid: 'doc-1', claims: [claim('b')] }] },
            guideline: { claims: [claim('c')] },
        });
        expect(sections.map((s) => s.kind)).toEqual(['extractedDocument', 'guideline']);
        expect(sections.map((s) => s.heading)).toEqual(['From documents', 'Evidence']);
    });

    test('chart-only payload → no sections rendered', () => {
        const sections = claimGroupsToSections({
            chart: { subsections: [{ category: 'diagnosis', claims: [claim('a')] }] },
        });
        expect(sections).toEqual([]);
    });

    test('documents + guideline → both render in order', () => {
        const sections = claimGroupsToSections({
            extractedDocument: { cards: [{ documentUuid: 'doc-1', claims: [claim('b')] }] },
            guideline: { claims: [claim('c')] },
        });
        expect(sections.map((s) => s.kind)).toEqual(['extractedDocument', 'guideline']);
    });

    test('empty object → no sections', () => {
        expect(claimGroupsToSections({})).toEqual([]);
    });

    test('null/undefined → no sections', () => {
        expect(claimGroupsToSections(null)).toEqual([]);
        expect(claimGroupsToSections(undefined)).toEqual([]);
    });

    test('extractedDocument cards preserve documentUuid', () => {
        const sections = claimGroupsToSections({
            extractedDocument: {
                cards: [
                    { documentUuid: 'doc-1', claims: [claim('a')] },
                    { documentUuid: null, claims: [claim('b')] },
                ],
            },
        });
        expect(sections[0].cards.map((c) => c.documentUuid)).toEqual(['doc-1', null]);
    });
});
