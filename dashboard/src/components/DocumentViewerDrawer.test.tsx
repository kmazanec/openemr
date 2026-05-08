import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentViewerDrawer } from './DocumentViewerDrawer';
import type { Bbox } from '../lib/bbox';
import { _resetPdfJsCacheForTests } from '../lib/pdfjsLoader';

function pngBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
}

function tiffBlob(): Blob {
  return new Blob([new Uint8Array([0x49, 0x49, 0x2a, 0x00])], { type: 'image/tiff' });
}

function jsonBlob(text: string): Blob {
  return new Blob([text], { type: 'application/json' });
}

describe('DocumentViewerDrawer', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // jsdom doesn't implement createObjectURL.
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = vi.fn(() => 'blob:mock-url');
      URL.revokeObjectURL = vi.fn();
    }
    _resetPdfJsCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders nothing when args is null', () => {
    const { container } = render(
      <DocumentViewerDrawer args={null} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the loading state, then the image branch with a bbox overlay', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(pngBlob(), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    );

    const bbox: Bbox = [100, 200, 300, 50];
    render(
      <DocumentViewerDrawer
        args={{ documentUuid: 'doc-1', page: 1, bbox }}
        onClose={() => {}}
      />,
    );

    // Drawer is visible immediately with a loading hint.
    expect(screen.getByTestId('copilot-doc-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('copilot-doc-body')).toHaveTextContent(/Loading document/);

    // Once the fetch resolves the image wrapper appears with the
    // <img> child mounted (`src` populates inside a useEffect, so
    // both states settle before the next paint — wait for the
    // child rather than reading immediately).
    await waitFor(() => {
      const wrapper = screen.getByTestId('copilot-doc-image-wrapper');
      const img = wrapper.querySelector('img');
      if (img === null) throw new Error('img not yet mounted');
    });
    const img = screen.getByTestId('copilot-doc-image-wrapper').querySelector('img');
    if (img === null) throw new Error('img not mounted');
    // jsdom doesn't decode PNG bytes — set naturalWidth/Height by
    // hand and dispatch the load event so the component sees it.
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1000, configurable: true });
    fireEvent.load(img);
    await waitFor(() => expect(screen.getByTestId('copilot-doc-bbox')).toBeInTheDocument());
    const overlay = screen.getByTestId('copilot-doc-bbox');
    expect(overlay.getAttribute('data-bbox')).toBe(JSON.stringify(bbox));
    // Normalized bbox → percent positioning.
    expect(overlay.style.left.endsWith('%')).toBe(true);
    expect(overlay.style.width.endsWith('%')).toBe(true);
  });

  it('shows the TIFF placeholder + download link when the response is image/tiff', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(tiffBlob(), {
          status: 200,
          headers: { 'Content-Type': 'image/tiff' },
        }),
      ),
    );
    render(
      <DocumentViewerDrawer
        args={{ documentUuid: 'doc-tiff', page: null, bbox: null }}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('copilot-doc-unsupported')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('copilot-doc-download')).toHaveAttribute(
      'href',
      expect.stringContaining('document_uuid=doc-tiff'),
    );
  });

  it('renders an error placeholder when the fetch returns a non-200', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(jsonBlob('{"error":"forbidden"}'), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    render(
      <DocumentViewerDrawer
        args={{ documentUuid: 'doc-403', page: 1, bbox: null }}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('copilot-doc-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('copilot-doc-error')).toHaveTextContent('HTTP 403');
  });

  it('clicking the close button, scrim, or pressing Escape calls onClose', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(pngBlob(), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    );
    const onClose = vi.fn();
    render(
      <DocumentViewerDrawer
        args={{ documentUuid: 'doc-1', page: 1, bbox: null }}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByTestId('copilot-doc-drawer'));

    fireEvent.click(screen.getByTestId('copilot-doc-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('copilot-doc-scrim'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('passes the page query parameter to document_view.php', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn((url: unknown) => {
      capturedUrl = String(url);
      return Promise.resolve(
        new Response(pngBlob(), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      );
    });

    render(
      <DocumentViewerDrawer
        args={{ documentUuid: 'doc-9', page: 3, bbox: null }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(capturedUrl).not.toBe(''));
    expect(capturedUrl).toContain('document_uuid=doc-9');
    expect(capturedUrl).toContain('page=3');
  });

  it('renders the PDF branch via the injected pdfjsImporter', async () => {
    // PDF.js is too heavy to load in jsdom; the importer override
    // hands us a fake module that records calls and then resolves.
    // jsdom's HTMLCanvasElement.getContext returns null by default —
    // that would push our component into the "2D canvas context
    // unavailable" error branch and we'd never reach the bbox-render
    // assertion. Stub getContext for the duration of this test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => ({}) as CanvasRenderingContext2D,
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const renderCalls: number[] = [];
    const fakePdfJs = {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({
          numPages: 5,
          getPage: vi.fn((pageNumber: number) => {
            renderCalls.push(pageNumber);
            return Promise.resolve({
              getViewport: () => ({ width: 600, height: 800 }),
              render: () => ({ promise: Promise.resolve() }),
            });
          }),
        }),
      })),
    };
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    );

    try {
      render(
        <DocumentViewerDrawer
          args={{ documentUuid: 'doc-pdf', page: 3, bbox: [100, 200, 50, 50] }}
          onClose={() => {}}
          pdfjsImporter={() => Promise.resolve(fakePdfJs)}
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('copilot-doc-pdf-wrapper')).toBeInTheDocument(),
      );
      await waitFor(() => expect(renderCalls).toContain(3));
      await waitFor(() =>
        expect(screen.getByTestId('copilot-doc-bbox')).toBeInTheDocument(),
      );
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});
