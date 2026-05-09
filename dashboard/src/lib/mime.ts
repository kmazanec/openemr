// MIME classification for the side-by-side document viewer. Mirrors
// the legacy `documentViewer.js` `classifyMime` so the same source
// document branches the same way under the React port.
//
// The rasterizer sometimes ships content types with attribute
// parameters (e.g. `application/pdf; charset=binary`) through Spaces;
// strip those before matching so PDFs land on the PDF branch.

export type DocumentMimeKind = 'pdf' | 'image' | 'tiff' | 'unsupported';

const PDF_MIME = 'application/pdf';
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
const TIFF_MIME = 'image/tiff';

export function classifyMime(mime: string | null | undefined): DocumentMimeKind {
  if (typeof mime !== 'string') return 'unsupported';
  const head = mime.split(';')[0];
  if (head === undefined) return 'unsupported';
  const normalized = head.trim().toLowerCase();
  if (normalized === PDF_MIME) return 'pdf';
  if (IMAGE_MIMES.has(normalized)) return 'image';
  if (normalized === TIFF_MIME) return 'tiff';
  return 'unsupported';
}
