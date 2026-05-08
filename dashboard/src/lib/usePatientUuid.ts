import { useEffect, useState } from 'react';
import type { Bundle, BundleEntry, Patient } from '@medplum/fhirtypes';
import { useFhir } from './auth';

export interface PatientUuidResult {
  uuid: string | null;
  error: Error | null;
  loading: boolean;
}

// Resolves the FHIR Patient UUID for the active session.
//
// OpenEMR's REST/FHIR layer keys Patient resources by UUID, but the
// rest of the SPA — the URL, the patient-finder iframe, the legacy
// shims — passes around the integer pid the database has used since
// 2001. Two ways to bridge that:
//
//   1. The SMART launch token. When the SPA is hosted under
//      main_v2.php and authorize() is given a pid, the resulting
//      access token's context carries the patient UUID at
//      client.patient.id. Cheap, single source of truth, no extra
//      round-trip.
//
//   2. A FHIR identifier search. Falls back to
//      `Patient?identifier=$pid` and reads `entry[0].resource.id`.
//      Used when the SMART context lacks a patient (tests, future
//      standalone launches where the user is browsing without a
//      bound patient yet).
export function usePatientUuid(pid: string): PatientUuidResult {
  const client = useFhir();
  const launchUuid = client.patient?.id ?? null;

  const [state, setState] = useState<PatientUuidResult>({
    uuid: launchUuid,
    error: null,
    loading: launchUuid === null,
  });

  useEffect(() => {
    if (launchUuid !== null) {
      setState({ uuid: launchUuid, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ uuid: null, error: null, loading: true });
    client
      .request<Bundle<Patient>>(`Patient?identifier=${encodeURIComponent(pid)}`)
      .then((bundle) => {
        if (cancelled) return;
        const first: BundleEntry<Patient> | undefined = bundle.entry?.[0];
        const id = first?.resource?.id ?? null;
        setState({ uuid: id, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error('Patient lookup failed');
        setState({ uuid: null, error, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [client, pid, launchUuid]);

  return state;
}
