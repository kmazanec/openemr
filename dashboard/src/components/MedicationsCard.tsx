import type { ReactElement } from 'react';
import type { Bundle, BundleEntry, MedicationRequest } from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';
import { doseOf, drugOf, frequencyOf, routeOf } from './medicationFormat';

const VIEW_ALL_HREF = '/interface/patient_file/summary/stats_full.php?category=medication';

export interface MedicationsCardProps {
  pid: string;
}

// Medications (the patient's currently-taking list) maps to MedicationRequest
// with intent=plan in OpenEMR's FHIR layer (sourced from lists_medication).
// Intent=order is reserved for the eRx prescriptions list, which the
// PrescriptionsCard renders.
export function MedicationsCard({ pid }: MedicationsCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<MedicationRequest>>(
    `MedicationRequest?patient=${pid}&status=active&intent=plan`,
  );

  return (
    <Card
      title="Medications"
      viewAllHref={VIEW_ALL_HREF}
      loading={loading && data === undefined}
      error={data === undefined ? error : null}
      onRetry={retry}
    >
      <MedicationsBody bundle={data} />
    </Card>
  );
}

function MedicationsBody({
  bundle,
}: {
  bundle: Bundle<MedicationRequest> | undefined;
}): ReactElement {
  const meds = (bundle?.entry ?? [])
    .map((e: BundleEntry<MedicationRequest>) => e.resource)
    .filter((r): r is MedicationRequest => r !== undefined);

  if (meds.length === 0) {
    return (
      <p className="text-muted mb-0 small">
        Nothing Recorded
        <span className="visually-hidden"> (No active medications.)</span>
      </p>
    );
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm table-borderless mb-0">
        <thead>
          <tr>
            <th scope="col">Drug</th>
            <th scope="col">Dose</th>
            <th scope="col">Route</th>
            <th scope="col">Frequency</th>
          </tr>
        </thead>
        <tbody>
          {meds.map((m) => (
            <tr key={m.id ?? Math.random().toString(36)}>
              <td>{drugOf(m)}</td>
              <td>{doseOf(m)}</td>
              <td>{routeOf(m)}</td>
              <td>{frequencyOf(m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
