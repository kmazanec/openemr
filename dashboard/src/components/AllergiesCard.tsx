import { useState, type ReactElement } from 'react';
import type { AllergyIntolerance, Bundle, BundleEntry } from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';
import { AllergyEditModal } from './AllergyEditModal';

export interface AllergiesCardProps {
  pid: string;
  // Test-only override forwarded to the modal so a Vitest case can
  // drive the editor without a live PHP endpoint.
  fetchFn?: typeof fetch;
}

export function AllergiesCard({ pid, fetchFn }: AllergiesCardProps): ReactElement {
  // The FHIR layer doesn't register `clinical-status` as a search
  // parameter for AllergyIntolerance — passing it makes the search
  // throw a SearchFieldException and the bundle comes back empty
  // (silently). We fetch unfiltered and narrow to active rows below
  // so promoted entries (which the agent writes with no enddate)
  // surface alongside legacy ones.
  const { data, error, loading, retry } = useFhirRequest<Bundle<AllergyIntolerance>>(
    `AllergyIntolerance?patient=${pid}`,
  );
  const [editing, setEditing] = useState<AllergyIntolerance | null>(null);
  const [adding, setAdding] = useState<boolean>(false);
  const open = adding || editing !== null;

  return (
    <>
      <Card
        title="Allergies"
        editLabel="Add allergy"
        onEditClick={() => setAdding(true)}
        loading={loading && data === undefined}
        error={data === undefined ? error : null}
        onRetry={retry}
      >
        <AllergiesBody bundle={data} onEdit={(a) => setEditing(a)} />
      </Card>
      {open && (
        <AllergyEditModal
          puuid={pid}
          allergy={editing}
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

function AllergiesBody({
  bundle,
  onEdit,
}: {
  bundle: Bundle<AllergyIntolerance> | undefined;
  onEdit: (a: AllergyIntolerance) => void;
}): ReactElement {
  const entries = bundle?.entry ?? [];
  const allergies = entries
    .map((e: BundleEntry<AllergyIntolerance>) => e.resource)
    .filter((r): r is AllergyIntolerance => r !== undefined)
    .filter((a) => isActiveAllergy(a));

  if (allergies.length === 0) {
    return (
      <p className="text-muted mb-0 small">
        Nothing Recorded
        <span className="visually-hidden"> (No known active allergies.)</span>
      </p>
    );
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm table-borderless mb-0">
        <thead>
          <tr>
            <th scope="col">Allergen</th>
            <th scope="col">Severity</th>
            <th scope="col">Reaction</th>
            <th scope="col">Status</th>
            <th scope="col" className="text-end" aria-label="Edit" />
          </tr>
        </thead>
        <tbody>
          {allergies.map((a) => (
            <tr key={a.id ?? Math.random().toString(36)}>
              <td>{allergenOf(a)}</td>
              <td>{severityOf(a)}</td>
              <td>{reactionOf(a)}</td>
              <td>{verificationOf(a)}</td>
              <td className="text-end">
                <button
                  type="button"
                  className="btn btn-sm btn-link p-0"
                  onClick={() => onEdit(a)}
                  data-testid="allergy-row-edit"
                  aria-label={`Edit ${allergenOf(a)}`}
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

function isActiveAllergy(a: AllergyIntolerance): boolean {
  // The FHIR mapper sets clinicalStatus.code = 'active' when the
  // underlying lists row has no enddate. Resolved/inactive rows are
  // still useful in some surfaces, but the dashboard card mirrors
  // the legacy "Allergies" panel which shows active only.
  const code = a.clinicalStatus?.coding?.[0]?.code;
  return code === undefined || code === 'active';
}

function allergenOf(a: AllergyIntolerance): string {
  if (typeof a.code?.text === 'string' && a.code.text.length > 0) return a.code.text;
  const display = a.code?.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '—';
}

function severityOf(a: AllergyIntolerance): string {
  return a.criticality ?? '—';
}

function reactionOf(a: AllergyIntolerance): string {
  const first = a.reaction?.[0];
  if (first === undefined) return '—';
  const m = first.manifestation?.[0];
  if (m === undefined) return '—';
  if (typeof m.text === 'string' && m.text.length > 0) return m.text;
  const display = m.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '—';
}

function verificationOf(a: AllergyIntolerance): string {
  const code = a.verificationStatus?.coding?.[0]?.code;
  return code ?? '—';
}
