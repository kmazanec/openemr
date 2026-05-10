/**
 * F.4 Jest tests for the Clinical Co-Pilot side-by-side document viewer.
 *
 * The viewer module is a UMD-style IIFE that exports its helpers via
 * `module.exports` at the bottom (mirroring `panel.js`). We require it
 * from node and exercise the four MIME branches plus the bbox-overlay
 * primitive plus the lazy-import contract for PDF.js.
 *
 * No DOM dependency — we hand-roll a minimal `Document`/`HTMLElement`
 * stub so the test runs in jest's default node environment (consistent
 * with `copilot-panel-upload.test.js`). The viewer module reaches
 * through `mountEl.ownerDocument.createElement(...)` for new nodes;
 * everything past that uses standard property assignment + appendChild,
 * which our stub supports.
 */

const viewer = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/documentViewer.js');

const {
    classifyMime,
    buildDocumentUrl,
    renderBboxOverlay,
    openDocument,
    closeViewer,
    __resetPdfJsCacheForTests,
    PDFJS_VERSION,
    PDFJS_CDN_URL,
} = viewer;

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.className = '';
        this.firstChild = null;
        this._listeners = new Map();
        this.textContent = '';
        this.alt = '';
        this.src = '';
        this.href = '';
        this.target = '';
        this.rel = '';
        this.width = 0;
        this.height = 0;
    }

    appendChild(child) {
        this.children.push(child);
        if (this.firstChild === null) this.firstChild = child;
        return child;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        this.firstChild = this.children[0] || null;
        return child;
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
            ? this.attributes[name]
            : null;
    }

    addEventListener(name, fn) {
        if (!this._listeners.has(name)) this._listeners.set(name, []);
        this._listeners.get(name).push(fn);
    }

    scrollIntoView() { /* no-op in tests */ }

    getContext() {
        return {
            // Minimal canvas 2D context stub. The viewer only calls
            // `pdfPage.render({canvasContext})` on this so all we need
            // is for it to be truthy and not throw.
        };
    }

    querySelector(selector) {
        // Walk children and match on `[data-role="…"]`.
        const m = selector.match(/^\[data-role="([^"]+)"\]$/);
        if (!m) return null;
        const role = m[1];
        for (const child of this.children) {
            if (child.dataset && child.dataset.role === role) return child;
            if (typeof child.querySelector === 'function') {
                const found = child.querySelector(selector);
                if (found !== null) return found;
            }
        }
        return null;
    }
}

class FakeDocument {
    createElement(tagName) {
        const el = new FakeElement(tagName, this);
        if (tagName.toLowerCase() === 'img') {
            // Stand in for the browser's <img> behavior. The viewer
            // attaches the overlay on `load`, but in tests we want the
            // overlay attached synchronously so assertions can fire
            // without an event loop. Mark the image as already-loaded
            // with sensible natural dimensions so the synthesized
            // fallback path in renderImage fires.
            el.complete = true;
            el.naturalWidth = 1700;
            el.naturalHeight = 2200;
        }
        return el;
    }

    /**
     * `createElementNS` shim for the SVG path the renderer takes when
     * a bbox is an 8-tuple quad. Real browsers branch on the namespace
     * URI to construct an SVGElement subclass; FakeElement is already
     * shape-compatible (it carries `tagName`, `setAttribute`, etc.) so
     * the namespace argument is ignored — we just return a FakeElement
     * with the requested tag.
     */
    createElementNS(_namespaceURI, qualifiedName) {
        return new FakeElement(qualifiedName, this);
    }
}

const fakeMount = () => {
    const doc = new FakeDocument();
    const el = new FakeElement('div', doc);
    return el;
};

const blobLike = (mime, payload = 'BYTES') => ({
    type: mime,
    arrayBuffer: async () => new Uint8Array([...payload].map((c) => c.charCodeAt(0))).buffer,
});

const okResponse = (mime, payload = 'BYTES') => ({
    ok: true,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? mime : null) },
    blob: async () => blobLike(mime, payload),
});

