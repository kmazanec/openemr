import { useState, type ReactElement } from 'react';
import type { Bundle, BundleEntry, MedicationRequest } from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';
import { drugOf, doseOf } from './medicationFormat';
import { PrescriptionEditModal } from './PrescriptionEditModal';

export interface PrescriptionsCardProps {
  // FHIR Patient UUID; used to query MedicationRequest.
  pid: string;
  // Legacy integer pid; kept on the props so call-sites that already
  // resolve it (PatientRoute) don't have to change. We don't use it
  // for the in-page editor — the dashboard-editor module resolves
  // pid by puuid server-side.
  legacyPid?: string;
  fetchFn?: typeof fetch;
}

// Prescriptions (eRx-style records) maps to MedicationRequest with
// intent=order in OpenEMR's FHIR layer (sourced from the prescriptions
// table). Intent=plan covers the patient's currently-taking list,
// rendered by MedicationsCard.
export function PrescriptionsCard({
  pid,
  fetchFn,
}: PrescriptionsCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<MedicationRequest>>(
    `MedicationRequest?patient=${pid}&status=active&intent=order`,
  );
  const [adding, setAdding] = useState<boolean>(false);

  return (
    <>
      <Card
        title="Prescriptions"
        loading={loading && data === undefined}
        error={data === undefined ? error : null}
        onRetry={retry}
      >
        <PrescriptionsBody bundle={data} onAddClick={() => setAdding(true)} />
      </Card>
      {adding && (
        <PrescriptionEditModal
          puuid={pid}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            retry();
          }}
          {...(fetchFn !== undefined ? { fetchFn } : {})}
        />
      )}
    </>
  );
}

function PrescriptionsBody({
  bundle,
  onAddClick,
}: {
  bundle: Bundle<MedicationRequest> | undefined;
  onAddClick: () => void;
}): ReactElement {
  const rxs = (bundle?.entry ?? [])
    .map((e: BundleEntry<MedicationRequest>) => e.resource)
    .filter((r): r is MedicationRequest => r !== undefined);

  return (
    <>
      <div className="d-flex justify-content-end mb-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={onAddClick}
          data-testid="rx-add-button"
        >
          Add prescription
        </button>
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
                  <td>{filledOf(m)}</td>
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

function filledOf(m: MedicationRequest): string {
  const a = m.authoredOn;
  if (typeof a !== 'string' || a.length === 0) return '—';
  return a.slice(0, 10);
}
