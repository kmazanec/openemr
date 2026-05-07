import { describe, expect, it, vi } from 'vitest';
import { createTabsStore, DASHBOARD_TAB_ID } from './tabsStore';
import { buildShimRouter, hydrateInitialTabs } from './bootShims';

interface FakeRouter {
  navigate: ReturnType<typeof vi.fn>;
}

function fakeRouter(): FakeRouter {
  return { navigate: vi.fn(() => Promise.resolve()) };
}

describe('buildShimRouter', () => {
  it('navigateToPatient opens the Patient Dashboard tab and routes to /patient/$pid', () => {
    const router = fakeRouter();
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    const shimRouter = buildShimRouter({ router: router, tabsStore: store });

    shimRouter.navigateToPatient('42');

    const state = store.getState();
    // Dashboard tab is inserted and becomes active; previously seeded
    // tabs (cal) are preserved.
    expect(state.tabs.map((t) => t.id)).toEqual([DASHBOARD_TAB_ID, 'cal']);
    expect(state.activeId).toBe(DASHBOARD_TAB_ID);
    expect(router.navigate).toHaveBeenCalledWith({ to: '/patient/$pid', params: { pid: '42' } });
  });

  it('navigateToDashboardRoot routes to /dashboard', () => {
    const router = fakeRouter();
    const store = createTabsStore();
    const shimRouter = buildShimRouter({ router: router, tabsStore: store });

    shimRouter.navigateToDashboardRoot();

    expect(router.navigate).toHaveBeenCalledWith({ to: '/dashboard' });
  });

  it('openLegacyTab pushes the URL into the tabs store and navigates the router', () => {
    const router = fakeRouter();
    const store = createTabsStore();
    const shimRouter = buildShimRouter({ router: router, tabsStore: store });

    shimRouter.openLegacyTab('cal', '/interface/main/calendar/index.php');

    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['cal']);
    expect(state.activeId).toBe('cal');
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/dashboard/legacy/$name',
      params: { name: 'cal' },
      search: { url: '/interface/main/calendar/index.php' },
    });
  });

  it('setEncounter does not throw (encounter routing lands later)', () => {
    const router = fakeRouter();
    const store = createTabsStore();
    const shimRouter = buildShimRouter({ router: router, tabsStore: store });

    expect(() => shimRouter.setEncounter('99', '2026-05-07', 'Test Visit')).not.toThrow();
  });

  it('clearEncounter does not throw', () => {
    const router = fakeRouter();
    const store = createTabsStore();
    const shimRouter = buildShimRouter({ router: router, tabsStore: store });

    expect(() => shimRouter.clearEncounter()).not.toThrow();
  });
});

describe('hydrateInitialTabs', () => {
  it('seeds the store from window.OE_DEFAULT_TABS, first entry active', () => {
    const store = createTabsStore();

    hydrateInitialTabs(store, [
      { id: 'cal', label: 'Calendar', url: '/interface/main/calendar/index.php' },
      { id: 'msg', label: 'Message Inbox', url: '/interface/main/messages/messages.php' },
    ]);

    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['cal', 'msg']);
    expect(state.tabs.map((t) => t.label)).toEqual(['Calendar', 'Message Inbox']);
    expect(state.activeId).toBe('cal');
  });

  it('no-ops on empty list', () => {
    const store = createTabsStore();
    hydrateInitialTabs(store, []);
    expect(store.getState().tabs).toEqual([]);
    expect(store.getState().activeId).toBeNull();
  });

  it('skips entries with empty id or url', () => {
    const store = createTabsStore();
    hydrateInitialTabs(store, [
      { id: '', label: 'No id', url: '/x' },
      { id: 'cal', label: 'Calendar', url: '/interface/main/calendar/index.php' },
      { id: 'msg', label: 'Message Inbox', url: '' },
    ]);
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['cal']);
    expect(state.activeId).toBe('cal');
  });
});
