import type { ReactElement } from 'react';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routes/routeTree';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App(): ReactElement {
  return <RouterProvider router={router} />;
}
