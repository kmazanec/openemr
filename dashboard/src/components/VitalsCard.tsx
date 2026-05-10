import { useMemo, useState, type ReactElement } from 'react';
import type {
  Bundle,
  BundleEntry,
  Observation,
  ObservationComponent,
} from '@medplum/fhirtypes';
import { Card } from './Card';
import { useFhirRequest } from '../lib/useFhirRequest';
import { VitalsEditModal } from './VitalsEditModal';

/**
 * Vital signs card. Reads FHIR `Observation?category=vital-signs`,
 * keyed by LOINC. The OpenEMR FHIR layer surfaces:
 *   - `85354-9` BP panel (with `component[]` for systolic / diastolic)
 *   - `8867-4` heart rate
 *   - `9279-1` respiratory rate
 *   - `8310-5` body temperature
 *   - `8302-2` body height
 *   - `29463-7` body weight
 *   - `39156-5` BMI
 *   - `2708-6` / `59408-5` oxygen saturation
 *
 * For the rolled-up dashboard view we collapse the most recent
 * observation per vital and render one row per encounter date so the
 * doctor can scan trends. Editing opens the in-page form which posts
 * a single `form_vitals` row through the dashboard-editor module.
 */

const LOINC = {
  BP_PANEL: '85354-9',
  BP_SYSTOLIC: '8480-6',
  BP_DIASTOLIC: '8462-4',
  HEART_RATE: '8867-4',
  RESP_RATE: '9279-1',
  TEMP: '8310-5',
  HEIGHT: '8302-2',
  WEIGHT: '29463-7',
  BMI: '39156-5',
  SPO2_PULSE_OX_PANEL: '59408-5',
  SPO2: '2708-6',
} as const;

export interface VitalsCardProps {
  pid: string;
  fetchFn?: typeof fetch;
}

export function VitalsCard({ pid, fetchFn }: VitalsCardProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Bundle<Observation>>(
    `Observation?patient=${pid}&category=vital-signs&_sort=-date&_count=20`,
  );
  const [adding, setAdding] = useState<boolean>(false);

  const rows = useMemo(() => collapseByDate(data), [data]);

  return (
    <>
      <Card
        title="Vitals"
        editLabel="Add vitals"
        onEditClick={() => setAdding(true)}
        loading={loading && data === undefined}
        error={data === undefined ? error : null}
        onRetry={retry}
      >
        <VitalsBody rows={rows} />
      </Card>
      {adding && (
        <VitalsEditModal
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

interface VitalsRow {
  date: string;
  bp: string;
  hr: string;
  rr: string;
  temp: string;
  height: string;
  weight: string;
  bmi: string;
  spo2: string;
}

function VitalsBody({ rows }: { rows: VitalsRow[] }): ReactElement {
  if (rows.length === 0) {
    return (
      <p className="text-muted mb-0 small">
        Nothing Recorded
        <span className="visually-hidden"> (No vitals on file.)</span>
      </p>
    );
  }
  return (
    <div className="table-responsive">
      <table className="table table-sm table-borderless mb-0">
        <thead>
          <tr className="text-body-secondary small">
            <th scope="col">Date</th>
            <th scope="col">BP</th>
            <th scope="col">HR</th>
            <th scope="col">RR</th>
            <th scope="col">Temp</th>
            <th scope="col">SpO₂</th>
            <th scope="col">Height</th>
            <th scope="col">Weight</th>
            <th scope="col">BMI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td>{r.date}</td>
              <td>{r.bp}</td>
              <td>{r.hr}</td>
              <td>{r.rr}</td>
              <td>{r.temp}</td>
              <td>{r.spo2}</td>
              <td>{r.height}</td>
              <td>{r.weight}</td>
              <td>{r.bmi}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Collapse the FHIR Observation bundle into one row per encounter
 * date. Each LOINC slot is filled by the most recent observation for
 * that date — typically there's one per encounter so the merge is a
 * no-op, but if the chart has duplicates we take the latest by
 * `effectiveDateTime` order (the bundle is _sort=-date).
 */
function collapseByDate(bundle: Bundle<Observation> | undefined): VitalsRow[] {
  const entries = bundle?.entry ?? [];
  const observations = entries
    .map((e: BundleEntry<Observation>) => e.resource)
    .filter((r): r is Observation => r !== undefined);

  const byDate = new Map<string, VitalsRow>();
  for (const obs of observations) {
    const date = (obs.effectiveDateTime ?? obs.issued ?? '').slice(0, 10);
    if (date === '') continue;
    const row =
      byDate.get(date) ??
      ({ date, bp: '—', hr: '—', rr: '—', temp: '—', spo2: '—', height: '—', weight: '—', bmi: '—' } satisfies VitalsRow);
    fillRow(row, obs);
    byDate.set(date, row);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
}

function fillRow(row: VitalsRow, obs: Observation): void {
  const code = obs.code?.coding?.find((c) => typeof c.code === 'string')?.code;
  if (code === undefined) return;
  switch (code) {
    case LOINC.BP_PANEL: {
      const sys = componentValue(obs.component, LOINC.BP_SYSTOLIC);
      const dia = componentValue(obs.component, LOINC.BP_DIASTOLIC);
      if (sys !== null && dia !== null) row.bp = `${sys}/${dia}`;
      return;
    }
    case LOINC.HEART_RATE:
      row.hr = quantity(obs);
      return;
    case LOINC.RESP_RATE:
      row.rr = quantity(obs);
      return;
    case LOINC.TEMP:
      row.temp = quantity(obs);
      return;
    case LOINC.HEIGHT:
      row.height = quantity(obs);
      return;
    case LOINC.WEIGHT:
      row.weight = quantity(obs);
      return;
    case LOINC.BMI:
      row.bmi = quantity(obs);
      return;
    case LOINC.SPO2:
    case LOINC.SPO2_PULSE_OX_PANEL: {
      const direct = quantity(obs);
      if (direct !== '—') {
        row.spo2 = direct;
        return;
      }
      const inComponent = componentValue(obs.component, LOINC.SPO2);
      if (inComponent !== null) row.spo2 = inComponent;
      return;
    }
    default:
      return;
  }
}

function quantity(obs: Observation): string {
  const q = obs.valueQuantity;
  if (q === undefined || typeof q.value !== 'number') return '—';
  const unit = typeof q.unit === 'string' && q.unit.length > 0 ? ` ${q.unit}` : '';
  return `${roundLab(q.value)}${unit}`;
}

function componentValue(
  components: ObservationComponent[] | undefined,
  loinc: string,
): string | null {
  const match = (components ?? []).find((c) =>
    c.code?.coding?.some((cc) => cc.code === loinc),
  );
  if (match === undefined) return null;
  const v = match.valueQuantity?.value;
  if (typeof v !== 'number') return null;
  return String(roundLab(v));
}

function roundLab(n: number): number {
  if (Math.abs(n) >= 100) return Math.round(n);
  return Math.round(n * 10) / 10;
}
