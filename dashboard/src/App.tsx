import { useEffect, type ReactElement } from 'react';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routes/routeTree';
import { hydrateInitialTabs, installShims, type InitialTab } from './lib/bootShims';
import { appTabsStore } from './lib/tabsStore';

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
// Trade-off: deep links into a specific patient/legacy tab via the
// browser address bar don't work (you'd need a real basepath +
// Apache rewrite for that — out of scope until T6.5/deploy).
// Bookmarking is still a future work item.
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/'] }),
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
  }, []);

  return <RouterProvider router={router} />;
}
