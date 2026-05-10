import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { LoginRoute } from './login';
import { AuthCallbackRoute } from './authCallback';
import { DashboardLanding } from './dashboardLanding';
import { PatientRoute } from './patient';
import { LegacyTabRoute } from './legacyTab';
import { CopilotStandaloneRoute } from './copilot';
import { EditSandboxRoute } from './editSandbox';

const rootRoute = createRootRoute({
  component: function Root(): ReactElement {
    return <Outlet />;
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardLanding,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginRoute,
});

const authCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: AuthCallbackRoute,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: DashboardLanding,
});

const patientRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/patient/$pid',
  component: PatientRoute,
});

const legacyTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard/legacy/$name',
  component: LegacyTabRoute,
  validateSearch: (search: Record<string, unknown>): { url?: string } => {
    const raw = search['url'];
    return typeof raw === 'string' ? { url: raw } : {};
  },
});

const copilotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/copilot/$pid',
  component: CopilotStandaloneRoute,
});

// Dev-only sandbox route for the in-page edit modals. Registered
// only when `import.meta.env.DEV` is true so Playwright can drive
// the modals without a FHIR session. In production the route is
// not registered; users who navigate to `/edit-sandbox` see the
// landing page. (The sandbox component itself stays in the prod
// bundle since Rollup retains imports referenced in any branch.)
const editSandboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/edit-sandbox',
  component: EditSandboxRoute,
});

const baseRoutes = [
  indexRoute,
  loginRoute,
  authCallbackRoute,
  dashboardRoute,
  patientRoute,
  legacyTabRoute,
  copilotRoute,
];

export const routeTree = rootRoute.addChildren(
  import.meta.env.DEV ? [...baseRoutes, editSandboxRoute] : baseRoutes,
);