beforeEach(() => {
    __resetPdfJsCacheForTests();
    // Node 18+ ships `URL.createObjectURL` / `revokeObjectURL`, but
    // the native implementations require a real Blob. The viewer
    // doesn't depend on the returned URL pointing anywhere — it just
    // assigns it as the `<img src>` — so a stub that returns a stable
    // string is sufficient for the test.
    URL.createObjectURL = () => 'blob:fake://1';
    URL.revokeObjectURL = () => {};
    // jest's default node env doesn't ship `instanceof HTMLElement`;
    // the viewer's `mountEl instanceof HTMLElement` guard would
    // refuse our FakeElement. Patch a minimal global so the duck-typed
    // mount passes the gate.
    if (typeof HTMLElement === 'undefined') {
        global.HTMLElement = FakeElement;
    }
});

describe('Cross-script global bridge', () => {
    /**
     * Browser-side, panel.js reaches the viewer through
     * `globalThis.__copilotDocumentViewer`. The IIFE assigns its
     * return into a top-level `const`, which is NOT a property of
     * the global object — it lives in the script's own lexical
     * environment, invisible to the panel.js `<script>` tag. The
     * bottom of `documentViewer.js` therefore explicitly assigns
     * the IIFE's return onto `globalThis`. Pin that contract here so
     * a future refactor that drops the explicit assignment fails the
     * test instead of silently breaking the viewer in the browser.
     */
    test('exposes __copilotDocumentViewer on globalThis', () => {
        // The require() at the top of this file ran the script, which
        // ran the IIFE, which assigned globalThis.__copilotDocumentViewer.
        expect(globalThis.__copilotDocumentViewer).toBeDefined();
        expect(typeof globalThis.__copilotDocumentViewer.openDocument).toBe('function');
        expect(typeof globalThis.__copilotDocumentViewer.closeViewer).toBe('function');
        expect(typeof globalThis.__copilotDocumentViewer.classifyMime).toBe('function');
    });

    test('the global reference equals the require() return', () => {
        const required = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/documentViewer.js');
        expect(globalThis.__copilotDocumentViewer).toBe(required);
    });
});

describe('classifyMime — MIME → branch dispatch', () => {
    test.each([
        ['application/pdf', 'pdf'],
        ['APPLICATION/PDF', 'pdf'],
        ['application/pdf; charset=binary', 'pdf'],
        ['image/png', 'image'],
        ['image/jpeg', 'image'],
        ['image/jpeg ; foo=bar', 'image'],
        ['image/tiff', 'tiff'],
        ['image/gif', 'unsupported'],
        ['application/octet-stream', 'unsupported'],
        ['', 'unsupported'],
        [null, 'unsupported'],
        [undefined, 'unsupported'],
    ])('classifies %p as %p', (mime, expected) => {
        expect(classifyMime(mime)).toBe(expected);
    });
});

describe('buildDocumentUrl — URL composition', () => {
    test('appends document_uuid + page query params', () => {
        const url = buildDocumentUrl('/svc/document_view.php', 'doc-uuid', 3);
        expect(url).toBe('/svc/document_view.php?document_uuid=doc-uuid&page=3');
    });

    test('omits page when not a positive integer', () => {
        expect(buildDocumentUrl('/svc/x', 'doc-uuid', null))
            .toBe('/svc/x?document_uuid=doc-uuid');
        expect(buildDocumentUrl('/svc/x', 'doc-uuid', 0))
            .toBe('/svc/x?document_uuid=doc-uuid');
    });

    test('uses & when the base URL already has a query string', () => {
        const url = buildDocumentUrl('/svc/x?token=abc', 'doc-uuid', 1);
        expect(url).toBe('/svc/x?token=abc&document_uuid=doc-uuid&page=1');
    });

    test('encodes UUID and page values', () => {
        const url = buildDocumentUrl('/svc/x', 'a b/c', 4);
        expect(url).toContain('document_uuid=a%20b%2Fc');
    });

    test('returns null on missing inputs', () => {
        expect(buildDocumentUrl('', 'd', 1)).toBeNull();
        expect(buildDocumentUrl('/svc/x', '', 1)).toBeNull();
        expect(buildDocumentUrl(null, 'd', 1)).toBeNull();
    });
});

