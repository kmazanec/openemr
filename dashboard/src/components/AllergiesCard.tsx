import type { ReactElement } from 'react';
import type { AllergyIntolerance, Bundle, BundleEntry } from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';

const VIEW_ALL_HREF = '/interface/patient_file/summary/stats_full.php?category=allergy';

export interface AllergiesCardProps {
  pid: string;
}

export function AllergiesCard({ pid }: AllergiesCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<AllergyIntolerance>>(
    `AllergyIntolerance?patient=${pid}&clinical-status=active`,
  );

  return (
    <Card
      title="Allergies"
      viewAllHref={VIEW_ALL_HREF}
      loading={loading && data === undefined}
      error={data === undefined ? error : null}
      onRetry={retry}
    >
      <AllergiesBody bundle={data} />
    </Card>
  );
}

function AllergiesBody({ bundle }: { bundle: Bundle<AllergyIntolerance> | undefined }): ReactElement {
  const entries = bundle?.entry ?? [];
  const allergies = entries
    .map((e: BundleEntry<AllergyIntolerance>) => e.resource)
    .filter((r): r is AllergyIntolerance => r !== undefined);

  if (allergies.length === 0) {
    return <p className="text-muted mb-0">No known active allergies.</p>;
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
          </tr>
        </thead>
        <tbody>
          {allergies.map((a) => (
            <tr key={a.id ?? Math.random().toString(36)}>
              <td>{allergenOf(a)}</td>
              <td>{severityOf(a)}</td>
              <td>{reactionOf(a)}</td>
              <td>{verificationOf(a)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
