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
  /**
   * Open a legacy URL in a tab named `name`. T5 implements the tab
   * strip; until then a stub adapter just emits the navigation as a
   * window-level event so anything observing can react.
   */
  openLegacyTab(name: string, url: string): void;
  /** Set the active encounter for the current patient. */
  setEncounter(eid: string, date?: string, frname?: string): void;
  /** Clear encounter context (patient stays active). */
  clearEncounter(): void;
}

/**
 * Shape of the legacy `left_nav.*` surface — see audit
 * 02-dependency-map.md §3 for the full enumeration. Methods
 * annotated with `this: void` so detached references stay safe
 * (legacy callers do this often).
 */
export interface LeftNavShims {
  setPatient(this: void, name: string, pid: number | string, pubpid?: string, frname?: string, dob?: string): void;
  setEncounter(this: void, date: string, eid: number | string, frname?: string): void;
  setPatientEncounter(
    this: void,
    encounterIds: ReadonlyArray<number | string>,
    encounterDates: readonly string[],
    calendarCategories: readonly string[],
  ): void;
  clearEncounter(this: void): void;
  /** No-op: the legacy left-nav option list isn't part of our SPA. */
  removeOptionSelected(this: void, eid: number | string): void;
  loadFrame(this: void, id: string, name: string, url: string): void;
  /** Alternate signature kept for compatibility; same behavior as loadFrame. */
  loadFrame2(this: void, id: string, name: string, url: string): void;
  /** No-op: the legacy left-nav radio sync isn't part of our SPA. */
  syncRadios(this: void): void;
}

/**
 * Subset of the legacy `RTop.*` surface. The legacy contract is a
 * JavaScript setter property: callers do `top.RTop.location = url`,
 * which triggers `set location(url)` (defined in
 * interface/main/tabs/js/frame_proxies.js). We mirror that exact
 * shape — a `location` setter — so iframe code that drives patient
 * picks (notably interface/main/finder/dynamic_finder.php line 326,
 * `top.RTop.location = "../../patient_file/summary/demographics.php?set_pid=..."`)
 * lands the user on our SPA's Patient Dashboard tab.
 *
 * `setLocation(url)` is kept as a method-style alias for any caller
 * (tests, future code) that prefers a function call over assignment.
 */
export interface RTopShims {
  setLocation(this: void, url: string): void;
  location: string;
}

/**
 * Shape of the parts of `window` that legacy iframes reach for via
 * `top.*`. Every method is required so callers see strongly-typed
 * compile errors when a shim signature drifts from the legacy
 * contract.
 *
 * `restoreSession` is intentionally NOT in this interface even
 * though every legacy iframe calls `top.restoreSession()` before
 * each AJAX request: that function is **already provided** by
 * main_v2.php through the inlined `library/restoreSession.php`
 * which OEGlobalsBag's `restore_sessions` global enables by
 * default. Its job is to rewrite `document.cookie` back to *this
 * tab's* PHP-assigned session id whenever another tab in the same
 * browser has overwritten it (a fresh login mints a new session id
 * and clobbers the shared cookie). Replacing it with our own shim
 * — which an earlier version of this file did, mistakenly thinking
 * it was an HTTP-endpoint ping — broke parallel-login support: the
 * SPA's tab couldn't reclaim the cookie when a second tab logged
 * in, and every subsequent request landed on the *other* tab's
 * session, often producing "Site ID is missing from session data!".
 * The installer below leaves `top.restoreSession` alone if it
 * already exists.
 */
export interface TopShims {
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

  // Arrow functions so the shims survive being detached
  // (e.g. `const f = top.set_pid; f(123)`). Legacy callers do
  // exactly that, and method-style `function` declarations would
  // bind `this` to the undefined detached call site.

  const set_pid = (pid: number | string): void => {
    const normalized = typeof pid === 'number' ? String(pid) : pid;
    router.navigateToPatient(normalized);
  };

  const clearPatient = (): void => {
    router.navigateToDashboardRoot();
  };

  return { set_pid, clearPatient };
}

/**
 * Install `top.set_pid` and `top.clearPatient` on the window's
 * `top`. Legacy iframes reach for these via `top.*` so we must
 * install on the top-level window — which is the SPA when we're
 * hosted inside main_v2.php (per the migration doc, "our SPA is
 * `top`").
 *
 * `top.restoreSession` is left alone. main_v2.php inlines a real
 * implementation from `library/restoreSession.php` that rewrites
 * `document.cookie` back to this tab's session id when a parallel
 * login in another tab has clobbered it. We MUST NOT replace that
 * function — doing so silently breaks parallel-login support and
 * surfaces as "Site ID is missing from session data!" 400s on the
 * tab whose cookie got overwritten. As a defensive fallback for
 * test/standalone hosts where main_v2.php's restoreSession.php
 * wasn't inlined, we install a no-op only when nothing else has
 * already defined the function.
 */
export function installTopShims(deps: ShimDeps): TopShims {
  const win = deps.win ?? (globalThis as unknown as Window & typeof globalThis);
  const shims = buildTopShims({ ...deps, win });
  // Assigning onto `top` rather than `window` matches what the
  // legacy callers actually look up (`top.set_pid(...)`); in our
  // hosted-SPA setup top === window, but being explicit guards
  // against future hosting changes.
  const target = (win.top ?? win) as unknown as Record<string, unknown>;
  target['set_pid'] = shims.set_pid;
  target['clearPatient'] = shims.clearPatient;
  if (typeof target['restoreSession'] !== 'function') {
    // Standalone/test host without main_v2.php's inlined real
    // restoreSession — fall back to a no-op so callers that fire-
    // and-forget `top.restoreSession()` don't crash. Production
    // hosts skip this branch and keep the genuine function intact.
    target['restoreSession'] = (): true => true;
  }
  return shims;
}

