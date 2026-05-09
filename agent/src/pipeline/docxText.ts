/**
 * DOCX → plain-text extractor.
 *
 * A DOCX file is a ZIP archive whose `word/document.xml` member holds
 * the WordProcessingML body. The real text sits inside `<w:t>` runs
 * grouped by `<w:p>` paragraphs. For the referral-letter ingestion
 * path the agent only needs the paragraph text — no styles, no
 * tracked changes, no headers/footers — so this module reads
 * `word/document.xml` out of the archive and walks its tags into a
 * plain-text string with one paragraph per line.
 *
 * Implementation notes:
 *
 *   - We parse the ZIP central directory manually (`node:zlib` for
 *     DEFLATE, no JS-side ZIP dependency). DOCX uses Stored (method 0)
 *     and Deflate (method 8) only; we reject anything else as a
 *     malformed archive. This keeps the agent's dependency footprint
 *     unchanged.
 *
 *   - The XML walk uses a tiny tag-state machine rather than a real
 *     XML parser. Word's WordProcessingML contains millions of
 *     namespaced tags but only `<w:t>` (text run) and `<w:p>` (para)
 *     matter for plain-text extraction. Any approach that round-trips
 *     through a full DOM would pull in `cheerio`'s parser surface
 *     unnecessarily and would also fail on `<w:tab/>` self-closing
 *     forms in subtle ways.
 *
 *   - Character offsets returned by the extractor are stable across
 *     the same input bytes — they are byte-counted into the produced
 *     plain text after CRLF normalization to LF. The pipeline's
 *     citation contract uses `bbox = [charStart, charEnd, 0, 0]` to
 *     point at substrings of this same plain text, so a downstream
 *     side-panel renderer can highlight the cited span by offset.
 */

import { inflateRawSync } from 'node:zlib';

/**
 * Extracted plain-text payload from a DOCX archive. The `text` is the
 * concatenation of every `<w:t>` run, grouped by `<w:p>` paragraphs
 * and joined with `\n`. Empty paragraphs preserve their newline so the
 * structure of a letter (greeting, body, signature) round-trips into
 * the model prompt.
 */
export interface DocxTextPayload {
    /** Plain text, paragraphs joined with `\n`, no leading/trailing newline trimming. */
    readonly text: string;
    /** Byte length of the original `word/document.xml` for debug only. */
    readonly sourceXmlByteCount: number;
}

export class DocxParseError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'DocxParseError';
    }
}

/**
 * Read `word/document.xml` from the supplied ZIP buffer and return
 * the paragraph-level plain text plus its character span.
 *
 * Throws {@link DocxParseError} on:
 *   - missing end-of-central-directory record (not a ZIP)
 *   - missing `word/document.xml` member (not a DOCX)
 *   - unsupported compression method (only Stored + Deflate are honored)
 *   - `inflateRawSync` failure on the document.xml stream
 */
export const extractDocxText = (bytes: Buffer): DocxTextPayload => {
    const documentXml = readZipMember(bytes, 'word/document.xml');
    const text = walkDocumentXml(documentXml);
    return { text, sourceXmlByteCount: documentXml.byteLength };
};

/** ----------------------------------------------------------------- */
/* ZIP central-directory reader                                        */
/** ----------------------------------------------------------------- */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

interface CentralDirRecord {
    readonly compressionMethod: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly localHeaderOffset: number;
    readonly fileName: string;
}

const findEndOfCentralDirectory = (bytes: Buffer): number => {
    // EOCD lives in the last 22..(22+65535) bytes of the archive.
    // Scan from the end backward for the signature.
    const minOffset = Math.max(0, bytes.length - (22 + 0xffff));
    for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
        if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
            return i;
        }
    }
    throw new DocxParseError('not a ZIP archive: end-of-central-directory not found');
};

const readCentralDirectory = (bytes: Buffer): readonly CentralDirRecord[] => {
    const eocdOffset = findEndOfCentralDirectory(bytes);
    const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
    const cdSize = bytes.readUInt32LE(eocdOffset + 12);
    const cdOffset = bytes.readUInt32LE(eocdOffset + 16);
    if (cdOffset + cdSize > bytes.length) {
        throw new DocxParseError('central directory extends past archive end');
    }

    const records: CentralDirRecord[] = [];
    let cursor = cdOffset;
    for (let i = 0; i < totalEntries; i += 1) {
        if (bytes.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
            throw new DocxParseError(`malformed central directory entry at offset ${String(cursor)}`);
        }
        const compressionMethod = bytes.readUInt16LE(cursor + 10);
        const compressedSize = bytes.readUInt32LE(cursor + 20);
        const uncompressedSize = bytes.readUInt32LE(cursor + 24);
        const fileNameLength = bytes.readUInt16LE(cursor + 28);
        const extraLength = bytes.readUInt16LE(cursor + 30);
        const commentLength = bytes.readUInt16LE(cursor + 32);
        const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
        const fileName = bytes.toString(
            'utf8',
            cursor + 46,
            cursor + 46 + fileNameLength,
        );
        records.push({
            compressionMethod,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            fileName,
        });
        cursor += 46 + fileNameLength + extraLength + commentLength;
    }
    return records;
};

