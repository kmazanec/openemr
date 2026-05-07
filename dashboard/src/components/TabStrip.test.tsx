import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTabsStore, DASHBOARD_TAB_ID } from '../lib/tabsStore';
import { TabStrip } from './TabStrip';

describe('TabStrip', () => {
  it('renders the dashboard tab as active when no legacy tabs are open', () => {
    const store = createTabsStore();
    render(<TabStrip store={store} />);

    const dashboardTab = screen.getByRole('tab', { name: /Dashboard/ });
    expect(dashboardTab.getAttribute('aria-selected')).toBe('true');
  });

  it('renders a legacy tab with its label when one is opened', () => {
    const store = createTabsStore();
    act(() => {
      store.openLegacyTab('cal', '/interface/main/calendar/index.php', 'Calendar');
    });

    render(<TabStrip store={store} />);

    expect(screen.getByRole('tab', { name: /Calendar/ })).toBeInTheDocument();
  });

  it('switching to a legacy tab updates the store activeId', () => {
    const store = createTabsStore();
    act(() => {
      store.openLegacyTab('cal', '/cal', 'Calendar');
    });
    render(<TabStrip store={store} />);

    const dashboardTab = screen.getByRole('tab', { name: /Dashboard/ });
    act(() => {
      dashboardTab.click();
    });

    expect(store.getState().activeId).toBe(DASHBOARD_TAB_ID);
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

  it('the dashboard tab does not render a close button', () => {
    const store = createTabsStore();
    render(<TabStrip store={store} />);

    expect(screen.queryByRole('button', { name: /Close Dashboard/ })).not.toBeInTheDocument();
  });

  it('does not cap the number of open tabs', () => {
    const store = createTabsStore();
    act(() => {
      for (let i = 0; i < 8; i++) {
        store.openLegacyTab(`tab${i}`, `/tab${i}`, `Tab ${i}`);
      }
    });
    render(<TabStrip store={store} />);

    // Dashboard + 8 legacy tabs.
    expect(screen.getAllByRole('tab').length).toBe(9);
  });
});
