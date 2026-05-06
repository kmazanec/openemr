import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractFromHtml } from '../../scripts/extract-cdc-corpus.js';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/cdc');

async function loadFixture(name: string): Promise<string> {
    return readFile(resolve(FIXTURE_DIR, name), 'utf8');
}

describe('extract-cdc-corpus', () => {
    describe('acip-notes', () => {
        it('emits one chunk per per-vaccine note anchor with verbatim body', async () => {
            const html = await loadFixture('acip-notes-sample.html');
            const result = extractFromHtml('acip-notes', 'acip-adult-notes', html);

            expect(result.title).toBe('Adult Immunization Schedule Notes');
            expect(result.year).toBe(2025);
            expect(result.url).toBe(
                'https://example.test/vaccines/hcp/imz-schedules/adult-notes.html',
            );

            const sections = result.chunks.map((c) => c.section);
            // note-empty has no body text → empty-section warning, no chunk.
            expect(sections).toEqual(['note-flu', 'note-zoster']);
            expect(result.warnings).toContain('empty-section:note-empty');

            const flu = result.chunks.find((c) => c.section === 'note-flu');
            expect(flu?.section_label).toBe('Influenza vaccination');
            expect(flu?.body).toContain(
                'Age 19 years or older: 1 dose any influenza vaccine',
            );

            const zoster = result.chunks.find((c) => c.section === 'note-zoster');
            expect(zoster?.body).toContain('2-dose series Shingrix');
        });

        it('emits no-note-anchors when the page has no note-* anchors', () => {
            const html = `<!DOCTYPE html><html><body><main><h1>Empty Notes</h1>
                <div class="cdc-page-content">
                  <p>Nothing useful here.</p>
                </div>
                </main></body></html>`;
            const result = extractFromHtml('acip-notes', 'empty', html);
            expect(result.chunks).toEqual([]);
            expect(result.warnings).toContain('no-note-anchors');
        });
    });

    describe('acip-schedule', () => {
        it('emits Purpose + How-to-use chunks and drops chrome and tabular sections', async () => {
            const html = await loadFixture('acip-schedule-sample.html');
            const result = extractFromHtml('acip-schedule', 'acip-adult-age', html);

            expect(result.title).toBe('Adult Immunization Schedule by Age');
            expect(result.year).toBe(2025);

            // Only Purpose + How to use are kept; "Ages 19 Years or Older",
            // "Additional Information", and "On This Page" are dropped.
            expect(result.chunks.map((c) => c.section)).toEqual([
                'purpose',
                'how-to-use',
            ]);

            const purpose = result.chunks.find((c) => c.section === 'purpose');
            expect(purpose?.body).toContain('Guide health care providers');

            const howToUse = result.chunks.find((c) => c.section === 'how-to-use');
            expect(howToUse?.body).toContain('Determine recommended vaccine by age');
            expect(result.warnings).toEqual([]);
        });
    });

    describe('opioid-landing', () => {
        it('emits one chunk per top-level h2 section, dropping On This Page', async () => {
            const html = await loadFixture('opioid-landing-sample.html');
            const result = extractFromHtml('opioid-landing', 'opioid-prescribing-2022', html);

            expect(result.title).toBe('2022 CDC Clinical Practice Guideline at a Glance');
            // h2 → kebab-case slug; "On This Page" dropped.
            expect(result.chunks.map((c) => c.section)).toEqual([
                'what-to-know',
                'the-2022-clinical-practice-guideline',
                '2022-clinical-practice-guideline-recommendations',
            ]);

            const recs = result.chunks.find(
                (c) => c.section === '2022-clinical-practice-guideline-recommendations',
            );
            expect(recs?.body).toContain(
                'The 12 recommendations are grouped into four areas of consideration.',
            );
        });
    });

    describe('sti-clinical-guidance', () => {
        it('emits one chunk per top-level h2 with clinical-guidance content', async () => {
            const html = await loadFixture('sti-clinical-guidance-sample.html');
            const result = extractFromHtml(
                'sti-clinical-guidance',
                'sti-expedited-partner-therapy',
                html,
            );

            expect(result.title).toBe('Expedited Partner Therapy');
            expect(result.chunks.map((c) => c.section)).toEqual([
                'at-a-glance',
                'legal-status',
            ]);

            const glance = result.chunks.find((c) => c.section === 'at-a-glance');
            expect(glance?.body).toContain('EPT is the clinical practice of treating sex partners');
        });
    });

    describe('failure modes', () => {
        it('emits missing-main when the page has no <main>', () => {
            const result = extractFromHtml(
                'acip-notes',
                'broken',
                '<html><body><p>nothing</p></body></html>',
            );
            expect(result.chunks).toEqual([]);
            expect(result.warnings).toContain('missing-main');
        });

        it('emits no-content-sections for a generic-h2 page with only chrome', () => {
            const html = `<!DOCTYPE html><html><body><main>
                <h1>Title</h1>
                <h2>On This Page</h2><p>nav</p>
                <h2>Additional Information</h2><p>nav</p>
                </main></body></html>`;
            const result = extractFromHtml('opioid-landing', 'chrome-only', html);
            expect(result.chunks).toEqual([]);
            expect(result.warnings).toContain('no-content-sections');
        });
    });
});
