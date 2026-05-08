import type { ReactElement } from 'react';
import type { Bundle, BundleEntry, MedicationRequest } from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';
import { isErxEnabled } from '../lib/config';
import { drugOf, doseOf } from './medicationFormat';

export interface PrescriptionsCardProps {
  pid: string;
}

// Prescriptions (eRx-style records) maps to MedicationRequest with
// intent=order in OpenEMR's FHIR layer (sourced from the prescriptions
// table). Intent=plan covers the patient's currently-taking list,
// rendered by MedicationsCard.
export function PrescriptionsCard({ pid }: PrescriptionsCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<MedicationRequest>>(
    `MedicationRequest?patient=${pid}&status=active&intent=order`,
  );

  return (
    <Card
      title="Prescriptions"
      loading={loading && data === undefined}
      error={data === undefined ? error : null}
      onRetry={retry}
    >
      <PrescriptionsBody pid={pid} bundle={data} />
    </Card>
  );
}

function PrescriptionsBody({
  pid,
  bundle,
}: {
  pid: string;
  bundle: Bundle<MedicationRequest> | undefined;
}): ReactElement {
  const rxs = (bundle?.entry ?? [])
    .map((e: BundleEntry<MedicationRequest>) => e.resource)
    .filter((r): r is MedicationRequest => r !== undefined);

  return (
    <>
      <div className="d-flex justify-content-end mb-2">
        <a
          className="btn btn-sm btn-outline-secondary"
          href={addPrescriptionHref(pid)}
        >
          Add prescription
        </a>
      </div>
      {rxs.length === 0 ? (
        <p className="text-muted mb-0 small">
          Nothing Recorded
          <span className="visually-hidden"> (No active prescriptions.)</span>
        </p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm mb-0">
            <thead>
              <tr className="text-body-secondary">
                <th scope="col">Drug</th>
                <th scope="col">Details</th>
                <th scope="col">Qty</th>
                <th scope="col">Refills</th>
                <th scope="col">Filled</th>
              </tr>
            </thead>
            <tbody>
              {rxs.map((m) => (
                <tr key={m.id ?? Math.random().toString(36)}>
                  <td>{drugOf(m)}</td>
                  <td>{doseOf(m)}</td>
                  <td>{quantityOf(m)}</td>
                  <td>{refillsOf(m)}</td>
                  <td>{m.authoredOn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function quantityOf(m: MedicationRequest): string {
  const q = m.dispenseRequest?.quantity;
  if (q === undefined) return '—';
  if (typeof q.value !== 'number') return '—';
  const unit = typeof q.unit === 'string' && q.unit.length > 0 ? ` ${q.unit}` : '';
  return `${q.value}${unit}`;
}

function refillsOf(m: MedicationRequest): string {
  const r = m.dispenseRequest?.numberOfRepeatsAllowed;
  if (typeof r !== 'number') return '—';
  return String(r);
}

function addPrescriptionHref(pid: string): string {
  if (isErxEnabled()) {
    return `/interface/eRx.php?page=compose&pid=${encodeURIComponent(pid)}`;
  }
  return `/interface/patient_file/summary/demographics/controller.php?prescription&list&id=${encodeURIComponent(pid)}`;
}
