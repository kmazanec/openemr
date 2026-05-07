import { describe, expect, it } from 'vitest';
import { createTabsStore, DASHBOARD_TAB_ID, type LegacyTab } from './tabsStore';

describe('tabsStore', () => {
  it('starts with only the dashboard tab, active', () => {
    const store = createTabsStore();
    const state = store.getState();
    expect(state.tabs).toEqual([{ id: DASHBOARD_TAB_ID, label: 'Dashboard' }]);
    expect(state.activeId).toBe(DASHBOARD_TAB_ID);
  });

  it('openLegacyTab adds a tab and activates it', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/interface/main/calendar/index.php');
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual([DASHBOARD_TAB_ID, 'cal']);
    expect(state.activeId).toBe('cal');
    expect(state.tabs[1]).toMatchObject({
      id: 'cal',
      url: '/interface/main/calendar/index.php',
    });
  });

  it('openLegacyTab with the same name navigates the existing iframe rather than rebuilding', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/interface/main/calendar/index.php');
    const firstState = store.getState();
    const firstTab = firstState.tabs.find((t): t is LegacyTab => t.id === 'cal');

    store.openLegacyTab('cal', '/interface/main/calendar/index.php?date=2026-05-07');
    const secondState = store.getState();
    const secondTab = secondState.tabs.find((t): t is LegacyTab => t.id === 'cal');

    expect(secondState.tabs).toHaveLength(2); // still just dashboard + cal
    expect(secondTab?.url).toBe('/interface/main/calendar/index.php?date=2026-05-07');
    // The tab object's identity is preserved (same id) — the iframe
    // stays mounted across the URL change.
    expect(secondTab?.id).toBe(firstTab?.id);
  });

  it('setActive switches the active tab', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.setActive(DASHBOARD_TAB_ID);
    expect(store.getState().activeId).toBe(DASHBOARD_TAB_ID);
  });

  it('closeTab removes a tab and activates the next available', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.openLegacyTab('msg', '/msg');
    // activeId is now 'msg'
    store.closeTab('msg');
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual([DASHBOARD_TAB_ID, 'cal']);
    // Closing the active tab activates the previous tab.
    expect(state.activeId).toBe('cal');
  });

  it('closeTab on the dashboard tab is a no-op', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.closeTab(DASHBOARD_TAB_ID);
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toContain(DASHBOARD_TAB_ID);
  });

  it('closing the only legacy tab activates the dashboard tab', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.closeTab('cal');
    expect(store.getState().activeId).toBe(DASHBOARD_TAB_ID);
  });

  it('closing a non-active tab leaves the active tab alone', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.openLegacyTab('msg', '/msg');
    // active is 'msg'; close 'cal'
    store.closeTab('cal');
    const state = store.getState();
    expect(state.activeId).toBe('msg');
    expect(state.tabs.map((t) => t.id)).toEqual([DASHBOARD_TAB_ID, 'msg']);
  });

  it('subscribe fires on every state change and returns an unsubscribe', () => {
    const store = createTabsStore();
    let count = 0;
    const unsubscribe = store.subscribe(() => {
      count += 1;
    });
    store.openLegacyTab('cal', '/cal');
    store.setActive(DASHBOARD_TAB_ID);
    expect(count).toBe(2);
    unsubscribe();
    store.openLegacyTab('msg', '/msg');
    expect(count).toBe(2);
  });
});
