import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  isFiniteBbox,
  overlayStyleForBbox,
  type Bbox,
} from '../lib/bbox';
import { classifyMime, type DocumentMimeKind } from '../lib/mime';
import { loadPdfJs, type PdfJsImporter } from '../lib/pdfjsLoader';

// Same-origin endpoint that returns the document bytes. The OpenEMR
// session cookie authenticates the request; the responder ACL-checks
// `patients/med` and verifies the document's foreign_id matches the
// session pid before emitting bytes.
const DEFAULT_DOCUMENT_VIEW_URL =
  '/interface/modules/custom_modules/oe-module-clinical-copilot/public/document_view.php';

// Render scale handed to PDF.js. 1.5 lands a sharp page on common
// laptop displays without inflating canvas memory; the bbox overlay
// tracks via percentage so the value isn't load-bearing.
const PDF_RENDER_SCALE = 1.5;

export interface DocumentViewerArgs {
  documentUuid: string;
  page: number | null;
  bbox: Bbox | null;
}

export interface DocumentViewerDrawerProps {
  args: DocumentViewerArgs | null;
  onClose: () => void;
  // Override the document fetch URL — used by tests.
  documentViewUrl?: string;
  // Override the dynamic-import path — used by tests to stub the
  // CDN load.
  pdfjsImporter?: PdfJsImporter;
}

interface FetchedDocument {
  blob: Blob;
  mime: DocumentMimeKind;
  rawMime: string;
}

/**
 * Slide-in side drawer that shows the source document for an
 * `extracted_document` chip click. Branches on the response
 * Content-Type:
 *
 *   - `application/pdf` → lazy-imports PDF.js, renders the cited page
 *     to a `<canvas>`, scrolls the viewer to that page.
 *   - `image/png` / `image/jpeg` → mounts an `<img>`. Page-N is a
 *     no-op (image formats are single-page).
 *   - `image/tiff` → "preview not supported" placeholder + download
 *     link. The PHP responder normally TIFF→PNG decodes server-side;
 *     this branch is the fallback when decoding is unavailable.
 *   - Anything else → "preview not supported".
 *
 * The bbox overlay is the same primitive across PDF and image
 * branches: a translucent absolute-positioned `<div>` inside the
 * page element's containing block. Coordinates ride on the same
 * 0..1000 grid the vision pipeline records, so a single CSS
 * percentage scales with whatever pixel size the page renders at.
 */