describe('renderBboxOverlay — shared overlay primitive', () => {
    // Bbox is normalized on a 0..1000 grid; the overlay positions in
    // CSS percentages with a small symmetric pad (also in grid units)
    // on every side.
    const GRID = 1000;
    const PAD_X = 2;
    const PAD_TOP = 2;
    const PAD_BOTTOM = 2;

    test('produces an absolute-positioned div with percentage left/top/width/height', () => {
        const mount = fakeMount();
        const overlay = renderBboxOverlay(mount, [100, 200, 300, 50]);
        expect(overlay).not.toBeNull();
        expect(overlay.tagName).toBe('DIV');
        expect(overlay.dataset.role).toBe('bbox-overlay');
        expect(overlay.style.position).toBe('absolute');
        expect(overlay.style.left).toBe(`${((100 - PAD_X) / GRID) * 100}%`);
        expect(overlay.style.top).toBe(`${((200 - PAD_TOP) / GRID) * 100}%`);
        expect(overlay.style.width).toBe(`${((300 + 2 * PAD_X) / GRID) * 100}%`);
        expect(overlay.style.height).toBe(`${((50 + PAD_TOP + PAD_BOTTOM) / GRID) * 100}%`);
    });

    test('clamps padded x and y at zero for a top-left near-edge bbox', () => {
        const mount = fakeMount();
        // x=0, y=0 — both less than the pad; expect left=0%, top=0%.
        const overlay = renderBboxOverlay(mount, [0, 0, 200, 100]);
        expect(overlay.style.left).toBe('0%');
        expect(overlay.style.top).toBe('0%');
    });

    test('clamps padded width/height so a wide bbox cannot exceed 100%', () => {
        const mount = fakeMount();
        // x=0, w=1000 — already full-width. Padding would push w past
        // the grid bound; the overlay must clamp so paddedX + paddedW
        // <= GRID.
        const overlay = renderBboxOverlay(mount, [0, 100, 1000, 50]);
        const widthPct = parseFloat(overlay.style.width);
        expect(widthPct).toBeLessThanOrEqual(100);
    });

    test('legacy pixel-space bbox falls back to absolute pixel positioning', () => {
        const mount = fakeMount();
        // Pre-normalization snapshots had bboxes in raw pixel space,
        // e.g. [55, 228, 820, 38] where x+w=875 exceeds the 1000-grid
        // when y+h does too. The renderer keeps those overlays at
        // absolute pixel coords (without padding) so old conversations
        // still render a defensible region.
        const overlay = renderBboxOverlay(mount, [55, 1228, 820, 38]);
        expect(overlay).not.toBeNull();
        expect(overlay.style.left).toBe('55px');
        expect(overlay.style.top).toBe('1228px');
        expect(overlay.style.width).toBe('820px');
        expect(overlay.style.height).toBe('38px');
    });

    test('refuses non-array or wrong-arity bbox', () => {
        const mount = fakeMount();
        expect(renderBboxOverlay(mount, null)).toBeNull();
        expect(renderBboxOverlay(mount, [1, 2, 3])).toBeNull();
        expect(renderBboxOverlay(mount, [1, 2, 3, 'four'])).toBeNull();
    });

    test('refuses non-element page anchor', () => {
        expect(renderBboxOverlay(null, [100, 200, 300, 50])).toBeNull();
        expect(renderBboxOverlay({}, [100, 200, 300, 50])).toBeNull();
    });

});

