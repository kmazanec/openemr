import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractFromHtml } from '../../scripts/extract-uspstf-corpus.js';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function loadFixture(name: string): Promise<string> {
    return readFile(resolve(FIXTURE_DIR, name), 'utf8');
}

describe('extractFromHtml', () => {
    it('parses a well-formed USPSTF page into chunks with verbatim bodies', async () => {
        const html = await loadFixture('sample-recommendation.html');
        const result = extractFromHtml('synthetic-test-topic', html);

        expect(result.title).toBe('Synthetic Test Topic: Screening');
        expect(result.year).toBe(2024);
        expect(result.url).toBe(
            'https://example.test/uspstf/recommendation/synthetic-test-topic',
        );
        expect(result.warnings).toEqual([]);

        // The synthetic fixture lists Importance + Practice Considerations in
        // articleSection plus a recommendation summary table — we expect 3
        // chunks. Authors-of section is in DOM but not in articleSection nor
        // SECTION_MAP, so it must NOT be emitted.
        const sections = result.chunks.map((c) => c.section);
        expect(sections).toEqual([
            'recommendation-summary',
            'importance',
            'practice-considerations',
        ]);

        const summary = result.chunks.find((c) => c.section === 'recommendation-summary');
        expect(summary).toBeDefined();
        // Verbatim text from the table — pipe-joined cells per row.
        expect(summary?.body).toContain(
            'Adults aged 35 to 70 years | Sample recommendation text for adults. | B',
        );

        const importance = result.chunks.find((c) => c.section === 'importance');
        expect(importance?.body).toContain('The first sentence of the importance section.');

        const practice = result.chunks.find((c) => c.section === 'practice-considerations');
        expect(practice?.body).toContain('Practice considerations heading text.');
    });

    it('emits a missing-ld-json warning when the page has no JSON-LD block', () => {
        const result = extractFromHtml('broken', '<html><body><p>nothing useful</p></body></html>');
        expect(result.chunks).toEqual([]);
        expect(result.warnings).toContain('missing-ld-json');
    });

    it('emits a structured warning when the recommendation-summary div is absent', () => {
        const minimalLd = `
<html>
<head>
<script type="application/ld+json">
{
  "@type": "Article",
  "headline": "No-summary topic",
  "url": "https://example.test/x",
  "datePublished": "2020-01-01",
  "articleSection": []
}
</script>
</head>
<body><article></article></body>
</html>`;
        const result = extractFromHtml('no-summary', minimalLd);
        expect(result.warnings).toContain('missing-recommendation-summary');
        expect(result.chunks).toEqual([]);
        expect(result.title).toBe('No-summary topic');
        expect(result.year).toBe(2020);
    });

    it('emits an empty-section warning when an articleSection has no body', () => {
        const noBodyLd = `
<html>
<head>
<script type="application/ld+json">
{
  "@type": "Article",
  "headline": "Empty-section topic",
  "url": "https://example.test/y",
  "datePublished": "2021-06-01",
  "articleSection": ["Importance"]
}
</script>
</head>
<body>
<div class="field--name-field-recommendation-summary">
  <table><tr><td>Adults</td><td>Recommend X</td><td>A</td></tr></table>
</div>
<!-- Importance div is missing on purpose -->
</body>
</html>`;
        const result = extractFromHtml('empty-section', noBodyLd);
        expect(result.warnings).toContain('empty-section:Importance');
        expect(result.chunks.map((c) => c.section)).toEqual(['recommendation-summary']);
    });
});
