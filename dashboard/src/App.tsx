import { useEffect, type ReactElement } from 'react';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routes/routeTree';
import { installShims } from './lib/bootShims';
import { appTabsStore } from './lib/tabsStore';

const router = createRouter({ routeTree });

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
