import FHIR from 'fhirclient/lib/entry/browser';
import type Client from 'fhirclient/lib/Client';
import type { fhirclient } from 'fhirclient/lib/types';

export interface OidcConfig {
  iss: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

// SMART scopes the dashboard requests at authorize time.
//
// `launch` and `launch/patient` together cover both the EHR-launch
// flow (patient context handed in via the `launch` token from
// main_v2.php) and the fallback standalone flow (no launch context;
// fhirclient asks the user to pick a patient if needed).
const DEFAULT_SCOPE =
  'openid fhirUser launch launch/patient offline_access ' +
  'patient/Patient.read patient/AllergyIntolerance.read patient/Condition.read ' +
  'patient/MedicationRequest.read patient/CareTeam.read patient/Encounter.read ' +
  'patient/Observation.read patient/DiagnosticReport.read patient/Immunization.read';

// localStorage key for the auto-registered SMART client. We cache
// the client_id so the user goes through registration once and the
// SPA reuses it across browser sessions until the user clears
// storage. Prod deploys set VITE_OIDC_CLIENT_ID at build time and
// never hit this path.
const CACHED_CLIENT_ID_KEY = 'oeDashboard.smartClientId';

// OpenEMR site identifier. Hardcoded to "default" for now; if the
// SPA needs to support multiple sites, plumb this through globals
// from main_v2.php.
const SITE = 'default';

// Read the SPA's host origin in a way that's safe for tests
// (where window may not exist) — return undefined so callers know
// to require an explicit env var.
function originOrUndefined(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location.origin;
}

// Read an env var, treating '' the same as undefined so a stubbed
// or unset var both fall through to the computed default.
function envOrEmpty(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  return v === undefined ? '' : v;
}

/**
 * Build the OIDC config from environment variables, with sensible
 * defaults derived from the SPA's host origin.
 *
 * Precedence (per field):
 *   1. When the SPA is hosted inside main_v2.php (window.OE_SMART_LAUNCH
 *      is present), iss and redirectUri are forced to the SPA's actual
 *      origin so they line up with what the OAuth server expects from a
 *      same-origin EHR launch. Stale .env.local values from standalone
 *      Vite dev would otherwise leak through and produce a redirect_uri
 *      mismatch.
 *   2. Otherwise, VITE_OIDC_* env var if non-empty (build-time).
 *   3. Otherwise, computed from window.location.origin.
 *
 * clientId additionally falls back to localStorage (the cache
 * populated by ensureClientId() on first run). Throws when no
 * clientId is resolvable.
 */
export function getOidcConfig(): OidcConfig {
  const env = import.meta.env as Record<string, string | undefined>;
  const origin = originOrUndefined();
  const ehrLaunch = typeof window === 'undefined' ? undefined : window.OE_SMART_LAUNCH;

  const issEnv = envOrEmpty(env, 'VITE_OIDC_ISSUER');
  const redirectEnv = envOrEmpty(env, 'VITE_OIDC_REDIRECT_URI');
  const scopeEnv = envOrEmpty(env, 'VITE_OIDC_SCOPE');

  const computedIss = origin === undefined ? '' : `${origin}/apis/${SITE}/fhir`;
  const computedRedirect = origin === undefined ? '' : `${origin}/dashboard/auth/callback`;

  const iss = ehrLaunch !== undefined ? computedIss : issEnv !== '' ? issEnv : computedIss;
  const redirectUri =
    ehrLaunch !== undefined ? computedRedirect : redirectEnv !== '' ? redirectEnv : computedRedirect;
  const scope = scopeEnv !== '' ? scopeEnv : DEFAULT_SCOPE;

  // clientId can come from build-time env (prod) or from a
  // localStorage cache populated by ensureClientId() on first run.
  let clientId = envOrEmpty(env, 'VITE_OIDC_CLIENT_ID');
  if (clientId === '' && typeof localStorage !== 'undefined') {
    clientId = localStorage.getItem(CACHED_CLIENT_ID_KEY) ?? '';
  }

  const missing: string[] = [];
  if (iss === '') missing.push('VITE_OIDC_ISSUER (or window.location.origin)');
  if (clientId === '')
    missing.push('VITE_OIDC_CLIENT_ID (set at build time, or call ensureClientId() first)');
  if (redirectUri === '') missing.push('VITE_OIDC_REDIRECT_URI (or window.location.origin)');
  if (scope === '') missing.push('VITE_OIDC_SCOPE');

  if (missing.length > 0) {
    throw new Error(
      `Missing required dashboard OIDC config: ${missing.join(', ')}. ` +
        `See dashboard/.env.example.`,
    );
  }

  return { iss, clientId, redirectUri, scope };
}

/**
 * Register a public SMART client with OpenEMR's OAuth2 server and
 * cache the resulting client_id in localStorage. No-ops if a
 * client_id is already available (env or cache). Returns the
 * client_id either way.
 *
 * The registration endpoint is open: posting `application_type:
 * "public"` with patient/* scopes auto-enables the client without
 * admin approval (verified against the dev compose stack).
 */
export async function ensureClientId(): Promise<string> {
  const env = import.meta.env as Record<string, string | undefined>;
  const fromEnv = envOrEmpty(env, 'VITE_OIDC_CLIENT_ID');
  if (fromEnv !== '') return fromEnv;
  if (typeof localStorage !== 'undefined') {
    const cached = localStorage.getItem(CACHED_CLIENT_ID_KEY);
    if (cached !== null && cached !== '') return cached;
  }

  const origin = originOrUndefined();
  if (origin === undefined) {
    throw new Error('ensureClientId: no window.location available');
  }

  const redirectEnv = envOrEmpty(env, 'VITE_OIDC_REDIRECT_URI');
  const scopeEnv = envOrEmpty(env, 'VITE_OIDC_SCOPE');
  const redirectUri = redirectEnv !== '' ? redirectEnv : `${origin}/dashboard/auth/callback`;
  const scope = scopeEnv !== '' ? scopeEnv : DEFAULT_SCOPE;

  // Note: OpenEMR's RFC 7591 registration does NOT accept the
  // skip_ehr_launch_authorization_flow flag in the request body.
  // We register the client here with the right scope, then an
  // admin enables EHR-launch-skip via the OAuth Clients admin UI
  // (or, in dev, a one-line UPDATE). See dashboard/README.md for
  // the prod runbook.
  const response = await fetch(`${origin}/oauth2/${SITE}/registration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      application_type: 'public',
      redirect_uris: [redirectUri],
      client_name: 'OpenEMR Patient Dashboard',
      scope,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to register OAuth2 client at ${origin}/oauth2/${SITE}/registration: ${response.status}`,
    );
  }
  const body = (await response.json()) as { client_id?: unknown };
  if (typeof body.client_id !== 'string' || body.client_id === '') {
    throw new Error(
      `Registration response from ${origin}/oauth2/${SITE}/registration had no client_id`,
    );
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(CACHED_CLIENT_ID_KEY, body.client_id);
  }
  return body.client_id;
}