export function DocumentViewerDrawer({
  args,
  onClose,
  documentViewUrl = DEFAULT_DOCUMENT_VIEW_URL,
  pdfjsImporter,
}: DocumentViewerDrawerProps): ReactElement | null {
  // ESC key handler — only active when the drawer is open. The
  // legacy panel runs the same listener; keeping it here means the
  // outer panel doesn't have to know about drawer state.
  useEffect(() => {
    if (args === null) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [args, onClose]);

  if (args === null) return null;
  return (
    <DocumentViewerOpen
      args={args}
      onClose={onClose}
      documentViewUrl={documentViewUrl}
      pdfjsImporter={pdfjsImporter}
    />
  );
}

function DocumentViewerOpen({
  args,
  onClose,
  documentViewUrl,
  pdfjsImporter,
}: {
  args: DocumentViewerArgs;
  onClose: () => void;
  documentViewUrl: string;
  pdfjsImporter?: PdfJsImporter;
}): ReactElement {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; doc: FetchedDocument }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  // Re-fetch on every (documentUuid, page) change. The
  // single-call cache header on the response means a chip swap
  // hitting the same doc is cheap.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const url = buildDocumentUrl(documentViewUrl, args.documentUuid, args.page);
    void (async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
          if (!cancelled) {
            setState({ kind: 'error', message: `HTTP ${response.status}` });
          }
          return;
        }
        const rawMime = response.headers.get('Content-Type') ?? '';
        const blob = await response.blob();
        if (cancelled) return;
        setState({
          kind: 'ready',
          doc: { blob, mime: classifyMime(rawMime), rawMime },
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'fetch failed';
        setState({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [args.documentUuid, args.page, documentViewUrl]);

  return (
    <>
      <div
        className="copilot-doc-viewer-scrim"
        data-testid="copilot-doc-scrim"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.35)',
          zIndex: 1040,
        }}
      />
      <aside
        className="copilot-doc-viewer-pane shadow"
        data-testid="copilot-doc-drawer"
        role="dialog"
        aria-label="Source document"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(720px, 60vw)',
          background: '#fff',
          zIndex: 1050,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header className="d-flex align-items-center justify-content-between px-3 py-2 border-bottom">
          <h2 className="h6 mb-0">Source document</h2>
          <button
            type="button"
            className="btn-close"
            aria-label="Close source viewer"
            data-testid="copilot-doc-close"
            onClick={onClose}
          />
        </header>
        <div
          className="flex-grow-1 overflow-auto p-3 bg-light"
          data-testid="copilot-doc-body"
          style={{ minHeight: 0 }}
        >
          {state.kind === 'loading' && (
            <div className="d-flex align-items-center gap-2 text-body-secondary">
              <div className="spinner-border spinner-border-sm" role="status" />
              <span>Loading document…</span>
            </div>
          )}
          {state.kind === 'error' && (
            <ErrorPlaceholder
              message={state.message}
              downloadUrl={buildDocumentUrl(documentViewUrl, args.documentUuid, args.page)}
            />
          )}
          {state.kind === 'ready' && (
            <DocumentBody
              doc={state.doc}
              args={args}
              downloadUrl={buildDocumentUrl(documentViewUrl, args.documentUuid, args.page)}
              pdfjsImporter={pdfjsImporter}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function buildDocumentUrl(
  base: string,
  documentUuid: string,
  page: number | null,
): string {
  const sep = base.includes('?') ? '&' : '?';
  const pageParam =
    Number.isInteger(page) && (page as number) > 0 ? `&page=${encodeURIComponent(String(page))}` : '';
  return `${base}${sep}document_uuid=${encodeURIComponent(documentUuid)}${pageParam}`;
}

function ErrorPlaceholder({
  message,
  downloadUrl,
}: {
  message: string;
  downloadUrl: string;
}): ReactElement {
  return (
    <div className="alert alert-danger" role="alert" data-testid="copilot-doc-error">
      <p className="mb-1">
        <strong>Couldn&rsquo;t load this document.</strong>
      </p>
      <p className="small mb-1 text-body-secondary">{message}</p>
      <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
        Download the file
      </a>
    </div>
  );
}

function DocumentBody({
  doc,
  args,
  downloadUrl,
  pdfjsImporter,
}: {
  doc: FetchedDocument;
  args: DocumentViewerArgs;
  downloadUrl: string;
  pdfjsImporter?: PdfJsImporter;
}): ReactElement {
  switch (doc.mime) {
    case 'pdf':
      return (
        <PdfBody
          blob={doc.blob}
          page={args.page}
          bbox={args.bbox}
          pdfjsImporter={pdfjsImporter}
        />
      );
    case 'image':
      return <ImageBody blob={doc.blob} bbox={args.bbox} />;
    case 'tiff':
      return (
        <UnsupportedPlaceholder
          message="TIFF preview is not yet supported in the dashboard. Use the download link below to open it in a separate viewer."
          downloadUrl={downloadUrl}
        />
      );
    case 'unsupported':
      return (
        <UnsupportedPlaceholder
          message={`Cannot render ${doc.rawMime || 'this MIME type'} inline.`}
          downloadUrl={downloadUrl}
        />
      );
  }
}

function UnsupportedPlaceholder({
  message,
  downloadUrl,
}: {
  message: string;
  downloadUrl: string;
}): ReactElement {
  return (
    <div className="card" data-testid="copilot-doc-unsupported">
      <div className="card-body">
        <p className="mb-2">{message}</p>
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="copilot-doc-download"
        >
          Download the file
        </a>
      </div>
    </div>
  );
}

function ImageBody({ blob, bbox }: { blob: Blob; bbox: Bbox | null }): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setSrc(url);
    setNaturalSize(null);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [blob]);

  return (
    <div
      className="copilot-doc-viewer__page"
      data-testid="copilot-doc-image-wrapper"
      style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}
    >
      {src !== null && (
        <img
          src={src}
          alt=""
          style={{ display: 'block', maxWidth: '100%' }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
      )}
      {bbox !== null && isFiniteBbox(bbox) && naturalSize !== null && (
        <BboxOverlay bbox={bbox} />
      )}
    </div>
  );
}

function PdfBody({
  blob,
  page,
  bbox,
  pdfjsImporter,
}: {
  blob: Blob;
  page: number | null;
  bbox: Bbox | null;
  pdfjsImporter?: PdfJsImporter;
}): ReactElement {
  // The canvas mount is a stable, React-empty `<div>` that the async
  // effect appends a `<canvas>` to. Keeping it React-empty means
  // `removeChild` calls during chip swaps never fight with React's
  // own reconciliation pass — without this split, a chip swap that
  // racing-mounts a new canvas while React is also unmounting the
  // body throws `NotFoundError: not a child of this node`.
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<'rendering' | 'ready' | { error: string }>('rendering');

  useEffect(() => {
    let cancelled = false;
    setPhase('rendering');
    void (async () => {
      try {
        const pdfjs = await loadPdfJs(pdfjsImporter);
        const buf = await blob.arrayBuffer();
        if (cancelled) return;
        const doc = await pdfjs.getDocument({ data: buf }).promise;
        // Clamp the requested page into [1, numPages]. The agent emits
        // 1-indexed pages; an out-of-range page falls back to 1 so the
        // user still sees the document.
        const target = Number.isInteger(page) && (page as number) >= 1 ? (page as number) : 1;
        const safePage = Math.min(Math.max(target, 1), doc.numPages);
        const pdfPage = await doc.getPage(safePage);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: PDF_RENDER_SCALE });
        const container = canvasMountRef.current;
        if (container === null) return;
        // Wipe any prior canvas (chip swap). The mount is React-empty
        // so we own everything inside it imperatively.
        while (container.firstChild) container.removeChild(container.firstChild);
        const canvas = container.ownerDocument.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.display = 'block';
        canvas.style.maxWidth = '100%';
        canvas.style.height = 'auto';
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          if (!cancelled) {
            setPhase({ error: '2D canvas context unavailable' });
          }
          return;
        }
        container.appendChild(canvas);
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'PDF render failed';
        setPhase({ error: message });
      }
    })();
    // Capture the ref *now*, while the effect runs, so cleanup can
    // safely operate on the same node React was pointing at when we
    // started. `react-hooks/exhaustive-deps` requires this for any
    // ref read in cleanup.
    const containerAtSetup = canvasMountRef.current;
    return () => {
      cancelled = true;
      // Clear the canvas mount on teardown so no detached canvas
      // hangs in memory and so a re-mount starts from a known empty
      // state. `firstChild` checks make this safe even when React
      // already removed the wrapper from the live document.
      if (containerAtSetup !== null) {
        while (containerAtSetup.firstChild) {
          containerAtSetup.removeChild(containerAtSetup.firstChild);
        }
      }
    };
  }, [blob, page, pdfjsImporter]);

  return (
    <div
      data-testid="copilot-doc-pdf-wrapper"
      style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}
    >
      {phase === 'rendering' && (
        <div className="text-body-secondary small mb-2">Rendering page…</div>
      )}
      <div
        ref={canvasMountRef}
        data-testid="copilot-doc-pdf-canvas-mount"
        style={{ position: 'relative', display: 'inline-block' }}
      />
      {phase === 'ready' && bbox !== null && isFiniteBbox(bbox) && (
        <BboxOverlay bbox={bbox} />
      )}
      {typeof phase === 'object' && (
        <div className="alert alert-warning small" role="alert">
          {phase.error}
        </div>
      )}
    </div>
  );
}

function BboxOverlay({ bbox }: { bbox: Bbox }): ReactElement {
  const style = overlayStyleForBbox(bbox);
  return (
    <div
      data-testid="copilot-doc-bbox"
      data-bbox={JSON.stringify(bbox)}
      className="copilot-doc-viewer__bbox"
      style={{
        position: 'absolute',
        left: style.left,
        top: style.top,
        width: style.width,
        height: style.height,
        background: 'rgba(255, 215, 0, 0.25)',
        border: '2px solid rgba(255, 165, 0, 0.85)',
        boxShadow: '0 0 0 2px rgba(255, 165, 0, 0.25)',
        borderRadius: 2,
        pointerEvents: 'none',
      }}
    />
  );
}
