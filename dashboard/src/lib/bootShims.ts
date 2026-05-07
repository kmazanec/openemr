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
      // Picking a patient (e.g. via the legacy Finder iframe calling
      // top.set_pid or left_nav.setPatient) surfaces the Patient
      // Dashboard tab and switches to it. Mirrors the legacy shell's
      // behavior of opening the patient summary on patient pick, but
      // leaves the previously seeded tabs (Calendar, Message Inbox,
      // …) intact so the user can flip back.
      tabsStore.openDashboardTab();
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

// Shape main_v2.php emits as window.OE_DEFAULT_TABS.
export interface InitialTab {
  id: string;
  label: string;
  url: string;
}

// Seed the tabs store from main_v2.php's window.OE_DEFAULT_TABS.
// First valid entry becomes the active tab (typical case: Calendar).
// No-ops on an empty/missing list.
export function hydrateInitialTabs(
  tabsStore: TabsStore,
  initialTabs: ReadonlyArray<InitialTab>,
): void {
  let firstId: string | null = null;
  for (const tab of initialTabs) {
    if (tab.id.length === 0 || tab.url.length === 0) continue;
    tabsStore.openLegacyTab(tab.id, tab.url, tab.label);
    if (firstId === null) firstId = tab.id;
  }
  if (firstId !== null) tabsStore.setActive(firstId);
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