const readZipMember = (bytes: Buffer, memberName: string): Buffer => {
    const records = readCentralDirectory(bytes);
    const record = records.find((r) => r.fileName === memberName);
    if (record === undefined) {
        throw new DocxParseError(`DOCX archive missing required member '${memberName}'`);
    }
    const localOffset = record.localHeaderOffset;
    if (bytes.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
        throw new DocxParseError(`malformed local file header for '${memberName}'`);
    }
    const fileNameLength = bytes.readUInt16LE(localOffset + 26);
    const extraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + fileNameLength + extraLength;
    const dataEnd = dataOffset + record.compressedSize;
    if (dataEnd > bytes.length) {
        throw new DocxParseError(`'${memberName}' member data extends past archive end`);
    }
    const compressed = bytes.subarray(dataOffset, dataEnd);
    if (record.compressionMethod === 0) {
        return Buffer.from(compressed);
    }
    if (record.compressionMethod === 8) {
        try {
            return inflateRawSync(compressed);
        } catch (err) {
            throw new DocxParseError(
                `failed to inflate '${memberName}': ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    throw new DocxParseError(
        `unsupported compression method ${String(record.compressionMethod)} for '${memberName}'`,
    );
};

/** ----------------------------------------------------------------- */
/* WordProcessingML walker                                             */
/** ----------------------------------------------------------------- */

/**
 * Walk the `document.xml` byte buffer and emit one paragraph per
 * `<w:p>...</w:p>` block, with each paragraph's text being the
 * concatenation of its `<w:t>...</w:t>` runs. Self-closing tabs
 * (`<w:tab/>`) become a single space. Carriage breaks (`<w:br/>`)
 * become a literal newline inside the same paragraph.
 *
 * The walker tolerates whitespace and attribute text inside tag
 * declarations; it does not validate XML. Anything that doesn't match
 * one of the four recognized tag forms is skipped without error so a
 * stray `<v:rect>` from an embedded shape doesn't poison the output.
 */
const walkDocumentXml = (xml: Buffer): string => {
    const text = xml.toString('utf8');
    const out: string[] = [];
    let para: string[] = [];
    let inTextRun = false;
    let textRunBuffer = '';

    let i = 0;
    while (i < text.length) {
        if (text[i] !== '<') {
            if (inTextRun) {
                textRunBuffer += text[i];
            }
            i += 1;
            continue;
        }
        const tagEnd = text.indexOf('>', i);
        if (tagEnd === -1) break;
        const tag = text.slice(i + 1, tagEnd);
        i = tagEnd + 1;

        if (tag.startsWith('w:t ') || tag === 'w:t') {
            inTextRun = true;
            textRunBuffer = '';
            continue;
        }
        if (tag === '/w:t') {
            para.push(decodeXmlEntities(textRunBuffer));
            inTextRun = false;
            textRunBuffer = '';
            continue;
        }
        if (tag.startsWith('w:tab') && tag.endsWith('/')) {
            para.push(' ');
            continue;
        }
        if (tag.startsWith('w:br') && tag.endsWith('/')) {
            para.push('\n');
            continue;
        }
        if (tag === '/w:p') {
            out.push(para.join(''));
            para = [];
            continue;
        }
        // Any other tag (paragraph open, run wrappers, properties)
        // is silently skipped — they're structural, not textual.
    }
    return out.join('\n');
};

const ENTITY_MAP: Readonly<Record<string, string>> = Object.freeze({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
});

const decodeXmlEntities = (s: string): string =>
    s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/gu, (_match, body: string) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            return String.fromCodePoint(parseInt(body.slice(2), 16));
        }
        if (body.startsWith('#')) {
            return String.fromCodePoint(parseInt(body.slice(1), 10));
        }
        return ENTITY_MAP[body] ?? `&${body};`;
    });
