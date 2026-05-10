import { useState, type ReactElement } from 'react';
import type {
  Bundle,
  BundleEntry,
  CareTeam,
  CareTeamParticipant,
} from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';
import { CareTeamEditModal } from './CareTeamEditModal';

export interface CareTeamCardProps {
  pid: string;
  fetchFn?: typeof fetch;
}

// Uses _include=CareTeam:participant to resolve practitioner displays
// in a single round-trip when the FHIR server supports it. Falls back
// to whatever member.display the server already returned otherwise.
export function CareTeamCard({ pid, fetchFn }: CareTeamCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<CareTeam>>(
    `CareTeam?patient=${pid}&status=active&_include=CareTeam:participant`,
  );
  const [adding, setAdding] = useState<boolean>(false);

  const firstTeam = (data?.entry ?? [])
    .map((e: BundleEntry<CareTeam>) => e.resource)
    .filter((r): r is CareTeam => r !== undefined && r.resourceType === 'CareTeam')[0] ?? null;

  return (
    <>
      <Card
        title="Care Team"
        editLabel="Add member"
        onEditClick={() => setAdding(true)}
        loading={loading && data === undefined}
        error={data === undefined ? error : null}
        onRetry={retry}
      >
        <CareTeamBody bundle={data} />
      </Card>
      {adding && (
        <CareTeamEditModal
          puuid={pid}
          existingTeam={firstTeam}
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

interface ParticipantRow {
  participant: CareTeamParticipant;
  team: CareTeam;
}

function CareTeamBody({ bundle }: { bundle: Bundle<CareTeam> | undefined }): ReactElement {
  const teams = (bundle?.entry ?? [])
    .map((e: BundleEntry<CareTeam>) => e.resource)
    .filter((r): r is CareTeam => r !== undefined && r.resourceType === 'CareTeam');

  const rows: ParticipantRow[] = teams.flatMap((t) =>
    (t.participant ?? []).map((p) => ({ participant: p, team: t })),
  );

  return (
    <div className="table-responsive">
      <table className="table table-sm mb-0">
        <thead>
          <tr className="text-body-secondary">
            <th scope="col">Type</th>
            <th scope="col">Member</th>
            <th scope="col">Role</th>
            <th scope="col">Facility</th>
            <th scope="col">Since</th>
            <th scope="col">Status</th>
            <th scope="col">Note</th>
            <th scope="col">Remove</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="text-muted small">Nothing Recorded</td>
            </tr>
          ) : (
            rows.map((r, idx) => (
              <tr key={r.participant.member?.reference ?? `p-${idx}`}>
                <td>{typeOf(r.participant)}</td>
                <td>{memberOf(r.participant)}</td>
                <td>{roleOf(r.participant)}</td>
                <td>{facilityOf(r.team)}</td>
                <td>{sinceOf(r.participant, r.team)}</td>
                <td>{statusOf(r.team)}</td>
                <td>{noteOf(r.team)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-link text-danger p-0"
                    aria-label={`Remove ${memberOf(r.participant)}`}
                    title="Remove"
                  >
                    &times;
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {rows.length === 0 && (
        <span className="visually-hidden">No active care team.</span>
      )}
    </div>
  );
}

function typeOf(p: CareTeamParticipant): string {
  const ref = p.member?.reference;
  if (typeof ref !== 'string') return '—';
  if (ref.startsWith('Practitioner/')) return 'Practitioner';
  if (ref.startsWith('Organization/')) return 'Organization';
  if (ref.startsWith('RelatedPerson/')) return 'Related';
  return '—';
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

function facilityOf(t: CareTeam): string {
  const org = t.managingOrganization?.[0];
  if (org === undefined) return '—';
  if (typeof org.display === 'string' && org.display.length > 0) return org.display;
  if (typeof org.reference === 'string' && org.reference.length > 0) return org.reference;
  return '—';
}

function sinceOf(p: CareTeamParticipant, t: CareTeam): string {
  const start = p.period?.start ?? t.period?.start;
  return start ?? '—';
}

function statusOf(t: CareTeam): string {
  return t.status ?? '—';
}

function noteOf(t: CareTeam): string {
  const note = t.note?.[0]?.text;
  return typeof note === 'string' && note.length > 0 ? note : '—';
}
