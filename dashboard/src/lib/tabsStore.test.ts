import { describe, expect, it } from 'vitest';
import { createTabsStore, DASHBOARD_TAB_ID, type LegacyTab } from './tabsStore';

describe('tabsStore', () => {
  it('starts empty — Dashboard tab is added only when a patient is opened', () => {
    const store = createTabsStore();
    const state = store.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeId).toBeNull();
  });

  it('openLegacyTab adds a tab and activates it', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/interface/main/calendar/index.php');
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['cal']);
    expect(state.activeId).toBe('cal');
    expect(state.tabs[0]).toMatchObject({
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

    expect(secondState.tabs).toHaveLength(1);
    expect(secondTab?.url).toBe('/interface/main/calendar/index.php?date=2026-05-07');
    expect(secondTab?.id).toBe(firstTab?.id);
  });

  it('openDashboardTab inserts the Dashboard tab at position 0 and activates it', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.openLegacyTab('msg', '/msg');
    store.openDashboardTab();
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual([DASHBOARD_TAB_ID, 'cal', 'msg']);
    expect(state.activeId).toBe(DASHBOARD_TAB_ID);
  });

  it('openDashboardTab on an already-open Dashboard tab just activates it', () => {
    const store = createTabsStore();
    store.openDashboardTab();
    store.openLegacyTab('cal', '/cal'); // active becomes cal
    store.openDashboardTab();
    expect(store.getState().tabs.filter((t) => t.id === DASHBOARD_TAB_ID)).toHaveLength(1);
    expect(store.getState().activeId).toBe(DASHBOARD_TAB_ID);
  });

  it('setActive switches the active tab', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.openLegacyTab('msg', '/msg');
    store.setActive('cal');
    expect(store.getState().activeId).toBe('cal');
  });

  it('closeTab removes a tab and activates the previous one', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.openLegacyTab('msg', '/msg');
    // active is now 'msg'
    store.closeTab('msg');
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['cal']);
    expect(state.activeId).toBe('cal');
  });

  it('closeTab on the dashboard tab removes it (no patient implies no dashboard)', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.openDashboardTab();
    store.closeTab(DASHBOARD_TAB_ID);
    const state = store.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['cal']);
    expect(state.activeId).toBe('cal');
  });

  it('closing the last remaining tab clears the active id', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.closeTab('cal');
    expect(store.getState().tabs).toEqual([]);
    expect(store.getState().activeId).toBeNull();
  });

  it('closing a non-active tab leaves the active tab alone', () => {
    const store = createTabsStore();
    store.openLegacyTab('cal', '/cal');
    store.openLegacyTab('msg', '/msg');
    // active is 'msg'; close 'cal'
    store.closeTab('cal');
    const state = store.getState();
    expect(state.activeId).toBe('msg');
    expect(state.tabs.map((t) => t.id)).toEqual(['msg']);
  });

  it('subscribe fires on every state change and returns an unsubscribe', () => {
    const store = createTabsStore();
    let count = 0;
    const unsubscribe = store.subscribe(() => {
      count += 1;
    });
    store.openLegacyTab('cal', '/cal');
    store.openDashboardTab();
    expect(count).toBe(2);
    unsubscribe();
    store.openLegacyTab('msg', '/msg');
    expect(count).toBe(2);
  });
});
