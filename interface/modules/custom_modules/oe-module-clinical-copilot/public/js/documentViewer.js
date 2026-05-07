/**
 * Clinical Co-Pilot side-by-side document viewer.
 *
 * Mounts inside the panel's `[data-role="document-viewer"]` slot when an
 * extracted-document chip is clicked. Branches on the response
 * `Content-Type` of the fetched document bytes:
 *
 *   - `application/pdf` → lazy-imports PDF.js, renders the cited page to
 *     a `<canvas>`, pre-scrolls the viewer container to that page.
 *   - `image/png` / `image/jpeg` → mounts an `<img>` element. Page-N is
 *     a no-op (`pageCount=1` for image MIMEs in the rasterizer's
 *     pipeline; bbox is in image pixel space).
 *   - `image/tiff` → renders a "TIFF preview not yet supported"
 *     placeholder card with a download link to the same endpoint.
 *     Browsers cannot natively render TIFF; F.4b lifts this branch by
 *     adding a server-side TIFF→PNG decode reusing the rasterizer's
 *     existing conversion path.
 *   - Anything else → "preview not supported" placeholder.
 *
 * Both PDF and image branches share the `renderBboxOverlay(pageEl, bbox)`
 * primitive: a translucent absolute-positioned `<div>` sits inside the
 * page element's containing block and uses the bbox's `[x, y, w, h]`
 * tuple in the same coordinate space the vision pipeline recorded it.
 *
 * Decision: PDF.js is lazy-loaded from cdnjs as `pdfjs-dist@4.6.82`'s
 * `pdf.min.mjs` (paired with `pdf.worker.min.mjs`). cdnjs is the source
 * of truth — Mozilla's `pdfjs.tools` URL space serves source releases,
 * but cdnjs hosts a CORS-friendly minified ES module build that imports
 * cleanly from a `dynamic import()` call without a separate bundler.
 * Pinning a specific version (not `latest`) means a future PDF.js
 * release can't silently change rendering behavior or break our overlay
 * coordinate math. Bumping is a one-line change here plus a regression
 * pass against the document-extraction eval fixtures.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */
