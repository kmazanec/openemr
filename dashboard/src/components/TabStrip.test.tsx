import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTabsStore, DASHBOARD_TAB_ID } from '../lib/tabsStore';
import { TabStrip } from './TabStrip';

describe('TabStrip', () => {
  it('renders nothing when there are no tabs (no patient, no seeded tabs)', () => {
    const store = createTabsStore();
    render(<TabStrip store={store} />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('renders a legacy tab with its label when one is opened', () => {
    const store = createTabsStore();
    act(() => {
      store.openLegacyTab('cal', '/interface/main/calendar/index.php', 'Calendar');
    });

    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: /Calendar/ })).toBeInTheDocument();
  });

  it('renders the Patient Dashboard tab once a patient is opened', () => {
    const store = createTabsStore();
    act(() => {
      store.openLegacyTab('cal', '/cal', 'Calendar');
      store.openDashboardTab();
    });
    render(<TabStrip store={store} />);

    const dashTab = screen.getByRole('tab', { name: /Patient Dashboard/ });
    expect(dashTab.getAttribute('aria-selected')).toBe('true');
  });

  it('switching tabs updates the store activeId', () => {
    const store = createTabsStore();
    act(() => {
      store.openLegacyTab('cal', '/cal', 'Calendar');
      store.openDashboardTab();
    });
    render(<TabStrip store={store} />);

    const calTab = screen.getByRole('tab', { name: /Calendar/ });
    act(() => {
      calTab.click();
    });

    expect(store.getState().activeId).toBe('cal');
  });

  it('closes a legacy tab when its ✕ button is clicked', () => {
    const store = createTabsStore();
    act(() => {
      store.openLegacyTab('cal', '/cal', 'Calendar');
    });
    render(<TabStrip store={store} />);

    const closeBtn = screen.getByRole('button', { name: /Close Calendar/ });
    act(() => {
      closeBtn.click();
    });

    expect(store.getState().tabs.map((t) => t.id)).not.toContain('cal');
  });

  it('the Patient Dashboard tab is closable too (mirrors legacy: every tab gets an ✕)', () => {
    const store = createTabsStore();
    act(() => {
      store.openDashboardTab();
    });
    render(<TabStrip store={store} />);

    expect(
      screen.getByRole('button', { name: /Close Patient Dashboard/ }),
    ).toBeInTheDocument();
  });

  it('does not cap the number of open tabs', () => {
    const store = createTabsStore();
    act(() => {
      for (let i = 0; i < 8; i++) {
        store.openLegacyTab(`tab${i}`, `/tab${i}`, `Tab ${i}`);
      }
      store.openDashboardTab();
    });
    render(<TabStrip store={store} />);

    expect(screen.getAllByRole('tab').length).toBe(9);
  });

  it('clicking the Patient Dashboard tab activates it via the store', () => {
    const store = createTabsStore();
    act(() => {
      store.openLegacyTab('cal', '/cal', 'Calendar');
      store.openDashboardTab();
    });
    render(<TabStrip store={store} />);

    act(() => {
      screen.getByRole('tab', { name: /Calendar/ }).click();
    });
    expect(store.getState().activeId).toBe('cal');

    act(() => {
      screen.getByRole('tab', { name: /Patient Dashboard/ }).click();
    });
    expect(store.getState().activeId).toBe(DASHBOARD_TAB_ID);
  });
});
