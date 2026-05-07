import type { ReactElement } from 'react';
import type {
  Bundle,
  BundleEntry,
  CareTeam,
  CareTeamParticipant,
} from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';

export interface CareTeamCardProps {
  pid: string;
}

// Uses _include=CareTeam:participant to resolve practitioner displays
// in a single round-trip when the FHIR server supports it. Falls back
// to whatever member.display the server already returned otherwise.
export function CareTeamCard({ pid }: CareTeamCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<CareTeam>>(
    `CareTeam?patient=${pid}&status=active&_include=CareTeam:participant`,
  );

  return (
    <Card
      title="Care Team"
      loading={loading && data === undefined}
      error={data === undefined ? error : null}
      onRetry={retry}
    >
      <CareTeamBody bundle={data} />
    </Card>
  );
}

function CareTeamBody({ bundle }: { bundle: Bundle<CareTeam> | undefined }): ReactElement {
  const teams = (bundle?.entry ?? [])
    .map((e: BundleEntry<CareTeam>) => e.resource)
    .filter((r): r is CareTeam => r !== undefined && r.resourceType === 'CareTeam');

  const participants = teams.flatMap((t) => t.participant ?? []);

  if (participants.length === 0) {
    return <p className="text-muted mb-0">No active care team.</p>;
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm table-borderless mb-0">
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {participants.map((p, idx) => (
            <tr key={p.member?.reference ?? `p-${idx}`}>
              <td>{memberOf(p)}</td>
              <td>{roleOf(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function memberOf(p: CareTeamParticipant): string {
  const display = p.member?.display;
  if (typeof display === 'string' && display.length > 0) return display;
  const ref = p.member?.reference;
  if (typeof ref === 'string' && ref.length > 0) return ref;
  return '—';
}

function roleOf(p: CareTeamParticipant): string {
  const first = p.role?.[0];
  if (first === undefined) return '—';
  const display = first.coding?.find((c) => typeof c.display === 'string')?.display;
  if (display !== undefined) return display;
  if (typeof first.text === 'string' && first.text.length > 0) return first.text;
  return '—';
}