describe('openDocument — branch dispatch by Content-Type', () => {
    test('PNG response mounts an <img> wrapper with bbox overlay', async () => {
        const GRID = 1000;
        const PAD_X = 2;
        const PAD_TOP = 2;
        const PAD_BOTTOM = 2;
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('image/png'));
        const result = await openDocument(
            mount,
            { documentUuid: 'doc-1', page: 1, bbox: [120, 140, 60, 30], mime: 'image/png', urlBase: '/svc/x' },
            { fetcher },
        );
        expect(result.branch).toBe('image');
        expect(fetcher).toHaveBeenCalledWith(
            '/svc/x?document_uuid=doc-1&page=1',
            { credentials: 'same-origin' },
        );
        expect(mount.children.length).toBe(1);
        const wrapper = mount.children[0];
        expect(wrapper.dataset.role).toBe('viewer-page');
        const img = wrapper.children.find((c) => c.dataset.role === 'viewer-image');
        const overlay = wrapper.children.find((c) => c.dataset.role === 'bbox-overlay');
        expect(img).toBeDefined();
        expect(overlay).toBeDefined();
        // Overlay positions divide grid coords by 1000 to get a CSS
        // percentage — independent of the image's natural dimensions.
        expect(overlay.style.left).toBe(`${((120 - PAD_X) / GRID) * 100}%`);
        expect(overlay.style.top).toBe(`${((140 - PAD_TOP) / GRID) * 100}%`);
        expect(overlay.style.width).toBe(`${((60 + 2 * PAD_X) / GRID) * 100}%`);
        expect(overlay.style.height).toBe(`${((30 + PAD_TOP + PAD_BOTTOM) / GRID) * 100}%`);
    });

    test('JPEG response mounts an <img> wrapper (same branch as PNG)', async () => {
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('image/jpeg'));
        const result = await openDocument(
            mount,
            { documentUuid: 'doc-2', page: 1, bbox: null, mime: 'image/jpeg', urlBase: '/svc/x' },
            { fetcher },
        );
        expect(result.branch).toBe('image');
        const img = mount.children[0].children.find((c) => c.dataset.role === 'viewer-image');
        expect(img).toBeDefined();
    });

    test('PDF response lazy-imports PDF.js, renders a canvas, attaches overlay', async () => {
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('application/pdf'));
        const renderPromise = Promise.resolve();
        const fakePage = {
            getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
            render: ({ canvasContext, viewport }) => {
                expect(canvasContext).toBeDefined();
                expect(viewport.width).toBeGreaterThan(0);
                return { promise: renderPromise };
            },
        };
        const fakePdf = {
            numPages: 5,
            getPage: jest.fn().mockResolvedValue(fakePage),
        };
        const fakePdfjs = {
            GlobalWorkerOptions: {},
            getDocument: ({ data }) => {
                expect(data instanceof ArrayBuffer || data instanceof Uint8Array || (data && data.buffer !== undefined)).toBe(true);
                return { promise: Promise.resolve(fakePdf) };
            },
        };
        const importer = jest.fn().mockResolvedValue(fakePdfjs);

        const result = await openDocument(
            mount,
            { documentUuid: 'doc-3', page: 2, bbox: [1, 2, 3, 4], mime: 'application/pdf', urlBase: '/svc/x' },
            { fetcher, pdfjsImporter: importer },
        );

        expect(result.branch).toBe('pdf');
        expect(importer).toHaveBeenCalledTimes(1);
        expect(importer).toHaveBeenCalledWith(PDFJS_CDN_URL);
        expect(fakePdfjs.GlobalWorkerOptions.workerSrc).toMatch(new RegExp(`/${PDFJS_VERSION}/pdf\\.worker`));
        expect(fakePdf.getPage).toHaveBeenCalledWith(2);
        const wrapper = mount.children[0];
        expect(wrapper.dataset.page).toBe('2');
        const canvas = wrapper.children.find((c) => c.dataset.role === 'viewer-canvas');
        const overlay = wrapper.children.find((c) => c.dataset.role === 'bbox-overlay');
        expect(canvas).toBeDefined();
        expect(overlay).toBeDefined();
    });

    test('PDF requests reuse the cached PDF.js module on the second click', async () => {
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('application/pdf'));
        const fakePage = {
            getViewport: () => ({ width: 100, height: 100 }),
            render: () => ({ promise: Promise.resolve() }),
        };
        const fakePdfjs = {
            GlobalWorkerOptions: {},
            getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => fakePage }) }),
        };
        const importer = jest.fn().mockResolvedValue(fakePdfjs);
        await openDocument(
            mount,
            { documentUuid: 'd', page: 1, bbox: [0, 0, 1, 1], mime: 'application/pdf', urlBase: '/svc/x' },
            { fetcher, pdfjsImporter: importer },
        );
        await openDocument(
            mount,
            { documentUuid: 'd2', page: 1, bbox: [0, 0, 1, 1], mime: 'application/pdf', urlBase: '/svc/x' },
            { fetcher, pdfjsImporter: importer },
        );
        expect(importer).toHaveBeenCalledTimes(1);
    });

    test('TIFF hint + image/png response routes through the image branch (F.4b server decode)', async () => {
        // F.4b: `document_view.php` decodes `image/tiff` server-side via
        // `\Imagick` and serves `image/png` — the client never sees an
        // `image/tiff` response and the hint-only "TIFF placeholder"
        // branch from F.4 is gone. The fetch fires; the response's
        // `image/png` Content-Type drives dispatch to the existing
        // image-mount path; the bbox-overlay primitive Just Works.
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('image/png'));
        const importer = jest.fn();
        const result = await openDocument(
            mount,
            { documentUuid: 'doc-tiff', page: 1, bbox: [0, 0, 10, 10], mime: 'image/tiff', urlBase: '/svc/x' },
            { fetcher, pdfjsImporter: importer },
        );
        expect(result.branch).toBe('image');
        expect(importer).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledWith(
            '/svc/x?document_uuid=doc-tiff&page=1',
            { credentials: 'same-origin' },
        );
        const wrapper = mount.children[0];
        expect(wrapper.dataset.role).toBe('viewer-page');
        const img = wrapper.children.find((c) => c.dataset.role === 'viewer-image');
        const overlay = wrapper.children.find((c) => c.dataset.role === 'bbox-overlay');
        expect(img).toBeDefined();
        expect(overlay).toBeDefined();
    });

    test('TIFF hint + missing response Content-Type falls through to unsupported (defense in depth)', async () => {
        // If the server responds without a Content-Type header the
        // viewer falls back to the caller's `mime` hint. After F.4b
        // the server is supposed to *always* set Content-Type to
        // image/png for TIFF inputs, so a missing header on a TIFF-
        // hint request is a malformed response. Mount the unsupported
        // placeholder rather than try to render raw TIFF bytes (which
        // browsers cannot natively render).
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue({
            ok: true,
            headers: { get: () => null },
            blob: async () => blobLike('image/tiff'),
        });
        const importer = jest.fn();
        const result = await openDocument(
            mount,
            { documentUuid: 'doc-tiff', page: 1, bbox: [0, 0, 10, 10], mime: 'image/tiff', urlBase: '/svc/x' },
            { fetcher, pdfjsImporter: importer },
        );
        expect(result.branch).toBe('unsupported');
        expect(mount.children[0].dataset.role).toBe('viewer-placeholder');
    });

    test('Server response Content-Type wins over caller hint', async () => {
        // Hint says PDF, server returns image/png — image branch should
        // win because the server is authoritative.
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('image/png'));
        const importer = jest.fn();
        const result = await openDocument(
            mount,
            { documentUuid: 'doc-x', page: 1, bbox: [0, 0, 1, 1], mime: 'application/pdf', urlBase: '/svc/x' },
            { fetcher, pdfjsImporter: importer },
        );
        expect(result.branch).toBe('image');
        expect(importer).not.toHaveBeenCalled();
    });

    test('Fetch failure mounts a placeholder, does not throw', async () => {
        const mount = fakeMount();
        const fetcher = jest.fn().mockRejectedValue(new Error('net'));
        const result = await openDocument(
            mount,
            { documentUuid: 'd', page: 1, bbox: null, mime: 'application/pdf', urlBase: '/svc/x' },
            { fetcher },
        );
        expect(result.branch).toBe('fetch_failed');
        expect(mount.children[0].dataset.role).toBe('viewer-placeholder');
    });

    test('Non-OK response mounts a placeholder', async () => {
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue({ ok: false, headers: { get: () => null }, blob: async () => blobLike('text/plain') });
        const result = await openDocument(
            mount,
            { documentUuid: 'd', page: 1, bbox: null, mime: 'image/png', urlBase: '/svc/x' },
            { fetcher },
        );
        expect(result.branch).toBe('fetch_failed');
    });

    test('Unrecognized server MIME mounts the unsupported-document placeholder', async () => {
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('application/octet-stream'));
        const result = await openDocument(
            mount,
            { documentUuid: 'd', page: 1, bbox: null, mime: 'application/pdf', urlBase: '/svc/x' },
            { fetcher },
        );
        expect(result.branch).toBe('unsupported');
        expect(mount.children[0].dataset.role).toBe('viewer-placeholder');
    });
});

