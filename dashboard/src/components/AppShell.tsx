import type { ReactElement, ReactNode } from 'react';
import {
  appTabsStore,
  COPILOT_TAB_ID,
  DASHBOARD_TAB_ID,
  type LegacyTab,
} from '../lib/tabsStore';
import { useTabs } from '../lib/useTabs';
import { TabStrip } from './TabStrip';
import { LegacyIframeTab } from './LegacyIframeTab';

export interface AppShellProps {
  // Body of the Dashboard tab — typically the patient summary
  // (cards) when a patient is active, or the empty-state placeholder
  // when no patient is selected. The shell keeps every tab's body
  // mounted at all times (hidden when inactive), so this child
  // re-renders only when the route's pid actually changes.
  dashboardBody: ReactNode;
  // Body of the Co-Pilot tab — the React-native chat panel. Optional
  // because not every route hosts the Co-Pilot (the no-patient
  // landing page, for example).
  copilotBody?: ReactNode;
  // Optional persistent header rendered above the tab strip — the
  // patient identity bar lives here, mirroring the legacy layout
  // where patient context sits above all per-tab navigation.
  patientHeader?: ReactNode;
}

// Renders the persistent SPA chrome: optional patient header, tab
// strip, then a stack of tab panes that stay mounted across tab
// switches. Legacy iframes preserve their state (form contents,
// scroll position) when the user flips back. The Dashboard pane's
// content is supplied by the active route via the `dashboardBody`
// prop. The Co-Pilot pane (a SPA-native chat panel) is supplied
// similarly via `copilotBody`.
export function AppShell({
  dashboardBody,
  copilotBody,
  patientHeader,
}: AppShellProps): ReactElement {
  const store = appTabsStore();
  const state = useTabs(store);
  const activeId = state.activeId;
  const dashboardOpen = state.tabs.some((t) => t.id === DASHBOARD_TAB_ID);
  const copilotOpen = state.tabs.some((t) => t.id === COPILOT_TAB_ID);

  return (
    <div
      className="patient-shell d-flex flex-column"
      style={{ position: 'absolute', inset: 0 }}
    >
      {patientHeader}
      <TabStrip store={store} />
      <div
        className="tab-content position-relative"
        style={{ flex: '1 1 auto', minHeight: 0 }}
      >
        {dashboardOpen && (
          <div
            hidden={activeId !== DASHBOARD_TAB_ID}
            data-testid="dashboard-pane"
            style={{ position: 'absolute', inset: 0, overflow: 'auto' }}
          >
            {dashboardBody}
          </div>
        )}
        {copilotOpen && copilotBody !== undefined && (
          <div
            hidden={activeId !== COPILOT_TAB_ID}
            data-testid="copilot-pane"
            style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
          >
            {copilotBody}
          </div>
        )}
        {state.tabs
          .filter(
            (t): t is LegacyTab => t.id !== DASHBOARD_TAB_ID && t.id !== COPILOT_TAB_ID,
          )
          .map((t) => (
            <LegacyIframeTab
              key={t.id}
              name={t.id}
              url={t.url}
              active={activeId === t.id}
            />
          ))}
      </div>
    </div>
  );
}
