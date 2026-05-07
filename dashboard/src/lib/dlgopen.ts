/**
 * dlgopen() shim — Bootstrap-5-modal-style replacement for the
 * legacy `top.dlgopen` from library/dialog.js. Legacy iframes call
 * `top.dlgopen(url, target, w, h, modal, title, opts)` and expect
 * a modal hosting an iframe of the URL. T3.4 covers the contract.
 *
 * The styling assumes Bootstrap 5 CSS is loaded in the host page
 * (main_v2.php pulls in OpenEMR's existing Bootstrap 5 stylesheet).
 * The DOM uses standard `modal`, `modal-dialog`, `modal-content`,
 * etc. classes so the look matches the rest of the app without us
 * shipping CSS.
 *
 * What we honour:
 *   - opts.dialogId        sets the modal's id
 *   - opts.type            'iframe' (default behaviour) — body is an iframe
 *   - opts.onClosed        function | string — fires on close (string
 *                          is treated as the name of a global function)
 *   - opts.allowResize     reserved for future use; currently the
 *                          modal is fixed-size per w/h
 *   - opts.allowDrag       reserved for future use
 *
 * Closing: Escape key, backdrop click, or programmatic
 * `closeDialog(modalEl)` all fire `onClosed`.
 */

export interface DlgopenOptions {
  dialogId?: string;
  /**
   * Body type. `'iframe'` (default) hosts the URL in an iframe.
   * Reserved for future expansion; raw-HTML is out of scope for T3.4.
   */
  type?: string;
  /** Called when the modal closes. String names a global function. */
  onClosed?: string | (() => void);
  /** Reserved — currently not implemented. */
  allowResize?: boolean;
  /** Reserved — currently not implemented. */
  allowDrag?: boolean;
  /** Width hint forwarded as inline style on the dialog. */
  sizeWidth?: number | string;
  /** Height hint forwarded as inline style on the dialog. */
  sizeHeight?: number | string;
}

export interface DlgopenDeps {
  /** DOM document; defaulted from window in the public installer. */
  doc?: Document;
  /** Window the modal is opened against; for resolving onClosed strings. */
  win?: Window & typeof globalThis;
}

export type DlgopenSignature = (
  this: void,
  url: string,
  target?: string,
  width?: number | string,
  height?: number | string,
  modal?: boolean,
  title?: string,
  opts?: DlgopenOptions,
) => HTMLElement;

/**
 * Build a `dlgopen` function bound to the given doc/win. Tests pass
 * a JSDOM document; the installer below uses `globalThis`.
 */
export function buildDlgopen(deps: DlgopenDeps = {}): DlgopenSignature {
  const doc = deps.doc ?? document;
  const win = deps.win ?? (globalThis as unknown as Window & typeof globalThis);

  const dlgopen: DlgopenSignature = (
    url,
    _target,
    width,
    height,
    _modal,
    title,
    opts,
  ): HTMLElement => {
    const o: DlgopenOptions = opts ?? {};
    const modalEl = doc.createElement('div');
    modalEl.className = 'modal fade show d-block';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('tabindex', '-1');
    if (typeof o.dialogId === 'string' && o.dialogId !== '') {
      modalEl.id = o.dialogId;
    }

    const dialog = doc.createElement('div');
    dialog.className = 'modal-dialog modal-dialog-centered';
    if (width !== undefined) {
      dialog.style.maxWidth = sizeToCss(width);
    }
    modalEl.appendChild(dialog);

    const content = doc.createElement('div');
    content.className = 'modal-content';
    if (height !== undefined) {
      content.style.height = sizeToCss(height);
    }
    dialog.appendChild(content);

    if (typeof title === 'string' && title !== '') {
      const header = doc.createElement('div');
      header.className = 'modal-header';
      const titleEl = doc.createElement('h5');
      titleEl.className = 'modal-title';
      titleEl.textContent = title;
      header.appendChild(titleEl);
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.addEventListener('click', () => {
        closeDialog(modalEl);
      });
      header.appendChild(closeBtn);
      content.appendChild(header);
    }

    const body = doc.createElement('div');
    body.className = 'modal-body p-0';
    content.appendChild(body);

    // Default behaviour is to render the URL in an iframe; the
    // legacy `type !== 'iframe'` paths (raw HTML inject) are out of
    // scope for T3.4 — flag them rather than guess.
    const type = o.type ?? 'iframe';
    if (type !== 'iframe') {
      throw new Error(`dlgopen: unsupported opts.type "${type}"`);
    }
    const frame = doc.createElement('iframe');
    frame.src = url;
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.border = '0';
    body.appendChild(frame);

    // Backdrop: clicking outside the dialog closes the modal. Match
    // Bootstrap's behaviour by adding a sibling element.
    const backdrop = doc.createElement('div');
    backdrop.className = 'modal-backdrop fade show';
    backdrop.addEventListener('click', () => {
      closeDialog(modalEl);
    });

    // Escape closes the modal.
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeDialog(modalEl);
      }
    };
    doc.addEventListener('keydown', onKeydown);

    // Persist the cleanup hooks on the modal so closeDialog can find
    // them. Stored under unique keys to avoid colliding with dataset
    // strings (which are stringified).
    const modalState: ModalState = {
      onClosed: o.onClosed,
      backdrop,
      keydownHandler: onKeydown,
      win,
      doc,
      closed: false,
    };
    modalStates.set(modalEl, modalState);

    doc.body.appendChild(backdrop);
    doc.body.appendChild(modalEl);
    return modalEl;
  };

  return dlgopen;
}

interface ModalState {
  onClosed: DlgopenOptions['onClosed'];
  backdrop: HTMLElement;
  keydownHandler: (event: KeyboardEvent) => void;
  win: Window & typeof globalThis;
  doc: Document;
  closed: boolean;
}

const modalStates = new WeakMap<HTMLElement, ModalState>();

/**
 * Close a modal opened by dlgopen. Idempotent — calling twice on
 * the same element is safe. Used internally by the click/Escape/
 * backdrop handlers; exported so callers can close programmatically.
 */
export function closeDialog(modalEl: HTMLElement): void {
  const state = modalStates.get(modalEl);
  if (state === undefined || state.closed) {
    return;
  }
  state.closed = true;
  state.doc.removeEventListener('keydown', state.keydownHandler);
  state.backdrop.remove();
  modalEl.remove();

  const onClosed = state.onClosed;
  if (typeof onClosed === 'function') {
    onClosed();
  } else if (typeof onClosed === 'string' && onClosed !== '') {
    // Legacy contract: string onClosed names a global function.
    const fn = (state.win as unknown as Record<string, unknown>)[onClosed];
    if (typeof fn === 'function') {
      (fn as () => void)();
    }
  }
}

/**
 * Install `top.dlgopen` so legacy iframes can call it as
 * `top.dlgopen(url, ...)`. Idempotent.
 */
export function installDlgopen(deps: DlgopenDeps = {}): DlgopenSignature {
  const win = deps.win ?? (globalThis as unknown as Window & typeof globalThis);
  const dlgopen = buildDlgopen({ ...deps, win });
  const target = (win.top ?? win) as unknown as Record<string, unknown>;
  target['dlgopen'] = dlgopen;
  return dlgopen;
}

function sizeToCss(value: number | string): string {
  // Numbers are interpreted as px (matching the legacy callers'
  // intent: `top.dlgopen('...', '_blank', 800, 500)`); strings pass
  // through verbatim so '100%' / 'auto' / etc. work.
  return typeof value === 'number' ? `${String(value)}px` : value;
}
