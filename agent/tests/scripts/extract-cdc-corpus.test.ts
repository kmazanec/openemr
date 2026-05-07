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

        it('splits shared-textblock pages into per-vaccine, per-accordion chunks', async () => {
            // Repros the child-adolescent-notes shape where every vaccine's
            // heading and accordions share one outer cdc-textblock —
            // chunk boundaries have to come from document-order anchor/
            // accordion-item mapping, not closest()-textblock.
            const html = await loadFixture('acip-notes-with-accordions.html');
            const result = extractFromHtml(
                'acip-notes',
                'acip-child-adolescent-notes',
                html,
            );

            expect(result.warnings).toEqual([]);
            // 2 flu + 3 mmr accordions = 5 chunks; no chunks bleed
            // between the two vaccines.
            expect(result.chunks.map((c) => c.section)).toEqual([
                'note-flu--routine-vaccination',
                'note-flu--special-situations',
                'note-mmr--routine-vaccination',
                'note-mmr--catch-up-vaccination',
                'note-mmr--contraindications-and-precautions',
            ]);

            const fluRoutine = result.chunks.find(
                (c) => c.section === 'note-flu--routine-vaccination',
            );
            expect(fluRoutine?.section_label).toBe(
                'Influenza vaccination — Routine vaccination',
            );
            expect(fluRoutine?.body).toContain('Age 6 months or older');
            // The MMR catch-up accordion's body must NOT include flu content.
            const mmrCatchup = result.chunks.find(
                (c) => c.section === 'note-mmr--catch-up-vaccination',
            );
            expect(mmrCatchup?.body).toContain('Minimum interval between doses');
            expect(mmrCatchup?.body).not.toContain('Influenza');
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

    describe('cdc-clinical-guidance', () => {
        it('emits one chunk per top-level h2 on a CDC HBP page, dropping chrome', async () => {
            const html = await loadFixture('cdc-clinical-guidance-hbp-sample.html');
            const result = extractFromHtml(
                'cdc-clinical-guidance',
                'hbp-hmp-toolkit',
                html,
            );

            expect(result.title).toBe('Hypertension Management Program (HMP) Toolkit');
            expect(result.year).toBe(2024);
            expect(result.url).toBe(
                'https://example.test/high-blood-pressure/hcp/hmp-toolkit/index.html',
            );

            // "At a glance", "Purpose", "Overview" kept;
            // "Additional content" and "On This Page" dropped.
            expect(result.chunks.map((c) => c.section)).toEqual([
                'at-a-glance',
                'purpose',
                'overview',
            ]);

            const purpose = result.chunks.find((c) => c.section === 'purpose');
            expect(purpose?.body).toContain('evidence-based BP-control protocols');
            expect(result.warnings).toEqual([]);
        });

        it('drops Million Hearts Subscribe./Connect./Explore./Take Action. chrome', async () => {
            const html = await loadFixture(
                'cdc-clinical-guidance-million-hearts-sample.html',
            );
            const result = extractFromHtml(
                'cdc-clinical-guidance',
                'million-hearts-protocols',
                html,
            );

            expect(result.chunks.map((c) => c.section)).toEqual([
                'cholesterol-management-protocols',
                'tobacco-cessation-protocols',
                'hypertension-treatment-protocols',
            ]);

            const htn = result.chunks.find(
                (c) => c.section === 'hypertension-treatment-protocols',
            );
            expect(htn?.body).toContain('Standardized hypertension treatment protocols');
            expect(result.warnings).toEqual([]);
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
