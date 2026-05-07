import type { ReactElement } from 'react';
import { useParams } from '@tanstack/react-router';
import { RequireFhirSession } from '../lib/RequireFhirSession';
import { PatientHeader } from '../components/PatientHeader';
import { AllergiesCard } from '../components/AllergiesCard';
import { ProblemListCard } from '../components/ProblemListCard';
import { MedicationsCard } from '../components/MedicationsCard';
import { PrescriptionsCard } from '../components/PrescriptionsCard';
import { CareTeamCard } from '../components/CareTeamCard';
import { EncountersCard } from '../components/EncountersCard';
import { TabStrip } from '../components/TabStrip';
import { LegacyIframeTab } from '../components/LegacyIframeTab';
import { useTabs } from '../lib/useTabs';
import { DASHBOARD_TAB_ID } from '../lib/tabsStore';

export function PatientRoute(): ReactElement {
  const { pid } = useParams({ from: '/patient/$pid' });
  return (
    <RequireFhirSession>
      <PatientShell pid={pid} />
    </RequireFhirSession>
  );
}

function PatientShell({ pid }: { pid: string }): ReactElement {
  const tabs = useTabs();
  return (
    <div className="patient-shell">
      <PatientHeader pid={pid} />
      <TabStrip />
      <div className="tab-content p-3">
        <DashboardPane pid={pid} active={tabs.activeId === DASHBOARD_TAB_ID} />
        {tabs.tabs
          .filter((t) => t.id !== DASHBOARD_TAB_ID)
          .map((t) => (
            <LegacyIframeTab
              key={t.id}
              name={t.id}
              url={'url' in t ? t.url : ''}
              active={tabs.activeId === t.id}
            />
          ))}
      </div>
    </div>
  );
}

function DashboardPane({ pid, active }: { pid: string; active: boolean }): ReactElement {
  return (
    <div hidden={!active} data-testid="dashboard-pane">
      <div className="row">
        <div className="col-12 col-lg-4">
          <AllergiesCard pid={pid} />
          <PrescriptionsCard pid={pid} />
        </div>
        <div className="col-12 col-lg-4">
          <ProblemListCard pid={pid} />
          <CareTeamCard pid={pid} />
        </div>
        <div className="col-12 col-lg-4">
          <MedicationsCard pid={pid} />
          <EncountersCard pid={pid} />
        </div>
      </div>
    </div>
  );
}
