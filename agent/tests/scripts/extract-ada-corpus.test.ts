import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractFromHtml } from '../../scripts/extract-ada-corpus.js';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/ada');

async function loadFixture(name: string): Promise<string> {
    return readFile(resolve(FIXTURE_DIR, name), 'utf8');
}

describe('extract-ada-corpus', () => {
    describe('pmc-section', () => {
        it('emits one chunk per top-level h2 in the article body, dropping chrome', async () => {
            const html = await loadFixture('pmc-section-sample.html');
            const result = extractFromHtml('pmc-section', '11-chronic-kidney-disease', html);

            expect(result.title).toBe(
                '11. Chronic Kidney Disease and Risk Management: Standards of Care in Diabetes—2026',
            );
            expect(result.year).toBe(2025);
            expect(result.url).toBe('https://pmc.ncbi.nlm.nih.gov/articles/PMC12690176/');

            const sections = result.chunks.map((c) => c.section);
            // Abstract → 'abstract' (preserved as a chunk because it carries the
            // committee-level framing). Three real topics. Chrome (Footnotes,
            // Contributor Information, References) dropped. Empty Section
            // dropped via empty-section warning.
            expect(sections).toEqual([
                'abstract',
                'epidemiology-of-diabetes-and-chronic-kidney-disease',
                'assessment-of-albuminuria-and-estimated-glomerular-filtration-rate',
                'treatment-for-severe-chronic-kidney-disease-and-kidney-failure',
            ]);
            expect(result.warnings).toContain('empty-section:Empty Section');

            const epi = result.chunks.find(
                (c) => c.section === 'epidemiology-of-diabetes-and-chronic-kidney-disease',
            );
            expect(epi?.section_label).toBe('Epidemiology of Diabetes and Chronic Kidney Disease');
            expect(epi?.body).toContain('20–40% of people with diabetes');
            expect(epi?.body).toContain('half of all cases of kidney failure');

            // Recommendation body must be verbatim, including the evidence
            // grade and the numbered recommendation prefix.
            const assessment = result.chunks.find(
                (c) =>
                    c.section ===
                    'assessment-of-albuminuria-and-estimated-glomerular-filtration-rate',
            );
            expect(assessment?.body).toContain(
                '11.1a At least once a year, assess urinary albumin',
            );
            expect(assessment?.body).toContain('B');

            // Treatment chunk must NOT bleed into Footnotes / References / Contributor.
            const treatment = result.chunks.find(
                (c) =>
                    c.section === 'treatment-for-severe-chronic-kidney-disease-and-kidney-failure',
            );
            expect(treatment?.body).not.toContain('Bibliography entry');
            expect(treatment?.body).not.toContain('Suggested citation');
            expect(treatment?.body).not.toContain('Professional Practice Committee membership');
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
                  <h2 class="pmc_sec_title">References</h2><p>Bibliography.</p>
                  <h2 class="pmc_sec_title">Footnotes</h2><p>Notes.</p>
                  <h2 class="pmc_sec_title">Contributor Information</h2><p>Members.</p>
                </section>
                </main></body></html>`;
            const result = extractFromHtml('pmc-section', 'chrome-only', html);
            expect(result.chunks).toEqual([]);
            expect(result.warnings).toContain('no-content-sections');
        });
    });
});
