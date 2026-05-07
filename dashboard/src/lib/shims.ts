/**
 * Cross-frame shims for legacy OpenEMR `top.*` and `left_nav.*` calls.
 *
 * The dashboard SPA replaces the legacy `main.php` knockout-driven
 * tab shell, but legacy iframes hosted inside the SPA still call up
 * to `top` as if the shell were the original. We install shims on
 * `window` at SPA boot so those calls are translated into our own
 * router/state changes. The full audit of the legacy contract is in
 * docs/dashboard-audit/02-dependency-map.md; T3.2 covers the `top.*`
 * subset, T3.3 the `left_nav.*` subset, T3.4 the `dlgopen` modal.
 *
 * Design: the shim depends on a `ShimRouter` adapter rather than on
 * a concrete router (TanStack Router lands in T2 + T5). Until then
 * the SPA can install an event-emitting stub adapter; the legacy
 * calls still translate into something observable.
 */

export interface ShimRouter {
  /** Navigate to the given patient. */
  navigateToPatient(pid: string): void;
  /** Clear patient context and return to the dashboard root. */
  navigateToDashboardRoot(): void;
}

/**
 * Shape of the parts of `window` that legacy iframes reach for via
 * `top.*`. Every method is required so callers see strongly-typed
 * compile errors when a shim signature drifts from the legacy
 * contract.
 */
export interface TopShims {
  /**
   * Pings /library/restoreSession.php to keep the PHP session alive
   * mid-iframe. Returns a promise that resolves on 2xx; legacy
   * callers tend to await it (or fire-and-forget).
   *
   * Declared `this: void` because legacy callers detach these
   * methods (e.g. assign `top.restoreSession` to a local variable)
   * and we don't depend on `this`.
   */
  restoreSession(this: void): Promise<void>;
  /**
   * Set the active patient by id. Legacy callers pass an integer or
   * a numeric string; we accept both and normalize.
   */
  set_pid(this: void, pid: number | string): void;
  /** Reset the active patient to none. */
  clearPatient(this: void): void;
}

/**
 * Globals that main_v2.php injects on `window` (see the JS globals
 * block in interface/main/tabs/main_v2.php). Legacy iframes read
 * these directly via `top.csrf_token_js`, etc. The SPA preserves
 * the shape so existing iframe code keeps working.
 */
export interface InjectedGlobals {
  csrf_token_js?: string;
  api_csrf_token_js?: string;
  webroot_url?: string;
  site_id_js?: string;
}

interface ShimDeps {
  router: ShimRouter;
  /** Window to install shims on; defaulted in the public installer. */
  win?: Window & typeof globalThis;
  /** fetch implementation; defaulted in the public installer. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the shim object without installing it. Exported so tests can
 * exercise each shim against a mock router and a mock fetch. Use
 * `installTopShims` for the real install.
 */
export function buildTopShims(deps: ShimDeps): TopShims {
  const router = deps.router;
  const win = deps.win ?? (globalThis as unknown as Window & typeof globalThis);

  // Arrow functions so the shims survive being detached
  // (e.g. `const f = top.set_pid; f(123)`). Legacy callers do
  // exactly that, and method-style `function` declarations would
  // bind `this` to the undefined detached call site.
  const restoreSession = async (): Promise<void> => {
    const webroot = readWebroot(win);
    // Resolve fetch lazily so a fake window without `fetch` (used
    // in tests for set_pid/clearPatient) doesn't crash on shim
    // construction.
    const fetchImpl = deps.fetchImpl ?? win.fetch.bind(win);
    // Cookies must ride along — restoreSession.php's whole job is
    // to refresh the session cookie's lifetime.
    const response = await fetchImpl(`${webroot}/library/restoreSession.php`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error(`restoreSession failed: HTTP ${response.status}`);
    }
  };

  const set_pid = (pid: number | string): void => {
    const normalized = typeof pid === 'number' ? String(pid) : pid;
    router.navigateToPatient(normalized);
  };

  const clearPatient = (): void => {
    router.navigateToDashboardRoot();
  };

  return { restoreSession, set_pid, clearPatient };
}

/**
 * Install `top.restoreSession`, `top.set_pid`, `top.clearPatient` on
 * the window's `top`. Legacy iframes reach for these via `top.*` so
 * we must install on the top-level window — which is the SPA when
 * we're hosted inside main_v2.php (per the migration doc, "our SPA
 * is `top`").
 */
export function installTopShims(deps: ShimDeps): TopShims {
  const win = deps.win ?? (globalThis as unknown as Window & typeof globalThis);
  const shims = buildTopShims({ ...deps, win });
  // Assigning onto `top` rather than `window` matches what the
  // legacy callers actually look up (`top.set_pid(...)`); in our
  // hosted-SPA setup top === window, but being explicit guards
  // against future hosting changes.
  const target = (win.top ?? win) as unknown as Record<string, unknown>;
  target['restoreSession'] = shims.restoreSession;
  target['set_pid'] = shims.set_pid;
  target['clearPatient'] = shims.clearPatient;
  return shims;
}

function readWebroot(win: Window & typeof globalThis): string {
  // main_v2.php injects `var webroot_url = "..."`. Default to "" so
  // a missing global resolves to relative URLs (which still hit the
  // OpenEMR origin) rather than crashing.
  const globals = win as unknown as InjectedGlobals;
  return globals.webroot_url ?? '';
}
