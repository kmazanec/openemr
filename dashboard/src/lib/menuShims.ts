// Bridge from the legacy parent-menu Knockout dispatch into our
// SPA tabs store. The original `interface/main/tabs/js/tabs_view_model.js`
// module exposes `menuActionClick(data, evt)` and `navigateTab(url,
// name, cb, label)` as `window`-level globals. Knockout's
// `data-bind="click: menuActionClick"` (in menu_template.html.twig)
// fires `menuActionClick` for every leaf-level menu item.
//
// In the v2 shell the legacy `tabs_view_model.js` still loads (because
// other parts of main_v2.php still depend on its app_view_model), so
// `menuActionClick`/`navigateTab` are there — but `navigateTab`
// pushes to a Knockout `tabsList` that nothing renders. Result: the
// menu fires but nothing happens visibly.
//
// Two surfaces we replace here:
//   1. `window.navigateTab` — every menu leaf eventually calls this.
//      Shim it to call `appTabsStore.openLegacyTab(name, url, label)`
//      and to invoke the `afterLoadFunction` synchronously so the
//      original code path (which ends with `activateTabByName(target,
//      true)`) keeps activating the tab.
//   2. `window.activateTabByName` — the after-load callback. Maps to
//      our store's `setActive(id)`. The `hideOthers` second arg is a
//      no-op (legacy frames-display semantic; our store only tracks
//      one active tab anyway).
//
// We deliberately do NOT touch `window.menuActionClick`. It runs the
// requirement check (e.g. "must select a patient first"), the `pop`
// branch (which calls our `dlgopen` shim — already wired), and the
// `load_form.php` encounter-form fixup. Leaving that intact keeps the
// patient-required + encounter-required UX working and routes the
// final navigation through the shimmed `navigateTab`.

import type { TabsStore } from './tabsStore';

export interface MenuShimDeps {
  tabsStore: TabsStore;
  win?: Window & typeof globalThis;
  /**
   * Optional label resolver. The legacy `navigateTab(url, name, cb,
   * loadingLabel)` signature passes a "Loading X" string as the
   * fourth argument (e.g. "Loading Calendar"); we extract the menu
   * item's display text from it so the tab strip shows "Calendar"
   * rather than the iframe target id. Override for tests.
   */
  resolveLabel?: (loadingLabel: string, name: string) => string;
}

// "Loading Calendar" → "Calendar". The legacy code prefixes
// `xl("Loading") + " "` before the menu label; we strip that prefix
// when present so the tab name is just the noun. When the label has
// no whitespace (e.g. "Loading" by itself, or a single-word locale
// translation), fall back to the iframe target name instead of
// surfacing a confusing "Loading"-only label.
function defaultResolveLabel(loadingLabel: string, name: string): string {
  if (typeof loadingLabel !== 'string' || loadingLabel === '') return name;
  const wsIdx = loadingLabel.indexOf(' ');
  if (wsIdx === -1) return name;
  const stripped = loadingLabel.slice(wsIdx + 1).trim();
  return stripped !== '' ? stripped : name;
}

// The legacy navigateTab shape: (url, name, afterLoadFunction?, loadingLabel?).
// We accept anything callable and validate the bits we use.
export type NavigateTabFn = (
  url: string,
  name: string,
  afterLoadFunction?: () => void,
  loadingLabel?: string,
) => void;

export type ActivateTabByNameFn = (name: string, hideOthers?: boolean) => void;

interface MenuShimWindow {
  navigateTab?: NavigateTabFn;
  activateTabByName?: ActivateTabByNameFn;
}

/**
 * Build the shimmed `navigateTab` and `activateTabByName` functions
 * without installing them. Exported for unit tests; the public
 * installer below performs the install.
 */
export function buildMenuShims(deps: MenuShimDeps): {
  navigateTab: NavigateTabFn;
  activateTabByName: ActivateTabByNameFn;
} {
  const { tabsStore } = deps;
  const resolveLabel = deps.resolveLabel ?? defaultResolveLabel;

  const navigateTab: NavigateTabFn = (url, name, afterLoadFunction, loadingLabel) => {
    if (typeof url !== 'string' || url === '' || typeof name !== 'string' || name === '') {
      return;
    }
    const label = resolveLabel(loadingLabel ?? '', name);
    tabsStore.openLegacyTab(name, url, label);
    // The legacy after-load callback fires once the iframe's `load`
    // event resolves. We don't have a great signal for that here;
    // calling it synchronously matches the "tab opened" semantic and
    // keeps any caller that uses it to call `activateTabByName`
    // working — the iframe is already mounted at this point because
    // `openLegacyTab` synchronously pushes onto the strip and React
    // renders within the same microtask.
    if (typeof afterLoadFunction === 'function') {
      try {
        afterLoadFunction();
      } catch {
        // Swallow — a busted callback shouldn't break menu navigation.
      }
    }
  };

  const activateTabByName: ActivateTabByNameFn = (name) => {
    if (typeof name !== 'string' || name === '') return;
    tabsStore.setActive(name);
  };

  return { navigateTab, activateTabByName };
}

/**
 * Install the shimmed `navigateTab` and `activateTabByName` on
 * `window.top` so the legacy menu dispatch (and any other legacy
 * caller — encounter form refresh, tab refresh icons, etc.) lands in
 * our SPA tabs store rather than the orphan Knockout `tabsList`.
 *
 * Replaces any existing globals; the legacy `tabs_view_model.js`
 * defines them with `function …`, which sets a configurable property
 * on the global object — overwriting that is well-defined.
 */
export function installMenuShims(deps: MenuShimDeps): void {
  const win = deps.win ?? (globalThis as unknown as Window & typeof globalThis);
  const target = (win.top ?? win) as unknown as MenuShimWindow;
  const { navigateTab, activateTabByName } = buildMenuShims({ ...deps, win });
  target.navigateTab = navigateTab;
  target.activateTabByName = activateTabByName;
}
