import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractFromHtml } from '../../scripts/extract-ags-beers-corpus.js';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/ags-beers');

async function loadFixture(name: string): Promise<string> {
    return readFile(resolve(FIXTURE_DIR, name), 'utf8');
}

describe('extract-ags-beers-corpus', () => {
    describe('pmc-section', () => {
        it('emits one chunk per top-level h2 in the article body, dropping chrome', async () => {
            const html = await loadFixture('pmc-section-sample.html');
            const result = extractFromHtml('pmc-section', 'beers-criteria-2023', html);

            expect(result.title).toBe(
                'American Geriatrics Society 2023 updated AGS Beers Criteria for potentially inappropriate medication use in older adults',
            );
            expect(result.year).toBe(2023);
            expect(result.url).toBe('https://pmc.ncbi.nlm.nih.gov/articles/PMC12478568/');

            const sections = result.chunks.map((c) => c.section);
            // Abstract → 'abstract'. Four real clinical h2s. AGS-specific
            // chrome (ACKNOWLEDGMENTS, APPENDIX A, Footnotes, REFERENCES)
            // dropped, plus the empty section dropped via empty-section
            // warning.
            expect(sections).toEqual(['abstract', 'introduction', 'methods', 'results', 'discussion']);
            expect(result.warnings).toContain('empty-section:Empty Section');

            // INTRODUCTION fits under the default 24,000-char threshold,
            // so the table-figures stay nested inside one chunk; the
            // splitter only fires when threshold trips.
            const intro = result.chunks.find((c) => c.section === 'introduction');
            expect(intro?.section_label).toBe('INTRODUCTION');
            expect(intro?.body).toContain('developed by the late Mark Beers, MD');
            // Table-figure caption text appears verbatim in the chunk
            // body (the h3 + caption are still descendants of the h2's
            // section).
            expect(intro?.body).toContain(
                '2023 American Geriatrics Society Beers Criteria for potentially inappropriate medication use in older adults',
            );
            // Verbatim Beers recommendation text including the strength
            // of recommendation.
            expect(intro?.body).toContain('First-generation antihistamines');
            expect(intro?.body).toContain('Strong');

            // METHODS stays one chunk (under threshold), even though it
            // has h3.pmc_sec_title sub-headings.
            const methods = result.chunks.find((c) => c.section === 'methods');
            expect(methods?.body).toContain('Panel composition');
            expect(methods?.body).toContain('Literature review');

            // Discussion chunk MUST NOT bleed into Footnotes /
            // References / Acknowledgments / Appendix.
            const discussion = result.chunks.find((c) => c.section === 'discussion');
            expect(discussion?.body).not.toContain('Bibliography entry');
            expect(discussion?.body).not.toContain('Suggested citation');
            expect(discussion?.body).not.toContain('Panel member roster');
            expect(discussion?.body).not.toContain('AGS staff');
        });
    });

    describe('h3.obj_head splitter (Beers table-figures)', () => {
        it('splits an over-threshold INTRODUCTION at h3.obj_head table boundaries', async () => {
            const html = await loadFixture('pmc-section-sample.html');
            // Use a small threshold so the fixture's modest INTRODUCTION
            // trips the splitter; production runs against the real
            // 42K-char INTRODUCTION use the default 24,000.
            const result = extractFromHtml(
                'pmc-section',
                'beers-criteria-2023',
                html,
                { maxChunkChars: 800 },
            );

            const sections = result.chunks.map((c) => c.section);
            // The splitter fires on INTRODUCTION (table-figure h3s
            // become split points) and METHODS (pmc_sec_title h3s
            // become split points). Other h2s are under threshold and
            // pass through. The threshold of 800 is small enough that
            // the abstract is also inspected, but it has no h3s so it
            // stays as a single chunk.
            expect(sections).toContain(
                'introduction--2023-american-geriatrics-society-beers-criteria-for-potentially-inappropriate-medication-use-in-older-adults',
            );
            expect(sections).toContain(
                'introduction--drug-disease-or-drug-syndrome-interactions-that-may-exacerbate-the-disease-or-syndrome',
            );

            // Sub-chunk's section_label substitutes the table caption
            // text for the bare "TABLE N." h3 label, joined to the
            // parent h2 with an em-dash (mirrors ADA's convention).
            const t2 = result.chunks.find(
                (c) =>
                    c.section ===
                    'introduction--2023-american-geriatrics-society-beers-criteria-for-potentially-inappropriate-medication-use-in-older-adults',
            );
            expect(t2?.section_label).toBe(
                'INTRODUCTION — 2023 American Geriatrics Society Beers Criteria for potentially inappropriate medication use in older adults.',
            );
            // Body opens with the labels, then carries the verbatim
            // recommendation text including the strength of
            // recommendation.
            expect(t2?.body).toContain(
                '2023 American Geriatrics Society Beers Criteria for potentially inappropriate medication use in older adults',
            );
            expect(t2?.body).toContain('First-generation antihistamines');
            expect(t2?.body).toContain('Benzodiazepines');
            expect(t2?.body).toContain('Strong');
            // Table 2 sub-chunk MUST NOT bleed into Table 3.
            expect(t2?.body).not.toContain('Heart failure');
            expect(t2?.body).not.toContain('NSAIDs');
        });

        it('keeps an under-threshold INTRODUCTION as a single chunk even when h3.obj_head table-figures are present', async () => {
            const html = await loadFixture('pmc-section-sample.html');
            // Default threshold (24,000) — fixture's INTRODUCTION totals
            // well under, so no split happens.
            const result = extractFromHtml(
                'pmc-section',
                'beers-criteria-2023',
                html,
            );
            const sections = result.chunks.map((c) => c.section);
            expect(sections).toContain('introduction');
            expect(sections).not.toContain(
                'introduction--2023-american-geriatrics-society-beers-criteria-for-potentially-inappropriate-medication-use-in-older-adults',
            );
        });

        it('emits oversize-no-h3-boundaries when an over-threshold h2 has no h3 sub-sections to split at', () => {
            const html = `<!doctype html><html><body><main>
                <section class="body main-article-body">
                  <h1>Title</h1>
                  <h2 class="pmc_sec_title">Big Topic</h2>
                  <p>${'AAA '.repeat(2000)}</p>
                </section>
                </main></body></html>`;
            const result = extractFromHtml('pmc-section', 'no-h3', html, {
                maxChunkChars: 4000,
            });
            // Section is over threshold and has neither pmc_sec_title
            // nor obj_head h3s to split on; we refuse to silently
            // truncate and log a structured warning.
            expect(result.chunks.map((c) => c.section)).toEqual([]);
            expect(result.warnings).toContain('oversize-no-h3-boundaries:Big Topic');
        });
    });

    describe('failure modes', () => {
        it('emits missing-article-body when the page has no main-article-body section', () => {
            const html = `<!DOCTYPE html><html><body><main>
                <h1>Some Title</h1>
                <p>No article body container.</p>
                </main></body></html>`;
            const result = extractFromHtml('pmc-section', 'broken', html);
            expect(result.chunks).toEqual([]);
            expect(result.warnings).toContain('missing-article-body');
        });

        it('emits no-content-sections when the body has only chrome h2s', () => {
            const html = `<!DOCTYPE html><html><body><main>
                <section class="body main-article-body">
                  <h1>Title</h1>
                  <h2 class="pmc_sec_title">REFERENCES</h2><p>Bibliography.</p>
                  <h2 class="pmc_sec_title">Footnotes</h2><p>Notes.</p>
                  <h2 class="pmc_sec_title">ACKNOWLEDGMENTS</h2><p>Thanks.</p>
                  <h2 class="pmc_sec_title">APPENDIX A: PANEL MEMBERS AND AFFILIATIONS</h2><p>Roster.</p>
                </section>
                </main></body></html>`;
            const result = extractFromHtml('pmc-section', 'chrome-only', html);
            expect(result.chunks).toEqual([]);
            expect(result.warnings).toContain('no-content-sections');
        });
    });
});
