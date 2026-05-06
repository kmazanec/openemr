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
     * Render the bbox as a translucent overlay rectangle on top of the
     * page element. The shared primitive — same code path for PDF page
     * canvases and `<img>` elements, since both establish a
     * containing-block coordinate system the absolute-positioned
     * overlay can sit inside. Bbox is `[x, y, w, h]` in the same pixel
     * space as the rendered page (PDF.js renders at our requested
     * scale; image branches use the image's natural dimensions).
     */
    const renderBboxOverlay = (pageEl, bbox) => {
        if (!(pageEl instanceof HTMLElement)) return null;
        if (!Array.isArray(bbox) || bbox.length !== 4) return null;
        const [x, y, w, h] = bbox;
        if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
        const overlay = pageEl.ownerDocument.createElement('div');
        overlay.className = 'copilot-doc-viewer__bbox';
        overlay.dataset.role = 'bbox-overlay';
        overlay.style.position = 'absolute';
        overlay.style.left = `${x}px`;
        overlay.style.top = `${y}px`;
        overlay.style.width = `${w}px`;
        overlay.style.height = `${h}px`;
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
        const overlay = renderBboxOverlay(wrapper, bbox);
        if (overlay !== null) wrapper.appendChild(overlay);
        mountEl.appendChild(wrapper);
        // Revoke the blob URL once the image has loaded (or failed) so
        // we don't leak object URLs across chip swaps.
        const release = () => URL.revokeObjectURL(objectUrl);
        img.addEventListener('load', release, { once: true });
        img.addEventListener('error', release, { once: true });
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
        const overlay = renderBboxOverlay(wrapper, bbox);
        if (overlay !== null) wrapper.appendChild(overlay);
        mountEl.appendChild(wrapper);
        // Pre-scroll the viewer container to the rendered page. With a
        // single-page render that's the top of the wrapper; if a
        // future iteration renders multiple pages, the same scrollIntoView
        // call on the targeted page wrapper is the right mechanic.
        wrapper.scrollIntoView({ block: 'start' });
        if (ctx) {
            await pdfPage.render({ canvasContext: ctx, viewport }).promise;
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

// CommonJS bridge for Jest. The browser-side `<script>` tag has no
// `module` global, so this branch is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = __copilotDocumentViewer;
}
