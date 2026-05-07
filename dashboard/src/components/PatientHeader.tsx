import type { ReactElement } from 'react';
import type { HumanName, Identifier, Patient } from '@medplum/fhirtypes';
import { useFhirRequest } from '../lib/useFhirRequest';

const MR_CODE = 'MR';

export interface PatientHeaderProps {
  pid: string;
  today?: Date;
}

export function PatientHeader({ pid, today }: PatientHeaderProps): ReactElement {
  const { data, error, loading, retry } = useFhirRequest<Patient>(`Patient/${pid}`);

  if (loading && data === undefined) {
    return <PatientHeaderSkeleton />;
  }

  if (error !== null && data === undefined) {
    return <PatientHeaderError onRetry={retry} />;
  }

  if (data === undefined) {
    return <PatientHeaderSkeleton />;
  }

  return <PatientHeaderView patient={data} today={today ?? new Date()} />;
}

function PatientHeaderView({
  patient,
  today,
}: {
  patient: Patient;
  today: Date;
}): ReactElement {
  const name = formatName(patient.name);
  const dob = patient.birthDate;
  const age = dob !== undefined ? ageFromBirthdate(dob, today) : null;
  const sex = patient.gender;
  const mrn = mrnFromIdentifiers(patient.identifier);
  const status = statusOf(patient);

  return (
    <div className="card patient-header" data-testid="patient-header">
      <div className="card-body d-flex flex-wrap align-items-center gap-3">
        <div className="patient-header-name flex-grow-1">
          <h2 className="h5 mb-1">{name}</h2>
          <div className="text-muted small">
            {dob !== undefined && (
              <span className="me-3">
                DOB: {dob}
                {age !== null && <> (age {age})</>}
              </span>
            )}
            {sex !== undefined && <span className="me-3">Sex: {sex}</span>}
            {mrn !== null && <span className="me-3">MRN: {mrn}</span>}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>
    </div>
  );
}

type PatientStatus = 'active' | 'inactive' | 'deceased';

function statusOf(patient: Patient): PatientStatus {
  if (patient.deceasedBoolean === true || typeof patient.deceasedDateTime === 'string') {
    return 'deceased';
  }
  if (patient.active === false) {
    return 'inactive';
  }
  return 'active';
}

function StatusBadge({ status }: { status: PatientStatus }): ReactElement {
  const label = status === 'active' ? 'Active' : status === 'inactive' ? 'Inactive' : 'Deceased';
  const cls =
    status === 'active'
      ? 'bg-success'
      : status === 'inactive'
        ? 'bg-secondary'
        : 'bg-dark';
  return <span className={`badge ${cls}`}>{label}</span>;
}

function PatientHeaderSkeleton(): ReactElement {
  return (
    <div
      className="card patient-header"
      data-testid="patient-header-skeleton"
      aria-busy="true"
    >
      <div className="card-body">
        <div className="placeholder-glow">
          <span className="placeholder col-4" />
          <br />
          <span className="placeholder col-6" />
        </div>
      </div>
    </div>
  );
}

function PatientHeaderError({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div className="card patient-header border-danger" data-testid="patient-header-error">
      <div className="card-body d-flex justify-content-between align-items-center">
        <span>Couldn&rsquo;t load patient</span>
        <button type="button" className="btn btn-sm btn-outline-danger" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

function formatName(names: HumanName[] | undefined): string {
  if (names === undefined || names.length === 0) return 'Unknown patient';
  const primary = names.find((n) => n.use === 'official') ?? names[0];
  if (primary === undefined) return 'Unknown patient';
  if (typeof primary.text === 'string' && primary.text.length > 0) return primary.text;
  const given = primary.given?.join(' ') ?? '';
  const family = primary.family ?? '';
  const composed = `${given} ${family}`.trim();
  return composed.length > 0 ? composed : 'Unknown patient';
}

function mrnFromIdentifiers(identifiers: Identifier[] | undefined): string | null {
  if (identifiers === undefined) return null;
  const mr = identifiers.find((id) =>
    id.type?.coding?.some((c) => c.code === MR_CODE),
  );
  if (mr?.value !== undefined && mr.value.length > 0) return mr.value;
  // Fallback: first identifier with a value.
  const fallback = identifiers.find((id) => typeof id.value === 'string' && id.value.length > 0);
  return fallback?.value ?? null;
}

function ageFromBirthdate(birthDate: string, today: Date): number | null {
  const parts = birthDate.split('-');
  if (parts.length < 1) return null;
  const yStr = parts[0];
  const mStr = parts[1] ?? '1';
  const dStr = parts[2] ?? '1';
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  let age = today.getFullYear() - y;
  const beforeBirthdayThisYear =
    today.getMonth() + 1 < m ||
    (today.getMonth() + 1 === m && today.getDate() < d);
  if (beforeBirthdayThisYear) age -= 1;
  return age >= 0 ? age : null;
}
