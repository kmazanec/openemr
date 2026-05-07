/**
 * Jest tests for the Clinical Co-Pilot guideline source drawer
 * helpers. Covers the pure helpers exported by panel.js — chip
 * data-attribute decoding, source-ref → card mapping, URL safety,
 * and the rendered card markup.
 *
 * The drawer's open/close state machine and click-handler dispatch
 * run against real DOM in the browser; here we only test the
 * pure-function surface exported via `module.exports`.
 *
 * `panel.js`'s `escapeText` escapes HTML by writing to a DOM Element's
 * `textContent` and reading back `innerHTML`. To avoid pulling jsdom
 * in we stub a minimal `document.createElement('span')` shim with
 * just enough behaviour for the escape pass — the same primitive a
 * browser uses, replicated faithfully enough that the rendered
 * output mirrors what users see.
 */

const helpers = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

// `panel.js` boot-checks `typeof document !== 'undefined'` and bails
// when the DOM is absent (so the test require doesn't throw). Once the
// IIFE has captured its own `null` root, we can install a minimal
// document stub for the helpers under test — `escapeText` only uses
// `document.createElement` + `textContent`/`innerHTML`, the same
// browser primitive replicated faithfully here.
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
global.document = {
    createElement: () => {
        let inner = '';
        return {
            set textContent(v) {
                inner = (v == null ? '' : String(v)).replace(/[&<>"]/g, (c) => escapeMap[c]);
            },
            get innerHTML() {
                return inner;
            },
        };
    },
};

const {
    guidelineCardFromSource,
    sectionGuidelineCardArgs,
    safeGuidelineUrl,
    renderGuidelineCard,
} = helpers;

const fullGuidelineRef = (overrides = {}) => ({
    source_type: 'guideline',
    source_id: 'uspstf::aspirin-cvd-2022',
    locator: { section: 'Recommendation Statement' },
    quote: 'The USPSTF recommends against initiating low-dose aspirin use for the primary prevention of CVD in adults 60 years or older.',
    meta: {
        publication: 'USPSTF',
        title: 'Aspirin Use to Prevent Cardiovascular Disease',
        year: 2022,
        section: 'Recommendation Statement',
        url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/aspirin-to-prevent-cardiovascular-disease-preventive-medication',
        rerank_score: 0.81,
    },
    ...overrides,
});

describe('guidelineCardFromSource — extract drawer card from a SourceReference', () => {
    test('returns the full card for a verifier-enriched guideline ref', () => {
        const card = guidelineCardFromSource(fullGuidelineRef());
        expect(card).toEqual({
            publication: 'USPSTF',
            title: 'Aspirin Use to Prevent Cardiovascular Disease',
            year: 2022,
            section: 'Recommendation Statement',
            url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/aspirin-to-prevent-cardiovascular-disease-preventive-medication',
            quote: expect.stringContaining('low-dose aspirin'),
        });
    });

    test('falls back to locator.section when meta.section is absent', () => {
        const ref = fullGuidelineRef();
        delete ref.meta.section;
        const card = guidelineCardFromSource(ref);
        expect(card.section).toBe('Recommendation Statement');
    });

    test('returns nulls for missing publication / title / url slots', () => {
        const card = guidelineCardFromSource({
            source_type: 'guideline',
            source_id: 'unknown-chunk',
            locator: { section: 'foo' },
            quote: 'q',
        });
        expect(card).toEqual({
            publication: null,
            title: null,
            year: null,
            section: 'foo',
            url: null,
            quote: 'q',
        });
    });

    test('returns null for non-guideline refs', () => {
        expect(
            guidelineCardFromSource({
                source_type: 'chart',
                source_id: 'x',
                locator: { field: 'medication.name' },
                quote: 'q',
            }),
        ).toBeNull();
        expect(guidelineCardFromSource(null)).toBeNull();
        expect(guidelineCardFromSource(undefined)).toBeNull();
    });
});

describe('safeGuidelineUrl — URL-scheme allowlist before becoming an href', () => {
    test('passes through https URLs', () => {
        expect(safeGuidelineUrl('https://www.uspreventiveservicestaskforce.org/foo')).toBe(
            'https://www.uspreventiveservicestaskforce.org/foo',
        );
    });
    test('passes through http URLs', () => {
        expect(safeGuidelineUrl('http://example.org/x')).toBe('http://example.org/x');
    });
    test('rejects javascript: scheme', () => {
        expect(safeGuidelineUrl('javascript:alert(1)')).toBeNull();
    });
    test('rejects data: scheme', () => {
        expect(safeGuidelineUrl('data:text/html,<h1>bad</h1>')).toBeNull();
    });
    test('rejects file: scheme', () => {
        expect(safeGuidelineUrl('file:///etc/passwd')).toBeNull();
    });
    test('rejects malformed URLs', () => {
        expect(safeGuidelineUrl('not a url')).toBeNull();
    });
    test('rejects null / empty / non-string', () => {
        expect(safeGuidelineUrl(null)).toBeNull();
        expect(safeGuidelineUrl('')).toBeNull();
        expect(safeGuidelineUrl(42)).toBeNull();
    });
});

describe('sectionGuidelineCardArgs — decode chip data-* attributes', () => {
    const chip = (dataset) => ({ dataset });

    test('round-trips a fully-populated chip', () => {
        const args = sectionGuidelineCardArgs(
            chip({
                publication: 'USPSTF',
                title: 'Aspirin Use to Prevent CVD',
                year: '2022',
                section: 'Recommendation Statement',
                url: 'https://example.com/a',
                quote: 'a quote',
            }),
        );
        expect(args).toEqual({
            publication: 'USPSTF',
            title: 'Aspirin Use to Prevent CVD',
            year: 2022,
            section: 'Recommendation Statement',
            url: 'https://example.com/a',
            quote: 'a quote',
        });
    });

    test('returns nulls for missing attributes', () => {
        const args = sectionGuidelineCardArgs(chip({}));
        expect(args).toEqual({
            publication: null,
            title: null,
            year: null,
            section: null,
            url: null,
            quote: '',
        });
    });

    test('rejects non-integer year', () => {
        const args = sectionGuidelineCardArgs(chip({ year: 'whenever' }));
        expect(args.year).toBeNull();
    });
});

describe('renderGuidelineCard — drawer body markup', () => {
    test('renders publication badge, title, section, quote, and a publisher link', () => {
        const card = guidelineCardFromSource(fullGuidelineRef());
        const html = renderGuidelineCard(card, 'Adults 60+ should not start daily aspirin.');
        expect(html).toContain('USPSTF');
        expect(html).toContain('2022');
        expect(html).toContain('Aspirin Use to Prevent Cardiovascular Disease');
        expect(html).toContain('Recommendation Statement');
        expect(html).toContain('low-dose aspirin');
        expect(html).toContain('href="https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/aspirin-to-prevent-cardiovascular-disease-preventive-medication"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain('Adults 60+ should not start daily aspirin.');
        expect(html).toContain('Cited in this answer');
    });

    test('falls back to a "no link" stub when url is missing', () => {
        const card = guidelineCardFromSource({
            source_type: 'guideline',
            source_id: 'noisy-chunk',
            locator: { section: 'foo' },
            quote: 'q',
            meta: { publication: 'USPSTF', title: 'T' },
        });
        const html = renderGuidelineCard(card, '');
        expect(html).toContain('No public link available');
        expect(html).not.toContain('href=');
    });

    test('escapes javascript: URLs out of href attributes', () => {
        const card = guidelineCardFromSource({
            source_type: 'guideline',
            source_id: 'noisy',
            locator: { section: 'foo' },
            quote: 'q',
            meta: {
                publication: 'X',
                title: 'T',
                section: 'foo',
                url: 'javascript:alert(1)',
            },
        });
        const html = renderGuidelineCard(card, '');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('No public link available');
    });

    test('escapes HTML in publication / title / section / quote / claim', () => {
        const card = {
            publication: '<X>',
            title: '<Y>',
            year: 2024,
            section: '<Z>',
            url: null,
            quote: '<Q>',
        };
        const html = renderGuidelineCard(card, '<C>');
        expect(html).not.toContain('<X>');
        expect(html).not.toContain('<Y>');
        expect(html).not.toContain('<Z>');
        expect(html).not.toContain('<Q>');
        expect(html).not.toContain('<C>');
        expect(html).toContain('&lt;X&gt;');
        expect(html).toContain('&lt;Y&gt;');
        expect(html).toContain('&lt;Z&gt;');
        expect(html).toContain('&lt;Q&gt;');
        expect(html).toContain('&lt;C&gt;');
    });
});
