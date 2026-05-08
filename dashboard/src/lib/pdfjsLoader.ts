// Lazy PDF.js loader. Same source-of-truth as the legacy panel:
// cdnjs hosts a CORS-friendly minified ES module build at a pinned
// version, so a future PDF.js release can't silently change rendering
// behavior or break our overlay coordinate math. Bumping is a
// one-line change here plus a regression pass against the
// document-extraction eval fixtures.
//
// Cached promise so the second PDF chip click reuses the first
// import — until the first PDF chip is clicked the bundle is never
// fetched, which keeps first-paint latency unchanged.

const PDFJS_VERSION = '4.6.82';
const PDFJS_CDN_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

// PDF.js's public surface we actually use. Typed as a structural
// shape rather than pulling `@types/pdfjs-dist` because we ship no
// PDF.js bundle in our package.json — this is dynamic-import only.
export interface PdfJsModule {
  getDocument(src: { data: ArrayBuffer } | { url: string }): {
    promise: Promise<PdfDocument>;
  };
  GlobalWorkerOptions: { workerSrc: string };
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

export interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport;
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): {
    promise: Promise<void>;
  };
}

export interface PdfViewport {
  width: number;
  height: number;
}

let modulePromise: Promise<PdfJsModule> | null = null;

export type PdfJsImporter = (url: string) => Promise<unknown>;

export function loadPdfJs(importer?: PdfJsImporter): Promise<PdfJsModule> {
  if (modulePromise !== null) return modulePromise;
  // Vite's dev server normally rewrites bare `import()` URLs; the
  // string form here lets the runtime treat it as a true browser
  // dynamic import against the CDN.
  const dynamicImport: PdfJsImporter = importer ?? ((u) => import(/* @vite-ignore */ u));
  modulePromise = dynamicImport(PDFJS_CDN_URL).then((raw) => {
    const mod = raw as { default?: unknown };
    const pdfjs = (typeof mod.default === 'object' && mod.default !== null
      ? mod.default
      : raw) as PdfJsModule;
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    return pdfjs;
  });
  return modulePromise;
}

// Test-only: flush the cache so a "first import" assertion fires
// fresh between tests.
export function _resetPdfJsCacheForTests(): void {
  modulePromise = null;
}
