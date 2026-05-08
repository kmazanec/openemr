// Tiny external store for the SPA's tab strip. Subscribes via
// useSyncExternalStore (see lib/useTabs.ts). Lives outside React so
// the shim layer (lib/shims.ts) can drive it from legacy iframe
// callbacks without going through hooks.
//
// The Dashboard tab (our SPA-rendered patient summary) is *not*
// always present. Mirrors legacy behavior: when no patient is
// selected, the user sees only the seeded tabs (Calendar, Message
// Inbox, …) from $session['default_open_tabs']. The Dashboard tab is
// inserted on demand the first time a patient is opened (top.set_pid
// or PatientRoute mount).

export const DASHBOARD_TAB_ID = '__dashboard';
export const COPILOT_TAB_ID = '__copilot';

export interface DashboardTab {
  id: typeof DASHBOARD_TAB_ID;
  label: 'Patient Dashboard';
}

// SPA-native Clinical Co-Pilot tab — renders <CopilotPanel> rather
// than an iframe. Distinct from the dashboard tab so the doctor can
// keep both open and toggle between them without re-mounting either.
export interface CopilotTab {
  id: typeof COPILOT_TAB_ID;
  label: 'Clinical Co-Pilot';
}

export interface LegacyTab {
  id: string;
  label: string;
  url: string;
}

export type Tab = DashboardTab | CopilotTab | LegacyTab;

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export interface TabsStore {
  getState(): TabsState;
  subscribe(listener: () => void): () => void;
  openLegacyTab(name: string, url: string, label?: string): void;
  openDashboardTab(): void;
  openCopilotTab(): void;
  setActive(id: string): void;
  closeTab(id: string): void;
}

const DASHBOARD_TAB: DashboardTab = { id: DASHBOARD_TAB_ID, label: 'Patient Dashboard' };
const COPILOT_TAB: CopilotTab = { id: COPILOT_TAB_ID, label: 'Clinical Co-Pilot' };

export function createTabsStore(): TabsStore {
  let state: TabsState = {
    tabs: [],
    activeId: null,
  };
  const listeners = new Set<() => void>();

  const setState = (next: TabsState): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    openLegacyTab(name, url, label) {
      const existing = state.tabs.find(
        (t): t is LegacyTab =>
          t.id !== DASHBOARD_TAB_ID && t.id !== COPILOT_TAB_ID && t.id === name,
      );
      if (existing !== undefined) {
        // Same name re-loaded with a (possibly) new URL: navigate the
        // existing iframe rather than rebuilding it. Object identity
        // stays stable, so React reuses the same iframe DOM node.
        const updated = state.tabs.map((t): Tab => {
          if (t.id === name && t.id !== DASHBOARD_TAB_ID && t.id !== COPILOT_TAB_ID) {
            return { ...t, url };
          }
          return t;
        });
        setState({ tabs: updated, activeId: name });
        return;
      }
      const tab: LegacyTab = { id: name, label: label ?? name, url };
      setState({
        tabs: [...state.tabs, tab],
        activeId: name,
      });
    },

    openDashboardTab() {
      const existing = state.tabs.find((t) => t.id === DASHBOARD_TAB_ID);
      if (existing !== undefined) {
        setState({ ...state, activeId: DASHBOARD_TAB_ID });
        return;
      }
      setState({
        tabs: [DASHBOARD_TAB, ...state.tabs],
        activeId: DASHBOARD_TAB_ID,
      });
    },

    openCopilotTab() {
      const existing = state.tabs.find((t) => t.id === COPILOT_TAB_ID);
      if (existing !== undefined) {
        setState({ ...state, activeId: COPILOT_TAB_ID });
        return;
      }
      // Insert immediately after the dashboard tab so the chat UI sits
      // next to the chart summary in the strip; falls to position 0 if
      // the dashboard tab isn't open yet.
      const dashIdx = state.tabs.findIndex((t) => t.id === DASHBOARD_TAB_ID);
      const insertAt = dashIdx === -1 ? 0 : dashIdx + 1;
      const tabs = [
        ...state.tabs.slice(0, insertAt),
        COPILOT_TAB,
        ...state.tabs.slice(insertAt),
      ];
      setState({ tabs, activeId: COPILOT_TAB_ID });
    },

    setActive(id) {
      if (state.tabs.some((t) => t.id === id)) {
        setState({ ...state, activeId: id });
      }
    },

    closeTab(id) {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const remaining = state.tabs.filter((t) => t.id !== id);
      let nextActive = state.activeId;
      if (state.activeId === id) {
        // Activate the previous tab when the active one is closed; if
        // we just closed the last tab, no tab is active.
        const fallback = remaining[idx - 1] ?? remaining[0] ?? null;
        nextActive = fallback === null ? null : fallback.id;
      }
      setState({ tabs: remaining, activeId: nextActive });
    },
  };
}

// Application-level singleton. Tests construct their own via
// createTabsStore() to stay isolated.
let appStore: TabsStore | null = null;

export function appTabsStore(): TabsStore {
  if (appStore === null) {
    appStore = createTabsStore();
  }
  return appStore;
}

// Test-only: reset the singleton between cases.
export function _resetAppTabsStoreForTests(): void {
  appStore = null;
}
