import { useEffect, type ReactElement } from 'react';
import { useParams } from '@tanstack/react-router';
import { RequireFhirSession } from '../lib/RequireFhirSession';
import { PatientHeader } from '../components/PatientHeader';
import { AllergiesCard } from '../components/AllergiesCard';
import { ProblemListCard } from '../components/ProblemListCard';
import { MedicationsCard } from '../components/MedicationsCard';
import { PrescriptionsCard } from '../components/PrescriptionsCard';
import { CareTeamCard } from '../components/CareTeamCard';
import { EncountersCard } from '../components/EncountersCard';
import { AppShell } from '../components/AppShell';
import { appTabsStore } from '../lib/tabsStore';

export function PatientRoute(): ReactElement {
  const { pid } = useParams({ from: '/patient/$pid' });
  // Direct navigation to /patient/$pid (e.g. via top.set_pid coming
  // from the legacy iframe, or a future bookmark) opens the Patient
  // Dashboard tab and activates it. The shim layer also calls this
  // path; doing it here too keeps the contract local to the route.
  useEffect(() => {
    appTabsStore().openDashboardTab();
  }, [pid]);
  // The AppShell stays outside the FHIR-session gate so the tab strip
  // and any open legacy iframes (Calendar, Message Inbox) remain
  // visible while the patient cards' FHIR client is still hydrating.
  // Only the patient summary itself is auth-gated.
  return (
    <AppShell
      dashboardBody={
        <RequireFhirSession>
          <PatientSummary pid={pid} />
        </RequireFhirSession>
      }
    />
  );
}

function PatientSummary({ pid }: { pid: string }): ReactElement {
  return (
    <div className="p-3">
      <PatientHeader pid={pid} />
      <div className="row mt-3">
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
