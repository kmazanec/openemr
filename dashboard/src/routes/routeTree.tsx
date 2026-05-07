import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { LoginRoute } from './login';
import { AuthCallbackRoute } from './authCallback';
import { DashboardLanding } from './dashboardLanding';
import { PatientRoute } from './patient';
import { LegacyTabRoute } from './legacyTab';

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

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  authCallbackRoute,
  dashboardRoute,
  patientRoute,
  legacyTabRoute,
]);
