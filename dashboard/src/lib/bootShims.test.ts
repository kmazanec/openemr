import { describe, expect, it, vi } from 'vitest';
import { createTabsStore, DASHBOARD_TAB_ID } from './tabsStore';
import { buildShimRouter } from './bootShims';

interface FakeRouter {
  navigate: ReturnType<typeof vi.fn>;
}

function fakeRouter(): FakeRouter {
  return { navigate: vi.fn(() => Promise.resolve()) };
}

describe('buildShimRouter', () => {
  it('navigateToPatient routes to /patient/$pid', () => {
    const router = fakeRouter();
    const store = createTabsStore();
    const shimRouter = buildShimRouter({ router: router, tabsStore: store });

    shimRouter.navigateToPatient('42');

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
    expect(state.tabs.map((t) => t.id)).toEqual([DASHBOARD_TAB_ID, 'cal']);
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
