import { useEffect, type ReactElement } from 'react';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routes/routeTree';
import { hydrateInitialTabs, installShims, type InitialTab } from './lib/bootShims';
import { appTabsStore } from './lib/tabsStore';
import { getLaunchPid } from './lib/fhir';

// main_v2.php emits window.OE_DEFAULT_TABS — the SPA's source of
// truth for the user's seeded tab strip (Calendar, Message Inbox,
// …). Same data the legacy main.php would have rendered into its
// Knockout tabsList; we just consume it on this side instead.
//
// __OE_DASHBOARD_TABS__ exposes the singleton tabs store for
// debugging and Playwright assertions. Hosted iframes shouldn't
// reach for it; they use the shim layer (top.left_nav.*, top.set_pid,
// etc.).
declare global {
  interface Window {
    OE_DEFAULT_TABS?: InitialTab[];
    __OE_DASHBOARD_TABS__?: ReturnType<typeof appTabsStore>;
  }
}

// The SPA mounts inside main_v2.php at /interface/main/tabs/main_v2.php
// — that path is owned by the PHP shell, not the SPA. Using the
// browser's URL as the router source would mean the router sees
// "/interface/main/tabs/main_v2.php?token_main=..." and can't match
// any of our routes ("/", "/patient/$pid", etc.).
//
// In-memory history sidesteps the URL entirely: the router starts
// at "/" (DashboardLanding) and navigations from shims (set_pid,
// loadFrame) update an internal stack rather than the browser bar.
// The browser's URL stays at main_v2.php?token_main=..., which is
// what the legacy session check expects.
//
// Exception: when the SPA is loaded *as the OAuth callback target*
// (Apache rewrites /dashboard/auth/callback → dashboard/dist/index.html
// per T1.6), we want the in-memory router to start at /auth/callback
// so AuthCallbackRoute fires. fhirclient reads ?code=&state= from
// the real window.location.search, so the URL bar staying at
// /dashboard/auth/callback is fine.
function pickInitialEntry(): string {
  if (typeof window === 'undefined') return '/';
  if (window.location.pathname.endsWith('/auth/callback')) return '/auth/callback';
  // Hash-routed entry — used by E2E tests and any future deep-links
  // (e.g. an external link to a patient summary). The browser URL
  // bar stays at main_v2.php; the in-memory router picks up the
  // intended route from the hash. Format: `#/copilot/42`,
  // `#/patient/42`, etc.
  const hash = window.location.hash;
  if (hash.startsWith('#/')) {
    return hash.slice(1);
  }
  return '/';
}

const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: [pickInitialEntry()] }),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App(): ReactElement {
  useEffect(() => {
    const store = appTabsStore();
    // Install legacy `top.*`, `left_nav.*`, `RTop`, and `top.dlgopen`
    // shims once the SPA mounts. Hosted iframes (calendar, encounter
    // forms, patient finder, etc.) call up to these on every page,
    // so they must be in place before any iframe loads.
    installShims({ router, tabsStore: store });
    // Seed the tab strip from main_v2.php's default_open_tabs list.
    // First entry (typically Calendar) becomes the active tab so the
    // shell mirrors the legacy SPA's first-paint behavior.
    if (store.getState().tabs.length === 0) {
      hydrateInitialTabs(store, window.OE_DEFAULT_TABS ?? []);
    }
    window.__OE_DASHBOARD_TABS__ = store;
    // If sessionStorage carries a launch pid (set by authorize() and
    // surviving the OAuth round-trip), the user was viewing a patient
    // before the redirect. Restore the dashboard tab + patient route
    // so the post-redirect page lands them right back where they
    // were, without requiring a second set_pid call from the iframe.
    //
    // Skip when we're on /auth/callback — that route's component owns
    // the post-OAuth redirect to main_v2_resume.php; navigating away
    // here would short-circuit it.
    const onAuthCallback =
      typeof window !== 'undefined' &&
      window.location.pathname.endsWith('/auth/callback');
    const launchPid = getLaunchPid();
    if (!onAuthCallback && launchPid !== null && launchPid !== '') {
      store.openDashboardTab();
      store.setActive('__dashboard');
      void router.navigate({ to: '/patient/$pid', params: { pid: launchPid } });
    }
  }, []);

  return <RouterProvider router={router} />;
}