describe('closeViewer — clears the mount', () => {
    test('removes any mounted children', async () => {
        const mount = fakeMount();
        const fetcher = jest.fn().mockResolvedValue(okResponse('image/png'));
        await openDocument(
            mount,
            { documentUuid: 'd', page: 1, bbox: null, mime: 'image/png', urlBase: '/svc/x' },
            { fetcher },
        );
        expect(mount.children.length).toBeGreaterThan(0);
        closeViewer(mount);
        expect(mount.children.length).toBe(0);
        expect(mount.firstChild).toBeNull();
    });
});

describe('Viewer-args extraction from a SourceReference', () => {
    const { viewerArgsFromSource } = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

    test('extracts uuid + page + bbox + mime from an extracted_document ref', () => {
        const ref = {
            source_type: 'extracted_document',
            source_id: 'art-1',
            locator: { page: 2, bbox: [1, 2, 3, 4], field: 'results.0.value' },
            meta: { document_uuid: 'doc-uuid-1', mime_type: 'application/pdf' },
        };
        expect(viewerArgsFromSource(ref)).toEqual({
            documentUuid: 'doc-uuid-1',
            page: 2,
            bbox: [1, 2, 3, 4],
            mime: 'application/pdf',
        });
    });

    test('returns null for non-extracted source types', () => {
        expect(viewerArgsFromSource({ source_type: 'chart', source_id: 'p-1', locator: {}, meta: {} })).toBeNull();
        expect(viewerArgsFromSource({ source_type: 'guideline', source_id: 'g-1', locator: {}, meta: {} })).toBeNull();
    });

    test('returns null when document_uuid is absent', () => {
        const ref = {
            source_type: 'extracted_document',
            source_id: 'art-1',
            locator: { page: 1, bbox: [0, 0, 1, 1] },
            meta: {},
        };
        expect(viewerArgsFromSource(ref)).toBeNull();
    });

    test('tolerates missing page / bbox / mime', () => {
        const ref = {
            source_type: 'extracted_document',
            source_id: 'art-1',
            locator: {},
            meta: { document_uuid: 'doc-uuid-1' },
        };
        expect(viewerArgsFromSource(ref)).toEqual({
            documentUuid: 'doc-uuid-1',
            page: null,
            bbox: null,
            mime: null,
        });
    });
});

