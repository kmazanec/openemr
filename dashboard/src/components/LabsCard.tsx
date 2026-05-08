import type { ReactElement } from 'react';
import type {
  Bundle,
  BundleEntry,
  CodeableConcept,
  DiagnosticReport,
} from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';

const VIEW_ALL_HREF = '/interface/orders/orders_results.php';

export interface LabsCardProps {
  pid: string;
}

// Lab results map to DiagnosticReport in OpenEMR's FHIR layer.
// Sourced from procedure_report + procedure_result. Each report
// represents one ordered panel; individual analytes live as
// referenced Observations under .result, which we surface in a
// follow-up story (would N+1 today).
//
// _sort=-date and _count=10 mirror the legacy "recent labs" pattern.
export function LabsCard({ pid }: LabsCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<DiagnosticReport>>(
    `DiagnosticReport?patient=${pid}&category=LAB&_sort=-date&_count=10`,
  );

  return (
    <Card
      title="Lab Results"
      viewAllHref={VIEW_ALL_HREF}
      loading={loading && data === undefined}
      error={data === undefined ? error : null}
      onRetry={retry}
    >
      <LabsBody bundle={data} />
    </Card>
  );
}

function LabsBody({ bundle }: { bundle: Bundle<DiagnosticReport> | undefined }): ReactElement {
  const reports = (bundle?.entry ?? [])
    .map((e: BundleEntry<DiagnosticReport>) => e.resource)
    .filter((r): r is DiagnosticReport => r !== undefined);

  return (
    <div className="table-responsive">
      <table className="table table-sm mb-0">
        <thead>
          <tr className="text-body-secondary">
            <th scope="col">Date</th>
            <th scope="col">Test</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {reports.length === 0 ? (
            <tr>
              <td colSpan={3} className="text-muted small">
                Nothing Recorded
                <span className="visually-hidden"> (No lab results.)</span>
              </td>
            </tr>
          ) : (
            reports.map((r) => (
              <tr key={r.id ?? Math.random().toString(36)}>
                <td>{dateOf(r)}</td>
                <td>{labelOf(r.code)}</td>
                <td>{r.status ?? '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function dateOf(r: DiagnosticReport): string {
  const d = r.effectiveDateTime ?? r.issued;
  if (typeof d !== 'string' || d.length === 0) return '—';
  return d.slice(0, 10);
}

function labelOf(code: CodeableConcept | undefined): string {
  if (code === undefined) return '—';
  if (typeof code.text === 'string' && code.text.length > 0) return code.text;
  const display = code.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '—';
}