// Shape main_v2.php emits as window.OE_SMART_LAUNCH (and that
// main_v2_launch.php returns from a per-patient request). The
// launch token is an opaque, encrypted blob built by SMARTLaunchToken
// (PHP-side) carrying the patient UUID and intent. `aud` is the
// FHIR base URL the access token will be bound to.
export interface SmartLaunch {
  launch: string;
  aud: string;
}

declare global {
  interface Window {
    OE_SMART_LAUNCH?: SmartLaunch;
    api_csrf_token_js?: string;
    webroot_url?: string;
  }
}

// Fetch a freshly-built launch token bound to the given legacy
// integer pid. Required when the user has just picked a patient in
// the legacy finder — the page-load OE_SMART_LAUNCH would carry no
// patient context, so the resulting access token's `context` would
// be empty and FHIR requests would 401.
export async function fetchLaunchForPid(pid: string): Promise<SmartLaunch> {
  if (typeof window === 'undefined') {
    throw new Error('fetchLaunchForPid: window unavailable');
  }
  const csrf = window.api_csrf_token_js ?? '';
  const root = window.webroot_url ?? '';
  if (csrf === '') {
    throw new Error('fetchLaunchForPid: api_csrf_token_js not set on window');
  }
  const response = await fetch(
    `${root}/interface/main/tabs/main_v2_launch.php?pid=${encodeURIComponent(pid)}`,
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', APICSRFTOKEN: csrf },
    },
  );
  if (!response.ok) {
    throw new Error(`fetchLaunchForPid: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { launch?: unknown; aud?: unknown };
  if (typeof body.launch !== 'string' || typeof body.aud !== 'string') {
    throw new Error('fetchLaunchForPid: malformed response');
  }
  return { launch: body.launch, aud: body.aud };
}

export function buildAuthorizeParams(
  config: OidcConfig,
  smartLaunch?: SmartLaunch,
): fhirclient.AuthorizeParams {
  // EHR launch path: `iss` becomes the FHIR base URL the EHR
  // declared as `aud`, and we forward the encrypted launch token.
  // Combined with the OAuth client's skip_ehr_launch_authorization_flow
  // flag and the OpenEMR session cookie, the OAuth server issues a
  // code immediately without a second login screen — so the OAuth
  // dance is just two redirects (authorize → callback) and we can
  // safely run them in the same window. The SMART session ends up
  // in window.sessionStorage; AuthCallbackRoute then bounces through
  // main_v2_resume.php to re-mint token_main and re-mount the SPA
  // shell with the SMART session intact (sessionStorage survives
  // navigations within the same tab + origin).
  if (smartLaunch !== undefined) {
    return {
      iss: smartLaunch.aud,
      launch: smartLaunch.launch,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scope: config.scope,
      pkceMode: 'required',
    };
  }
  // Standalone launch: no patient context handed in. fhirclient
  // walks the user through SMART discovery + the standard provider
  // login. Used for tests and any future deploy where the SPA is
  // not embedded in main_v2.php.
  return {
    iss: config.iss,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scope: config.scope,
    pkceMode: 'required',
  };
}

// Tracks which legacy pid the active SMART session was minted for.
// Survives across redirects (sessionStorage) so that on mount we can
// detect "user picked a different patient since last launch" and
// kick off a fresh authorize.
const LAUNCH_PID_STORAGE_KEY = 'OE_LAUNCH_PID';

export function getLaunchPid(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage.getItem(LAUNCH_PID_STORAGE_KEY);
}

function setLaunchPid(pid: string | undefined): void {
  if (typeof sessionStorage === 'undefined') return;
  if (pid === undefined || pid === '') {
    sessionStorage.removeItem(LAUNCH_PID_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(LAUNCH_PID_STORAGE_KEY, pid);
}

// Forget which patient the active session belongs to. Called when
// the user explicitly clears the patient (× button, legacy
// clearPatient() shim) so the next mount does not auto-restore the
// patient they just closed.
export function clearLaunchPid(): void {
  setLaunchPid(undefined);
}

// Kick off the SMART OIDC dance.
//
// pid (optional): the legacy integer pid the user just picked. When
// present, we fetch a fresh launch token bound to that patient so
// the resulting access token's context.patient is set. Without it
// we fall back to the page-load OE_SMART_LAUNCH (no-patient
// launch), which is fine for landing flows that don't yet need
// patient-scoped FHIR access.
export async function authorize(pid?: string): Promise<void> {
  await ensureClientId();
  let smartLaunch: SmartLaunch | undefined;
  if (typeof window !== 'undefined') {
    if (pid !== undefined && pid !== '') {
      smartLaunch = await fetchLaunchForPid(pid);
    } else {
      smartLaunch = window.OE_SMART_LAUNCH;
    }
  }
  // Record which pid this launch is bound to so subsequent mounts
  // can detect a mismatch and re-authorize. Stored before the
  // redirect; sessionStorage survives the OAuth round-trip. Only
  // when a pid is actually present — a standalone authorize (e.g.
  // LoginRoute) must not clobber the cached pid from a prior
  // patient-bound launch, or the next mount won't detect the
  // patient-switch case at all.
  if (pid !== undefined && pid !== '') {
    setLaunchPid(pid);
  }
  await FHIR.oauth2.authorize(buildAuthorizeParams(getOidcConfig(), smartLaunch));
}

export async function completeAuthorization(): Promise<Client> {
  return FHIR.oauth2.ready();
}

export { FHIR };
export type { Client };
