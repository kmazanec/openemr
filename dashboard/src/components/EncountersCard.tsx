import type { ReactElement } from 'react';
import type {
  Bundle,
  BundleEntry,
  CodeableConcept,
  Encounter,
  EncounterParticipant,
} from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';

export interface EncountersCardProps {
  pid: string;
}

export function EncountersCard({ pid }: EncountersCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<Encounter>>(
    `Encounter?patient=${pid}&_sort=-date&_count=10`,
  );

  return (
    <Card
      title="Recent Encounters"
      loading={loading && data === undefined}
      error={data === undefined ? error : null}
      onRetry={retry}
    >
      <EncountersBody bundle={data} />
    </Card>
  );
}

function EncountersBody({ bundle }: { bundle: Bundle<Encounter> | undefined }): ReactElement {
  const encounters = (bundle?.entry ?? [])
    .map((e: BundleEntry<Encounter>) => e.resource)
    .filter((r): r is Encounter => r !== undefined);

  return (
    <div className="table-responsive">
      <table className="table table-sm mb-0">
        <thead>
          <tr className="text-body-secondary">
            <th scope="col">Date</th>
            <th scope="col">Type</th>
            <th scope="col">Provider</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {encounters.length === 0 ? (
            <tr>
              <td colSpan={4} className="text-muted small">
                Nothing Recorded
                <span className="visually-hidden"> (No recent encounters.)</span>
              </td>
            </tr>
          ) : (
            encounters.map((e) => (
              <tr key={e.id ?? Math.random().toString(36)}>
                <td>{dateOf(e)}</td>
                <td>{typeOf(e.type)}</td>
                <td>{providerOf(e.participant)}</td>
                <td>{reasonOf(e.reasonCode)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function dateOf(e: Encounter): string {
  const start = e.period?.start;
  if (typeof start !== 'string' || start.length === 0) return '—';
  // Surface the calendar date; full ISO timestamps clutter the table.
  return start.slice(0, 10);
}

function typeOf(types: CodeableConcept[] | undefined): string {
  if (types === undefined || types.length === 0) return '—';
  const first = types[0];
  if (first === undefined) return '—';
  if (typeof first.text === 'string' && first.text.length > 0) return first.text;
  const display = first.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '—';
}

function providerOf(participants: EncounterParticipant[] | undefined): string {
  if (participants === undefined || participants.length === 0) return '—';
  const first = participants[0];
  if (first === undefined) return '—';
  const display = first.individual?.display;
  return typeof display === 'string' && display.length > 0 ? display : '—';
}

function reasonOf(reasons: CodeableConcept[] | undefined): string {
  if (reasons === undefined || reasons.length === 0) return '—';
  const first = reasons[0];
  if (first === undefined) return '—';
  if (typeof first.text === 'string' && first.text.length > 0) return first.text;
  const display = first.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '—';
}