interface LeftNavDeps {
  router: ShimRouter;
  win?: Window & typeof globalThis;
}

/**
 * Build the `left_nav.*` shims without installing. Uses the same
 * ShimRouter adapter as buildTopShims so a single router
 * implementation drives both surfaces.
 */
export function buildLeftNavShims(deps: LeftNavDeps): LeftNavShims {
  const router = deps.router;

  const setPatient: LeftNavShims['setPatient'] = (
    _name,
    pid,
    _pubpid,
    _frname,
    _dob,
  ) => {
    const normalized = typeof pid === 'number' ? String(pid) : pid;
    router.navigateToPatient(normalized);
  };

  const setEncounter: LeftNavShims['setEncounter'] = (date, eid, frname) => {
    const normalized = typeof eid === 'number' ? String(eid) : eid;
    router.setEncounter(normalized, date, frname);
  };

  const setPatientEncounter: LeftNavShims['setPatientEncounter'] = (
    encounterIds,
    encounterDates,
    _calendarCategories,
  ) => {
    // Legacy callers pass parallel arrays, where index 0 is the
    // most-recent encounter to surface. Forward only that one — the
    // legacy left-nav rendered all of them as an option list, which
    // we do not.
    if (encounterIds.length === 0) {
      return;
    }
    const eid = encounterIds[0];
    const date = encounterDates[0];
    if (eid === undefined) {
      return;
    }
    const normalized = typeof eid === 'number' ? String(eid) : eid;
    router.setEncounter(normalized, date);
  };

  const clearEncounter: LeftNavShims['clearEncounter'] = () => {
    router.clearEncounter();
  };

  const removeOptionSelected: LeftNavShims['removeOptionSelected'] = () => {
    // No-op: the option list this referred to lived in the legacy
    // left-nav frame, which we don't render.
  };

  const loadFrame: LeftNavShims['loadFrame'] = (_id, name, url) => {
    router.openLegacyTab(name, url);
  };

  const loadFrame2: LeftNavShims['loadFrame2'] = (id, name, url) => {
    // The legacy alternate signature carried different scroll/sizing
    // metadata; we only need the URL + name, so loadFrame2 is loadFrame.
    loadFrame(id, name, url);
  };

  const syncRadios: LeftNavShims['syncRadios'] = () => {
    // No-op: tied to the legacy left-nav radio inputs.
  };

  return {
    setPatient,
    setEncounter,
    setPatientEncounter,
    clearEncounter,
    removeOptionSelected,
    loadFrame,
    loadFrame2,
    syncRadios,
  };
}

/**
 * Extracts the `set_pid` query param from a legacy demographics URL
 * (e.g. "../../patient_file/summary/demographics.php?set_pid=42").
 * Returns the pid as a string, or null if the URL has no set_pid.
 *
 * Exported for tests; not part of the runtime shim install.
 */
export function extractSetPid(url: string): string | null {
  // The legacy URLs are relative (../../patient_file/...) which the
  // URL constructor can't parse without a base. Use a synthetic
  // base; we only care about the query string.
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://x.invalid/');
  } catch {
    return null;
  }
  const pid = parsed.searchParams.get('set_pid');
  if (pid === null || pid === '') return null;
  return pid;
}

/** Build the `RTop.setLocation` + `RTop.location` setter shim. */
export function buildRTopShims(deps: LeftNavDeps): RTopShims {
  const router = deps.router;

  // Shared handler: route a URL update either to a patient pick
  // (when the URL carries set_pid=, as the patient finder emits)
  // or to a legacy tab (the generic case the legacy RTop setter
  // targeted under the "pat" iframe name).
  const handleLocation = (url: string): void => {
    const pid = extractSetPid(url);
    if (pid !== null) {
      router.navigateToPatient(pid);
      return;
    }
    router.openLegacyTab('pat', url);
  };

  const setLocation: RTopShims['setLocation'] = (url) => handleLocation(url);

  // Backing field for the location setter — read-back returns the
  // last-assigned URL, which is what legacy callers may inspect.
  let lastLocation = '';
  const shims: RTopShims = {
    setLocation,
    get location() {
      return lastLocation;
    },
    set location(url: string) {
      lastLocation = url;
      handleLocation(url);
    },
  };
  return shims;
}

/**
 * Install the left_nav and RTop shims on the target window. Legacy
 * code looks up `left_nav.setPatient(...)` and `RTop.setLocation(...)`
 * at the top frame, so we expose them as window globals (matching
 * how the legacy bundle assigned them).
 */
export function installLeftNavShims(deps: LeftNavDeps): {
  leftNav: LeftNavShims;
  RTop: RTopShims;
} {
  const win = deps.win ?? (globalThis as unknown as Window & typeof globalThis);
  const leftNav = buildLeftNavShims({ ...deps, win });
  const RTop = buildRTopShims({ ...deps, win });
  const target = (win.top ?? win) as unknown as Record<string, unknown>;
  target['left_nav'] = leftNav;
  target['RTop'] = RTop;
  return { leftNav, RTop };
}
