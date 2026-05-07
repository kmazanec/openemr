import type { ReactElement } from 'react';
import type { Bundle, BundleEntry, Condition } from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';

const ICD10_SYS = 'http://hl7.org/fhir/sid/icd-10-cm';
const SNOMED_SYS = 'http://snomed.info/sct';
const VIEW_ALL_HREF = '/interface/patient_file/summary/stats_full.php?category=medical_problem';

export interface ProblemListCardProps {
  pid: string;
}

export function ProblemListCard({ pid }: ProblemListCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<Condition>>(
    `Condition?patient=${pid}&category=problem-list-item`,
  );

  return (
    <Card
      title="Medical Problems"
      viewAllHref={VIEW_ALL_HREF}
      loading={loading && data === undefined}
      error={data === undefined ? error : null}
      onRetry={retry}
    >
      <ProblemsBody bundle={data} />
    </Card>
  );
}

function ProblemsBody({ bundle }: { bundle: Bundle<Condition> | undefined }): ReactElement {
  const conditions = (bundle?.entry ?? [])
    .map((e: BundleEntry<Condition>) => e.resource)
    .filter((r): r is Condition => r !== undefined)
    .filter((c) => isActive(c));

  if (conditions.length === 0) {
    return <p className="text-muted mb-0">No active problems.</p>;
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm table-borderless mb-0">
        <thead>
          <tr>
            <th scope="col">Problem</th>
            <th scope="col">Code</th>
            <th scope="col">Onset</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {conditions.map((c) => (
            <tr key={c.id ?? Math.random().toString(36)}>
              <td>{titleOf(c)}</td>
              <td>{codeOf(c)}</td>
              <td>{c.onsetDateTime ?? '—'}</td>
              <td>
                <span className="badge bg-success-subtle text-success-emphasis">active</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isActive(c: Condition): boolean {
  const code = c.clinicalStatus?.coding?.[0]?.code;
  // active, recurrence, relapse all count as currently-relevant problems.
  return code === 'active' || code === 'recurrence' || code === 'relapse' || code === undefined;
}

function titleOf(c: Condition): string {
  const codings = c.code?.coding ?? [];
  const snomed = codings.find((cc) => cc.system === SNOMED_SYS && typeof cc.display === 'string');
  if (snomed?.display !== undefined) return snomed.display;
  const icd = codings.find((cc) => cc.system === ICD10_SYS && typeof cc.display === 'string');
  if (icd?.display !== undefined) return icd.display;
  if (typeof c.code?.text === 'string' && c.code.text.length > 0) return c.code.text;
  return '—';
}

function codeOf(c: Condition): string {
  const codings = c.code?.coding ?? [];
  const snomed = codings.find((cc) => cc.system === SNOMED_SYS && typeof cc.code === 'string');
  if (snomed?.code !== undefined) return `SNOMED ${snomed.code}`;
  const icd = codings.find((cc) => cc.system === ICD10_SYS && typeof cc.code === 'string');
  if (icd?.code !== undefined) return `ICD-10 ${icd.code}`;
  return '—';
}
