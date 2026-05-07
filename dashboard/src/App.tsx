import { useEffect, type ReactElement } from 'react';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routes/routeTree';
import { installShims } from './lib/bootShims';
import { appTabsStore } from './lib/tabsStore';

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
    // Install legacy `top.*`, `left_nav.*`, `RTop`, and `top.dlgopen`
    // shims once the SPA mounts. Hosted iframes (calendar, encounter
    // forms, patient finder, etc.) call up to these on every page,
    // so they must be in place before any iframe loads.
    installShims({ router, tabsStore: appTabsStore() });
  }, []);

  return <RouterProvider router={router} />;
}
