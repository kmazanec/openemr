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

    describe('oversize-section splitting', () => {
        it('splits an h2 over the chunk-size threshold into one chunk per h3 sub-section', async () => {
            const html = await loadFixture('pmc-oversize-section.html');
            // Use a small threshold so the fixture's modest h2 trips the
            // splitter; production runs use the larger default.
            const result = extractFromHtml(
                'pmc-section',
                '09-pharmacologic-approaches',
                html,
                { maxChunkChars: 4000 },
            );

            // Abstract is small enough to stay one chunk. The big h2
            // splits at every h3 boundary; no chunk for the parent h2
            // itself (the h3s are exhaustive and the publisher's natural
            // boundaries).
            expect(result.warnings).toEqual([]);
            const sections = result.chunks.map((c) => c.section);
            expect(sections).toEqual([
                'abstract',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes--initial-therapy',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes--combination-therapy',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes--glp-1-receptor-agonists-and-dual-gip-glp-1-receptor-agonists',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes--sglt2-inhibitors',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes--insulin-therapy',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes--therapeutic-inertia',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes--cost-considerations',
            ]);

            const initial = result.chunks.find(
                (c) =>
                    c.section ===
                    'pharmacologic-therapy-for-adults-with-type-2-diabetes--initial-therapy',
            );
            // Sub-chunk's section_label carries both the h2 and h3 labels,
            // separated by an em-dash — same convention I.1's CDC
            // accordion split used ("Influenza vaccination — Routine
            // vaccination").
            expect(initial?.section_label).toBe(
                'Pharmacologic Therapy for Adults With Type 2 Diabetes — Initial Therapy',
            );
            // Body opens with the labels so retrieval has clean topical
            // framing, then carries the verbatim recommendation text.
            expect(initial?.body).toContain('Initial Therapy');
            expect(initial?.body).toContain(
                '9.4a Most people with type 2 diabetes benefit from initial',
            );
            // Sub-chunk MUST NOT bleed into other h3 bodies.
            expect(initial?.body).not.toContain('SGLT2 inhibitors');
            expect(initial?.body).not.toContain('Combination therapy');
        });

        it('keeps an under-threshold h2 as a single chunk even when h3s are present', async () => {
            const html = await loadFixture('pmc-oversize-section.html');
            // Default threshold (24000) — fixture's big h2 totals well
            // under 24000 chars, so no split happens.
            const result = extractFromHtml(
                'pmc-section',
                '09-pharmacologic-approaches',
                html,
            );
            const sections = result.chunks.map((c) => c.section);
            expect(sections).toEqual([
                'abstract',
                'pharmacologic-therapy-for-adults-with-type-2-diabetes',
            ]);
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
            // Section is over threshold and has no h3 to split on; we
            // refuse to silently truncate or emit a too-large chunk —
            // log a structured warning and skip.
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
