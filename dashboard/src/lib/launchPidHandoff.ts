// Helpers for the dashboard-toggle pid handoff.
//
// When the user flips between the legacy main.php shell and the
// main_v2.php SPA shell via interface/main/tabs/dashboard_toggle.php,
// the toggle endpoint forwards the active session pid to the
// destination shell as a `?pid=<n>` query param. The SPA reads it
// here on initial mount so the in-memory router lands on the same
// patient instead of the dashboard root, which would otherwise
// trigger 401s as patient-scoped boxes fire FHIR queries without a
// SMART session bound to that patient.

// Read `?pid=<n>` off a query string, accepting only positive
// integer strings. Zero and negatives are not real patient ids
// (legacy setpid() and main_v2.php's pid→puuid lookup both treat
// them as "no patient"), so the SPA must reject them too.
export function readUrlPidFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('pid');
  if (raw === null || raw === '' || !/^[1-9]\d*$/.test(raw)) return null;
  return raw;
}

export function readUrlPid(): string | null {
  if (typeof window === 'undefined') return null;
  return readUrlPidFromSearch(window.location.search);
}
