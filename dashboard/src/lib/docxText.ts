// Browser-side DOCX → plain text extractor.
//
// Mirrors `agent/src/pipeline/docxText.ts` (the agent-side Node port)
// so the side-panel preview shows the same text the agent's extraction
// pipeline saw. The cited-span offsets the agent records as
// `bbox = [charStart, charEnd, 0, 0]` reference offsets into THIS
// string, so the panel's highlight overlay only needs to slice the
// extracted text by those offsets.
//
// A DOCX file is a ZIP archive whose `word/document.xml` member holds
// the WordProcessingML body. We parse the central directory manually
// (no JS-side ZIP dependency), DEFLATE-decompress the document.xml
// member via `DecompressionStream` (built into modern browsers), and
// walk the XML with a tiny tag state machine that pulls `<w:t>` runs
// out of `<w:p>` paragraphs.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

export class DocxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxParseError';
  }
}

interface CentralDirRecord {
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  fileName: string;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - (22 + 0xffff));
  for (let i = view.byteLength - 22; i >= minOffset; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new DocxParseError('not a ZIP archive: end-of-central-directory not found');
}

function readCentralDirectory(view: DataView, bytes: Uint8Array): CentralDirRecord[] {
  const eocdOffset = findEndOfCentralDirectory(view);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset + cdSize > bytes.byteLength) {
    throw new DocxParseError('central directory extends past archive end');
  }

  const decoder = new TextDecoder();
  const records: CentralDirRecord[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new DocxParseError(`malformed central directory entry at offset ${cursor}`);
    }
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const fileName = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + fileNameLength),
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
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  // `DecompressionStream('deflate-raw')` is the browser-native way to
  // RFC1951-inflate without a zlib header. Available in Chrome 105+,
  // Firefox 113+, Safari 16.4+ — fully supported by the dashboard's
  // baseline.
  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function readZipMember(bytes: Uint8Array, memberName: string): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = readCentralDirectory(view, bytes);
  const record = records.find((r) => r.fileName === memberName);
  if (record === undefined) {
    throw new DocxParseError(`DOCX archive missing required member '${memberName}'`);
  }
  const local = record.localHeaderOffset;
  if (view.getUint32(local, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new DocxParseError(`malformed local file header for '${memberName}'`);
  }
  const fileNameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const dataOffset = local + 30 + fileNameLength + extraLength;
  const dataEnd = dataOffset + record.compressedSize;
  if (dataEnd > bytes.byteLength) {
    throw new DocxParseError(`'${memberName}' member data extends past archive end`);
  }
  const compressed = bytes.subarray(dataOffset, dataEnd);
  if (record.compressionMethod === 0) return compressed;
  if (record.compressionMethod === 8) return inflateRaw(compressed);
  throw new DocxParseError(
    `unsupported compression method ${record.compressionMethod} for '${memberName}'`,
  );
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(s: string): string {
  return s.replace(
    /&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/gu,
    (_match, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return String.fromCodePoint(parseInt(body.slice(2), 16));
      }
      if (body.startsWith('#')) {
        return String.fromCodePoint(parseInt(body.slice(1), 10));
      }
      return ENTITY_MAP[body] ?? `&${body};`;
    },
  );
}

function walkDocumentXml(xml: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let inTextRun = false;
  let textRunBuffer = '';

  let i = 0;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      if (inTextRun) textRunBuffer += xml[i];
      i += 1;
      continue;
    }
    const tagEnd = xml.indexOf('>', i);
    if (tagEnd === -1) break;
    const tag = xml.slice(i + 1, tagEnd);
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
  }
  return out.join('\n');
}

export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const xmlBytes = await readZipMember(bytes, 'word/document.xml');
  const xml = new TextDecoder().decode(xmlBytes);
  return walkDocumentXml(xml);
}
