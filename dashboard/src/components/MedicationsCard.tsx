import { useState, type ReactElement } from 'react';
import type { Bundle, BundleEntry, MedicationRequest } from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';
import { doseOf, drugOf, frequencyOf, routeOf } from './medicationFormat';
import { MedicationEditModal } from './MedicationEditModal';

export interface MedicationsCardProps {
  pid: string;
  fetchFn?: typeof fetch;
}

// Medications (the patient's currently-taking list) maps to MedicationRequest
// with intent=plan in OpenEMR's FHIR layer (sourced from lists_medication).
// Intent=order is reserved for the eRx prescriptions list, which the
// PrescriptionsCard renders.
export function MedicationsCard({ pid, fetchFn }: MedicationsCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<MedicationRequest>>(
    `MedicationRequest?patient=${pid}&status=active&intent=plan`,
  );
  const [editing, setEditing] = useState<MedicationRequest | null>(null);
  const [adding, setAdding] = useState<boolean>(false);
  const open = adding || editing !== null;

  return (
    <>
      <Card
        title="Medications"
        editLabel="Add medication"
        onEditClick={() => setAdding(true)}
        loading={loading && data === undefined}
        error={data === undefined ? error : null}
        onRetry={retry}
      >
        <MedicationsBody bundle={data} onEdit={(m) => setEditing(m)} />
      </Card>
      {open && (
        <MedicationEditModal
          puuid={pid}
          medication={editing}
          onClose={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSaved={() => {
            setEditing(null);
            setAdding(false);
            retry();
          }}
          {...(fetchFn !== undefined ? { fetchFn } : {})}
        />
      )}
    </>
  );
}

function MedicationsBody({
  bundle,
  onEdit,
}: {
  bundle: Bundle<MedicationRequest> | undefined;
  onEdit: (m: MedicationRequest) => void;
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
            <th scope="col" className="text-end" aria-label="Edit" />
          </tr>
        </thead>
        <tbody>
          {meds.map((m) => (
            <tr key={m.id ?? Math.random().toString(36)}>
              <td>{drugOf(m)}</td>
              <td>{doseOf(m)}</td>
              <td>{routeOf(m)}</td>
              <td>{frequencyOf(m)}</td>
              <td className="text-end">
                <button
                  type="button"
                  className="btn btn-sm btn-link p-0"
                  onClick={() => onEdit(m)}
                  data-testid="medication-row-edit"
                  aria-label={`Edit ${drugOf(m)}`}
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