describe('Viewer-args extraction from a section chip\'s data-* attributes', () => {
    const { sectionChipViewerArgs } = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

    /**
     * Section chips ("From documents" / "Evidence" rolled-up surface)
     * don't have access to the `thread[bubbleIdx].message.segments[…]`
     * lookup the inline chips use, so they encode the viewer args
     * directly on the chip's data-* attributes at render time. The
     * click handler reads them back via `sectionChipViewerArgs`.
     */
    const fakeChipDataset = (overrides) => ({
        dataset: {
            documentUuid: 'doc-uuid-1',
            page: '2',
            bbox: '[1,2,3,4]',
            mime: 'application/pdf',
            ...overrides,
        },
    });

    test('decodes uuid + page + bbox + mime back into the openDocument args shape', () => {
        const chip = fakeChipDataset();
        expect(sectionChipViewerArgs(chip)).toEqual({
            documentUuid: 'doc-uuid-1',
            page: 2,
            bbox: [1, 2, 3, 4],
            mime: 'application/pdf',
        });
    });

    test('returns null when the document UUID is missing', () => {
        const chip = fakeChipDataset({ documentUuid: undefined });
        expect(sectionChipViewerArgs(chip)).toBeNull();
    });

    test('returns null when the document UUID is empty string', () => {
        const chip = fakeChipDataset({ documentUuid: '' });
        expect(sectionChipViewerArgs(chip)).toBeNull();
    });

    test('tolerates missing page / bbox / mime', () => {
        const chip = fakeChipDataset({ page: '', bbox: '', mime: '' });
        expect(sectionChipViewerArgs(chip)).toEqual({
            documentUuid: 'doc-uuid-1',
            page: null,
            bbox: null,
            mime: null,
        });
    });

    test('rejects malformed bbox JSON without throwing', () => {
        const chip = fakeChipDataset({ bbox: 'not[json' });
        const args = sectionChipViewerArgs(chip);
        expect(args).not.toBeNull();
        expect(args.bbox).toBeNull();
    });

    test('rejects bbox with the wrong arity (defensive parse)', () => {
        const chip = fakeChipDataset({ bbox: '[1,2,3]' });
        const args = sectionChipViewerArgs(chip);
        expect(args.bbox).toBeNull();
    });

    test('rejects bbox with non-numeric entries', () => {
        const chip = fakeChipDataset({ bbox: '[1,2,3,"four"]' });
        const args = sectionChipViewerArgs(chip);
        expect(args.bbox).toBeNull();
    });

    test('parses page as integer; non-integer page yields null', () => {
        const chip = fakeChipDataset({ page: 'abc' });
        const args = sectionChipViewerArgs(chip);
        expect(args.page).toBeNull();
    });
});
