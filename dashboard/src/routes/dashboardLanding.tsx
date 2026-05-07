import { useEffect, type ReactElement } from 'react';
import { AppShell } from '../components/AppShell';
import { appTabsStore } from '../lib/tabsStore';

// Empty-state landing. Two entry conditions:
//   1. The user opened /dashboard explicitly — surface the Patient
//      Dashboard tab so the empty-state pane is visible.
//   2. The SPA booted at / with no seeded tabs — same: show the
//      empty-state pane.
// If seeded tabs exist (Calendar, Message Inbox), they win the
// active slot; we don't barge in with a Dashboard tab.
export function DashboardLanding(): ReactElement {
  useEffect(() => {
    const store = appTabsStore();
    const tabs = store.getState().tabs;
    if (tabs.length === 0) {
      store.openDashboardTab();
    }
  }, []);

  return (
    <AppShell
      dashboardBody={
        <div className="p-3">
          <h1 className="h3">Patient Dashboard</h1>
          <p className="text-muted mb-0">No patient selected. Open a patient from the menu.</p>
        </div>
      }
    />
  );
}
