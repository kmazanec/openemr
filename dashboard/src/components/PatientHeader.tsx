import type { ReactElement } from 'react';
import type { Bundle, BundleEntry, HumanName, Identifier, Patient } from '@medplum/fhirtypes';
import { useFhirRequest } from '../lib/useFhirRequest';

const MR_CODE = 'MR';

export interface PatientHeaderProps {
  pid: string;
  today?: Date;
}

// OpenEMR's FHIR layer keys Patient resources by UUID, but the
// dashboard receives the legacy integer pid from the patient
// finder. Look the patient up by its `identifier` field (which the
// FHIR layer populates with the legacy pid) and take the first
// match. This avoids a separate pid → uuid round-trip and keeps the
// card parameterized by the value the rest of the SPA passes in.
export function PatientHeader({ pid, today }: PatientHeaderProps): ReactElement {
  const { data: bundle, error, loading, retry } = useFhirRequest<Bundle<Patient>>(
    `Patient?identifier=${encodeURIComponent(pid)}`,
  );

  const data: Patient | undefined = firstEntry(bundle);

  if (loading && data === undefined) {
    return <PatientHeaderSkeleton />;
  }

  if (error !== null && data === undefined) {
    return <PatientHeaderError onRetry={retry} />;
  }

  if (data === undefined) {
    return <PatientHeaderSkeleton />;
  }

  return <PatientHeaderView pid={pid} patient={data} today={today ?? new Date()} />;
}

function PatientHeaderView({
  pid,
  patient,
  today,
}: {
  pid: string;
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
    <div className="patient-header px-3 py-2 border-bottom" data-testid="patient-header">
      <div className="d-flex align-items-start gap-3">
        <PatientAvatar />
        <div className="flex-grow-1">
          <div className="d-flex align-items-center gap-2">
            <h1 className="h4 mb-0 text-primary fw-normal">
              {name} <span className="text-muted">({pid})</span>
            </h1>
            <button
              type="button"
              className="btn btn-sm btn-link text-muted text-decoration-none p-0"
              aria-label="Close patient"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  const top: (Window & { clearPatient?: () => void }) | null = window.top;
                  top?.clearPatient?.();
                }
              }}
            >
              &times;
            </button>
          </div>
          <div className="text-body-secondary small">
            {dob !== undefined && (
              <span className="me-3">
                DOB: {dob}
                {age !== null && <> Age: {age}</>}
              </span>
            )}
            {sex !== undefined && <span className="me-3 visually-hidden">Sex: {sex}</span>}
            {mrn !== null && <span className="me-3 visually-hidden">MRN: {mrn}</span>}
            <span className="visually-hidden"><StatusBadge status={status} /></span>
          </div>
        </div>
        <EncounterSelector />
      </div>
    </div>
  );
}

function PatientAvatar(): ReactElement {
  return (
    <div
      className="rounded-circle bg-body-tertiary d-flex align-items-center justify-content-center flex-shrink-0"
      style={{ width: 48, height: 48 }}
      aria-hidden="true"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="text-secondary"
      >
        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
      </svg>
    </div>
  );
}

function EncounterSelector(): ReactElement {
  return (
    <div className="d-flex align-items-center gap-2 flex-shrink-0" data-testid="encounter-selector">
      <button
        type="button"
        className="btn btn-sm btn-link text-decoration-none p-1"
        aria-label="Encounter history"
        title="Encounter history"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 3.5a.5.5 0 0 0-.5.5v4a.5.5 0 0 0 .146.354l3 3a.5.5 0 0 0 .708-.708L8.5 7.793V4a.5.5 0 0 0-.5-.5z" />
          <path d="M8 16A8 8 0 1 0 0 8a.5.5 0 0 1 1 0 7 7 0 1 1 2.05 4.95L1.107 11H4.5a.5.5 0 0 1 0 1H.5a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 1 0v2.469l1.226-1.226A7 7 0 0 0 8 16z" />
        </svg>
      </button>
      <div className="input-group input-group-sm" style={{ width: 'auto' }}>
        <button
          type="button"
          className="btn btn-outline-secondary dropdown-toggle"
          aria-haspopup="listbox"
          aria-expanded="false"
        >
          Select Encounter
        </button>
      </div>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        aria-label="New encounter"
        title="New encounter"
      >
        +
      </button>
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
  return <span>{label}</span>;
}

function PatientHeaderSkeleton(): ReactElement {
  return (
    <div
      className="patient-header px-3 py-2 border-bottom"
      data-testid="patient-header-skeleton"
      aria-busy="true"
    >
      <div className="placeholder-glow">
        <span className="placeholder col-4" />
        <br />
        <span className="placeholder col-6" />
      </div>
    </div>
  );
}

function PatientHeaderError({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div className="patient-header px-3 py-2 border-bottom border-danger" data-testid="patient-header-error">
      <div className="d-flex justify-content-between align-items-center">
        <span>Couldn&rsquo;t load patient</span>
        <button type="button" className="btn btn-sm btn-outline-danger" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

function firstEntry(bundle: Bundle<Patient> | undefined): Patient | undefined {
  if (bundle === undefined) return undefined;
  const entries = bundle.entry;
  if (entries === undefined || entries.length === 0) return undefined;
  const first: BundleEntry<Patient> | undefined = entries[0];
  return first?.resource;
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
