/**
 * Unit tests for the agent-side DOCX text extractor.
 *
 * Runs against the three referral fixture DOCXs (the cohort-5 referral
 * letters) so the ZIP central-directory parse, the
 * `inflateRawSync` decompression of `word/document.xml`, and the tag
 * walker that pulls `<w:t>` runs out of `<w:p>` paragraphs are all
 * exercised on real Office-authored bytes — not just synthetic
 * archives.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DocxParseError, extractDocxText } from '../../src/pipeline/docxText.js';

const FIXTURES_DIR = join(
    __dirname,
    '..',
    '..',
    'evals',
    'fixtures',
    'document-extraction',
    'source',
    'referrals',
);

describe('extractDocxText', () => {
    it('pulls the full referral body out of the Chen DOCX', async () => {
        const bytes = await readFile(join(FIXTURES_DIR, 'p01-chen-referral.docx'));
        const { text, sourceXmlByteCount } = extractDocxText(bytes);

        expect(sourceXmlByteCount).toBeGreaterThan(0);
        // Identifying header text round-trips verbatim.
        expect(text).toContain('Berkeley Health System');
        expect(text).toContain('Margaret Chen');
        expect(text).toContain('DOB: 03/12/1968');
        // Clinical content makes it through too.
        expect(text).toContain('atorvastatin 40 mg');
        expect(text).toContain('LDL-C: 142 mg/dL');
        // Paragraph boundaries become newlines.
        expect(text).toContain('\n');
    });

    it('handles the Whitaker referral with the same shape', async () => {
        const bytes = await readFile(join(FIXTURES_DIR, 'p02-whitaker-referral.docx'));
        const { text } = extractDocxText(bytes);
        expect(text).toContain('James Whitaker');
        expect(text).toContain('DOB: 11/22/1958');
    });

    it('throws DocxParseError when fed bytes that are not a ZIP archive', () => {
        const garbage = Buffer.from('this is not a zip archive at all'.repeat(20));
        expect(() => extractDocxText(garbage)).toThrow(DocxParseError);
    });

    it('throws DocxParseError on a ZIP archive missing word/document.xml', () => {
        // Minimal valid ZIP with a single member named "junk.txt"
        // containing "hello". Hand-built so the test does not depend on
        // any other archive on disk.
        const memberName = Buffer.from('junk.txt');
        const memberContent = Buffer.from('hello');

        const local = Buffer.alloc(30 + memberName.length + memberContent.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(0, 8); // compression: stored
        local.writeUInt16LE(0, 10); // mod time
        local.writeUInt16LE(0, 12); // mod date
        local.writeUInt32LE(0, 14); // crc-32
        local.writeUInt32LE(memberContent.length, 18); // compressed size
        local.writeUInt32LE(memberContent.length, 22); // uncompressed size
        local.writeUInt16LE(memberName.length, 26);
        local.writeUInt16LE(0, 28);
        memberName.copy(local, 30);
        memberContent.copy(local, 30 + memberName.length);

        const central = Buffer.alloc(46 + memberName.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0, 8); // flags
        central.writeUInt16LE(0, 10); // compression: stored
        central.writeUInt16LE(0, 12); // mod time
        central.writeUInt16LE(0, 14); // mod date
        central.writeUInt32LE(0, 16); // crc-32
        central.writeUInt32LE(memberContent.length, 20); // compressed size
        central.writeUInt32LE(memberContent.length, 24); // uncompressed size
        central.writeUInt16LE(memberName.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk number
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(0, 42); // local header offset
        memberName.copy(central, 46);

        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4); // disk number
        eocd.writeUInt16LE(0, 6); // disk where central dir starts
        eocd.writeUInt16LE(1, 8); // total entries this disk
        eocd.writeUInt16LE(1, 10); // total entries
        eocd.writeUInt32LE(central.length, 12);
        eocd.writeUInt32LE(local.length, 16);
        eocd.writeUInt16LE(0, 20); // comment length

        const archive = Buffer.concat([local, central, eocd]);
        expect(() => extractDocxText(archive)).toThrow(DocxParseError);
    });
});
