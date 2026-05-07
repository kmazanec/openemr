import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDlgopen, closeDialog, installDlgopen } from './dlgopen';

describe('dlgopen — basic shape', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('opens a Bootstrap modal with an iframe pointing at the URL', () => {
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/page', '_blank', 800, 500);

    const modal = document.querySelector('.modal');
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute('role')).toBe('dialog');

    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe('http://example.test/page');
  });

  it('honours opts.dialogId', () => {
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/page', '_blank', 800, 500, true, 'My modal', {
      dialogId: 'pop-foo',
    });

    expect(document.getElementById('pop-foo')).not.toBeNull();
  });

  it('renders a title when provided', () => {
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/page', '_blank', 800, 500, true, 'Hello title');

    const title = document.querySelector('.modal-title');
    expect(title?.textContent).toBe('Hello title');
  });

  it('skips the header when no title is given', () => {
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/page', '_blank', 800, 500);

    expect(document.querySelector('.modal-header')).toBeNull();
  });

  it('forwards numeric width/height as px', () => {
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/page', '_blank', 800, 500);

    const dialog = document.querySelector<HTMLElement>('.modal-dialog');
    const content = document.querySelector<HTMLElement>('.modal-content');
    expect(dialog?.style.maxWidth).toBe('800px');
    expect(content?.style.height).toBe('500px');
  });

  it('forwards string width/height verbatim', () => {
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/page', '_blank', '100%', 'auto');

    const dialog = document.querySelector<HTMLElement>('.modal-dialog');
    const content = document.querySelector<HTMLElement>('.modal-content');
    expect(dialog?.style.maxWidth).toBe('100%');
    expect(content?.style.height).toBe('auto');
  });

  it('throws on unsupported opts.type (non-iframe)', () => {
    const dlgopen = buildDlgopen({ doc: document, win: window });

    expect(() => {
      dlgopen('http://example.test/page', '_blank', 800, 500, true, 'X', {
        type: 'html',
      });
    }).toThrow(/unsupported opts.type "html"/);
  });
});

describe('dlgopen — closing behaviour', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('clicking the backdrop fires onClosed (function)', () => {
    const onClosed = vi.fn();
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/p', '_blank', 800, 500, true, '', { onClosed });

    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement;
    backdrop.click();

    expect(onClosed).toHaveBeenCalledOnce();
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('Escape key fires onClosed', () => {
    const onClosed = vi.fn();
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/p', '_blank', 800, 500, true, '', { onClosed });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClosed).toHaveBeenCalledOnce();
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('header close button fires onClosed', () => {
    const onClosed = vi.fn();
    const dlgopen = buildDlgopen({ doc: document, win: window });

    dlgopen('http://example.test/p', '_blank', 800, 500, true, 'titled', {
      onClosed,
    });

    const closeBtn = document.querySelector('.btn-close') as HTMLButtonElement;
    closeBtn.click();

    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('string onClosed resolves to a global function on the window', () => {
    const onClosedHandler = vi.fn();
    // Stash on window so the string lookup finds it.
    (window as unknown as Record<string, unknown>)['__t3_4_callback'] =
      onClosedHandler;
    try {
      const dlgopen = buildDlgopen({ doc: document, win: window });
      dlgopen('http://example.test/p', '_blank', 800, 500, true, '', {
        onClosed: '__t3_4_callback',
      });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(onClosedHandler).toHaveBeenCalledOnce();
    } finally {
      delete (window as unknown as Record<string, unknown>)['__t3_4_callback'];
    }
  });

  it('closeDialog is idempotent — calling twice fires onClosed once', () => {
    const onClosed = vi.fn();
    const dlgopen = buildDlgopen({ doc: document, win: window });

    const modal = dlgopen('http://example.test/p', '_blank', 800, 500, true, '', {
      onClosed,
    });

    closeDialog(modal);
    closeDialog(modal);

    expect(onClosed).toHaveBeenCalledOnce();
  });

  it('Escape after close does not fire onClosed again', () => {
    const onClosed = vi.fn();
    const dlgopen = buildDlgopen({ doc: document, win: window });

    const modal = dlgopen('http://example.test/p', '_blank', 800, 500, true, '', {
      onClosed,
    });
    closeDialog(modal);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClosed).toHaveBeenCalledOnce();
  });
});

describe('installDlgopen', () => {
  let prevDlgopen: unknown;

  beforeEach(() => {
    document.body.innerHTML = '';
    prevDlgopen = (window as unknown as Record<string, unknown>)['dlgopen'];
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>)['dlgopen'] = prevDlgopen;
  });

  it('exposes dlgopen on the target window', () => {
    const dlgopen = installDlgopen({ doc: document, win: window });

    const top = window.top ?? window;
    expect((top as unknown as { dlgopen: unknown }).dlgopen).toBe(dlgopen);
  });
});
