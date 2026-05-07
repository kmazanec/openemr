import {
  installLeftNavShims,
  installTopShims,
  type ShimRouter,
} from './shims';
import { installDlgopen } from './dlgopen';
import type { TabsStore } from './tabsStore';

// The TanStack router type is generic over the registered route tree;
// we only need .navigate(). Capture that one method.
export interface NavigatingRouter {
  navigate: (opts: NavigateOpts) => Promise<void> | void;
}

type NavigateOpts =
  | { to: '/patient/$pid'; params: { pid: string } }
  | { to: '/dashboard' }
  | { to: '/dashboard/legacy/$name'; params: { name: string }; search?: { url: string } };

export interface ShimRouterDeps {
  router: NavigatingRouter;
  tabsStore: TabsStore;
}

// Build a ShimRouter that bridges legacy iframe callbacks to the
// SPA's TanStack router and the tabs store. Pure factory — install
// happens in installShims().
export function buildShimRouter({ router, tabsStore }: ShimRouterDeps): ShimRouter {
  return {
    navigateToPatient(pid) {
      void router.navigate({ to: '/patient/$pid', params: { pid } });
    },
    navigateToDashboardRoot() {
      void router.navigate({ to: '/dashboard' });
    },
    openLegacyTab(name, url) {
      // Update both the store (mounts/replaces the iframe) and the
      // URL (so the tab is deep-linkable and the user's history
      // tracks each tab switch).
      tabsStore.openLegacyTab(name, url);
      void router.navigate({
        to: '/dashboard/legacy/$name',
        params: { name },
        search: { url },
      });
    },
    setEncounter() {
      // Encounter routing lands when the SPA owns encounter state.
      // For now, swallow the call so legacy iframes calling
      // left_nav.setEncounter(...) don't crash the host.
    },
    clearEncounter() {
      // Same as above.
    },
  };
}

export interface InstallShimsDeps extends ShimRouterDeps {
  win?: Window & typeof globalThis;
}

// One-shot installer called from App boot. Wires top.*, left_nav.*,
// RTop, and top.dlgopen onto window.top.
export function installShims(deps: InstallShimsDeps): void {
  const shimRouter = buildShimRouter(deps);
  installTopShims({ router: shimRouter, win: deps.win });
  installLeftNavShims({ router: shimRouter, win: deps.win });
  installDlgopen({ win: deps.win });
}