const __copilotDocumentViewer = (function () {
    'use strict';

    const PDFJS_VERSION = '4.6.82';
    const PDFJS_CDN_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
    const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

    /**
     * Vision-pipeline bbox coordinate space.
     *
     * The agent rasterizes PDFs at 150 DPI (see
     * `agent/src/pipeline/rasterizer.ts` — `RENDER_DPI`), but
     * Anthropic's vision API internally downscales images to 1024px
     * longest-edge for processing and returns bboxes in *that*
     * resized space — not the rasterizer's pixel space we sent.
     * Empirically confirmed by the bbox magnitudes returned for
     * 8.5×11 inputs: x ranges up to ~875, y ranges up to ~1024.
     *
     * For overlay positioning we therefore need the page's
     * vision-space denominator: (long-edge: 1024, short-edge:
     * 1024 × short_pt / long_pt). PDF.js's native viewport gives us
     * the PDF point dimensions to compute the short-edge ratio.
     *
     * If a future agent revision changes Anthropic's resize behavior
     * (e.g. higher-resolution vision, or a different SDK option) the
     * denominator here needs to track. The synthesizer prompt should
     * eventually emit the natural-size denominator alongside the
     * bbox so the panel doesn't have to guess.
     */
    const VISION_LONGEST_EDGE_PX = 1024;

    const PDF_MIME = 'application/pdf';
    const IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
    const TIFF_MIME = 'image/tiff';

    /**
     * Classify a MIME (case-insensitive, whitespace-trimmed, attribute
     * params stripped) into the branch the viewer should mount. The
     * rasterizer sometimes ships content types like "application/pdf;
     * charset=binary" through Spaces; we want those to land on the PDF
     * branch, not the unsupported branch.
     */
    const classifyMime = (mime) => {
        if (typeof mime !== 'string') return 'unsupported';
        const normalized = mime.split(';')[0].trim().toLowerCase();
        if (normalized === PDF_MIME) return 'pdf';
        if (IMAGE_MIMES.has(normalized)) return 'image';
        if (normalized === TIFF_MIME) return 'tiff';
        return 'unsupported';
    };

    /**
     * Build the document-download URL for a `(documentUuid, page)`
     * pair. The panel's PHP shell passes the URL prefix through a
     * `data-document-view-url` attribute on `.copilot-panel`; we append
     * a query string here so call sites don't have to know the
     * endpoint shape. `page` is included even on image MIMEs so a
     * future multi-page-image format can use it without changing the
     * client contract.
     */
    const buildDocumentUrl = (urlBase, documentUuid, page) => {
        if (typeof urlBase !== 'string' || urlBase.length === 0) return null;
        if (typeof documentUuid !== 'string' || documentUuid.length === 0) return null;
        const sep = urlBase.includes('?') ? '&' : '?';
        const pageParam = Number.isInteger(page) && page > 0 ? `&page=${encodeURIComponent(String(page))}` : '';
        return `${urlBase}${sep}document_uuid=${encodeURIComponent(documentUuid)}${pageParam}`;
    };

    /**
     * Bbox padding applied before rendering, to absorb known
     * vision-model imprecision.
     *
     * Empirically the model's bbox is reliably *near* the cited
     * content but biased upward — the y-coordinate lands roughly one
     * row above the actual cell (sometimes citing the section header
     * directly above the value rather than the value's row). The
     * y-padding is therefore asymmetric: more downward than upward,
     * so the highlight reliably catches the cited row even when the
     * model's y is shifted up. Empirical row height in the model's
     * output coordinate space is ~25-35 units; the values below
     * cover ~half a row above and ~one and a half rows below.
     *
     * X is padded modestly on both sides in case the model
     * undersized the column extent.
     */
    const BBOX_PAD_X = 8;
    const BBOX_PAD_TOP = 10;
    const BBOX_PAD_BOTTOM = 40;

    /**
     * Render the bbox as a translucent overlay rectangle on top of the
     * page element. The shared primitive — same code path for PDF page
     * canvases and `<img>` elements, since both establish a
     * containing-block coordinate system the absolute-positioned
     * overlay can sit inside.
     *
     * Bbox is `[x, y, w, h]` in the natural pixel space of the source
     * document (the rasterizer / vision pipeline records it that way).
     * The rendered image is scaled down by `max-width: 100%` to fit
     * the viewer pane, so absolute-pixel positioning would land the
     * overlay way past the rendered image's right edge. When
     * `naturalSize: { width, height }` is provided, the overlay is
     * positioned in percentages of those natural dimensions — the
     * overlay then scales with the rendered image. Without
     * `naturalSize` (back-compat for unit tests + the canvas branch,
     * where PDF.js's canvas already renders at the bbox's coordinate
     * space), the overlay falls back to absolute pixels.
     */
    const renderBboxOverlay = (pageEl, bbox, naturalSize) => {
        if (!(pageEl instanceof HTMLElement)) return null;
        if (!Array.isArray(bbox) || bbox.length !== 4) return null;
        const [x, y, w, h] = bbox;
        if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
        const overlay = pageEl.ownerDocument.createElement('div');
        overlay.className = 'copilot-doc-viewer__bbox';
        overlay.dataset.role = 'bbox-overlay';
        overlay.style.position = 'absolute';
        // Pad the rectangle to absorb the vision model's known
        // imprecision. Floor at 0 so a bbox near the page edges does
        // not produce negative offsets. Y-padding is asymmetric (more
        // downward than upward) to compensate for the model's
        // upward y-bias.
        const paddedX = Math.max(0, x - BBOX_PAD_X);
        const paddedY = Math.max(0, y - BBOX_PAD_TOP);
        const paddedW = w + 2 * BBOX_PAD_X;
        const paddedH = h + BBOX_PAD_TOP + BBOX_PAD_BOTTOM;
        if (naturalSize
            && typeof naturalSize.width === 'number' && naturalSize.width > 0
            && typeof naturalSize.height === 'number' && naturalSize.height > 0) {
            overlay.style.left = `${(paddedX / naturalSize.width) * 100}%`;
            overlay.style.top = `${(paddedY / naturalSize.height) * 100}%`;
            overlay.style.width = `${(paddedW / naturalSize.width) * 100}%`;
            overlay.style.height = `${(paddedH / naturalSize.height) * 100}%`;
        } else {
            overlay.style.left = `${paddedX}px`;
            overlay.style.top = `${paddedY}px`;
            overlay.style.width = `${paddedW}px`;
            overlay.style.height = `${paddedH}px`;
        }
        return overlay;
    };

    /**
     * Lazy-import PDF.js. Cached so the second PDF chip click reuses
     * the first import. The dynamic-import path is what keeps W1
     * panel's first-paint latency unchanged: until the first PDF
     * chip is clicked, the bundle is never fetched.
     */
    let pdfjsModulePromise = null;
    const loadPdfJs = (importer) => {
        if (pdfjsModulePromise !== null) return pdfjsModulePromise;
        const dynamicImport = importer || ((url) => import(url));
        pdfjsModulePromise = dynamicImport(PDFJS_CDN_URL).then((mod) => {
            const pdfjs = mod && mod.default ? mod.default : mod;
            if (pdfjs && pdfjs.GlobalWorkerOptions) {
                pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
            }
            return pdfjs;
        });
        return pdfjsModulePromise;
    };

    // The CommonJS test harness (`tests/js/copilot-panel-document-viewer.test.js`)
    // calls this to flush the cache between tests so a "first import"
    // assertion fires fresh in every test.
    const __resetPdfJsCacheForTests = () => {
        pdfjsModulePromise = null;
    };

    const clearChildren = (el) => {
        while (el.firstChild) el.removeChild(el.firstChild);
    };

    const renderPlaceholder = (mountEl, message, downloadUrl) => {
        clearChildren(mountEl);
        const card = mountEl.ownerDocument.createElement('div');
        card.className = 'copilot-doc-viewer__placeholder';
        card.dataset.role = 'viewer-placeholder';
        const text = mountEl.ownerDocument.createElement('p');
        text.textContent = message;
        card.appendChild(text);
        if (typeof downloadUrl === 'string' && downloadUrl.length > 0) {
            const link = mountEl.ownerDocument.createElement('a');
            link.href = downloadUrl;
            link.textContent = 'Download document';
            link.dataset.role = 'viewer-placeholder-download';
            link.target = '_blank';
            link.rel = 'noopener';
            card.appendChild(link);
        }
        mountEl.appendChild(card);
        return card;
    };

    const renderImage = async (mountEl, fetchedBlob, bbox) => {
        clearChildren(mountEl);
        const wrapper = mountEl.ownerDocument.createElement('div');
        wrapper.className = 'copilot-doc-viewer__page';
        wrapper.dataset.role = 'viewer-page';
        wrapper.style.position = 'relative';
        wrapper.style.display = 'inline-block';
        const img = mountEl.ownerDocument.createElement('img');
        img.className = 'copilot-doc-viewer__image';
        img.dataset.role = 'viewer-image';
        img.alt = '';
        const objectUrl = URL.createObjectURL(fetchedBlob);
        img.src = objectUrl;
        wrapper.appendChild(img);
        mountEl.appendChild(wrapper);
        // The bbox is in the source's natural-pixel coordinate space,
        // but the rendered image is scaled by `max-width: 100%`. We
        // need the image's `naturalWidth`/`naturalHeight` to convert
        // the bbox to percentages so the overlay scales with the
        // rendered image. Those are only available after `load`, so
        // attach the overlay then.
        const release = () => URL.revokeObjectURL(objectUrl);
        const onLoad = () => {
            release();
            const overlay = renderBboxOverlay(wrapper, bbox, {
                width: img.naturalWidth,
                height: img.naturalHeight,
            });
            if (overlay !== null) {
                wrapper.appendChild(overlay);
                // Center the cited region in the drawer viewport. The
                // model's bbox is approximate so a `block: 'center'`
                // scroll keeps both the highlight and a row of
                // surrounding context visible.
                overlay.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        };
        img.addEventListener('load', onLoad, { once: true });
        img.addEventListener('error', release, { once: true });
        // If the image is already loaded (e.g. from cache), the load
        // event won't fire — synthesize the same path.
        if (img.complete && img.naturalWidth > 0) onLoad();
        return wrapper;
    };

    const renderPdf = async (mountEl, fetchedBlob, page, bbox, importer) => {
        clearChildren(mountEl);
        const pdfjs = await loadPdfJs(importer);
        if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
            return renderPlaceholder(mountEl, 'PDF viewer failed to load.');
        }
        const arrayBuffer = await fetchedBlob.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        const pageNumber = Number.isInteger(page) && page > 0 ? Math.min(page, pdf.numPages) : 1;
        const pdfPage = await pdf.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        // Bboxes come back from Anthropic vision in 1024-longest-edge
        // pixel space (the API's internal resize), not the rasterizer's
        // 150 DPI pixel space. Compute the vision-space dimensions for
        // this page from the PDF's native aspect ratio so
        // renderBboxOverlay can position the overlay in percentages —
        // independent of the PDF.js render scale we choose for display.
        const nativeViewport = pdfPage.getViewport({ scale: 1 });
        const longEdge = Math.max(nativeViewport.width, nativeViewport.height);
        const shortEdge = Math.min(nativeViewport.width, nativeViewport.height);
        const visionLong = VISION_LONGEST_EDGE_PX;
        const visionShort = visionLong * (shortEdge / longEdge);
        const naturalSize = nativeViewport.width >= nativeViewport.height
            ? { width: visionLong, height: visionShort }
            : { width: visionShort, height: visionLong };
        const wrapper = mountEl.ownerDocument.createElement('div');
        wrapper.className = 'copilot-doc-viewer__page';
        wrapper.dataset.role = 'viewer-page';
        wrapper.dataset.page = String(pageNumber);
        wrapper.style.position = 'relative';
        wrapper.style.display = 'inline-block';
        const canvas = mountEl.ownerDocument.createElement('canvas');
        canvas.className = 'copilot-doc-viewer__canvas';
        canvas.dataset.role = 'viewer-canvas';
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        wrapper.appendChild(canvas);
        const overlay = renderBboxOverlay(wrapper, bbox, naturalSize);
        if (overlay !== null) wrapper.appendChild(overlay);
        mountEl.appendChild(wrapper);
        if (ctx) {
            await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        }
        // Center the cited region in the drawer viewport once the
        // canvas has finished rendering — pre-render scrolls would
        // land on a blank canvas. The model's bbox is approximate so
        // `block: 'center'` keeps the highlight + a row of
        // surrounding context visible, which gives the clinician
        // enough to confirm the citation by eye.
        if (overlay !== null) {
            overlay.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else {
            wrapper.scrollIntoView({ block: 'start' });
        }
        return wrapper;
    };

    /**
     * The single public entry point. Fetches the document, branches on
     * Content-Type, and mounts the result inside `mountEl`. `fetcher`
     * defaults to `globalThis.fetch`; tests inject a stub. Returns a
     * promise that resolves to a `{branch, mountedEl}` shape so the
     * caller can assert on the mounted element in tests.
     */
    const openDocument = async (
        mountEl,
        { documentUuid, page, bbox, mime, urlBase },
        deps = {},
    ) => {
        if (!(mountEl instanceof HTMLElement)) {
            throw new Error('openDocument: mountEl must be an HTMLElement');
        }
        const fetcher = deps.fetcher || (typeof fetch === 'function' ? fetch : null);
        if (fetcher === null) {
            return { branch: 'unsupported', mountedEl: renderPlaceholder(mountEl, 'Document fetch is unavailable in this environment.') };
        }
        const url = buildDocumentUrl(urlBase, documentUuid, page);
        if (url === null) {
            return { branch: 'unsupported', mountedEl: renderPlaceholder(mountEl, 'Document URL could not be constructed.') };
        }
        let response;
        try {
            response = await fetcher(url, { credentials: 'same-origin' });
        } catch {
            return { branch: 'fetch_failed', mountedEl: renderPlaceholder(mountEl, 'Could not load document.', url) };
        }
        if (!response || !response.ok) {
            return { branch: 'fetch_failed', mountedEl: renderPlaceholder(mountEl, 'Could not load document.', url) };
        }
        const responseMime = (response.headers && typeof response.headers.get === 'function')
            ? response.headers.get('Content-Type')
            : null;
        // Trust the response Content-Type ahead of the caller-provided
        // hint — the server is the authoritative source for what's on
        // the wire. F.4b: TIFF inputs are decoded server-side via
        // `\Imagick` in `document_view.php` and served as `image/png`,
        // so the client never sees an `image/tiff` response. The
        // `'tiff'` value classifyMime can return is therefore only
        // reachable from the caller's `mime` hint when the server
        // omitted Content-Type — in which case we fall through to the
        // unsupported-MIME placeholder, matching the defense-in-depth
        // posture of the upload-MIME enforcement.
        const branch = classifyMime(responseMime || mime);
        const blob = await response.blob();
        if (branch === 'pdf') {
            const mountedEl = await renderPdf(mountEl, blob, page, bbox, deps.pdfjsImporter);
            return { branch: 'pdf', mountedEl };
        }
        if (branch === 'image') {
            const mountedEl = await renderImage(mountEl, blob, bbox);
            return { branch: 'image', mountedEl };
        }
        return {
            branch: 'unsupported',
            mountedEl: renderPlaceholder(mountEl, 'This document type is not supported.', url),
        };
    };

    const closeViewer = (mountEl) => {
        if (!(mountEl instanceof HTMLElement)) return;
        clearChildren(mountEl);
    };

    return {
        // Pure helpers — exported for unit tests.
        classifyMime,
        buildDocumentUrl,
        renderBboxOverlay,
        // Stateful entry points — exported for the browser-side panel
        // wiring and the integration-shaped test that asserts the
        // chip-click → mount flow.
        openDocument,
        closeViewer,
        // Test seam.
        __resetPdfJsCacheForTests,
        PDFJS_VERSION,
        PDFJS_CDN_URL,
    };
})();

// Cross-script bridge for the browser. `panel.js` reaches the viewer
// implementation through `globalThis.__copilotDocumentViewer`, but a
// `const` at script-toplevel does not become a property of the
// global object — it goes into the script's own lexical environment,
// which `panel.js` (a separate <script> tag) cannot see. Assign the
// IIFE's return onto `globalThis` explicitly so the cross-script
// access works the way the unit tests expect.
if (typeof globalThis !== 'undefined') {
    globalThis.__copilotDocumentViewer = __copilotDocumentViewer;
}

// CommonJS bridge for Jest. The browser-side `<script>` tag has no
// `module` global, so this branch is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = __copilotDocumentViewer;
}
