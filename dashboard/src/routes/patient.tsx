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

export function PatientRoute(): ReactElement {
  const { pid } = useParams({ from: '/patient/$pid' });
  return (
    <RequireFhirSession>
      <PatientDashboard pid={pid} />
    </RequireFhirSession>
  );
}

function PatientDashboard({ pid }: { pid: string }): ReactElement {
  return (
    <div className="patient-dashboard p-3">
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
