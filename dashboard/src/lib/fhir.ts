import FHIR from 'fhirclient/lib/entry/browser';
import type Client from 'fhirclient/lib/Client';
import type { fhirclient } from 'fhirclient/lib/types';

export interface OidcConfig {
  iss: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

const DEFAULT_SCOPE =
  'openid fhirUser launch/patient offline_access ' +
  'patient/Patient.read patient/AllergyIntolerance.read patient/Condition.read ' +
  'patient/MedicationRequest.read patient/CareTeam.read patient/Encounter.read';

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
 *   1. VITE_OIDC_* env var if non-empty (build-time, used in prod
 *      and in tests).
 *   2. Default computed from window.location.origin:
 *        iss          → ${origin}/apis/${SITE}/fhir
 *        redirectUri  → ${origin}/dashboard/auth/callback
 *        scope        → DEFAULT_SCOPE
 *
 * clientId additionally falls back to localStorage (the cache
 * populated by ensureClientId() on first run). Throws when no
 * clientId is resolvable.
 */
export function getOidcConfig(): OidcConfig {
  const env = import.meta.env as Record<string, string | undefined>;
  const origin = originOrUndefined();

  const issEnv = envOrEmpty(env, 'VITE_OIDC_ISSUER');
  const redirectEnv = envOrEmpty(env, 'VITE_OIDC_REDIRECT_URI');
  const scopeEnv = envOrEmpty(env, 'VITE_OIDC_SCOPE');

  const iss = issEnv !== '' ? issEnv : origin === undefined ? '' : `${origin}/apis/${SITE}/fhir`;
  const redirectUri =
    redirectEnv !== ''
      ? redirectEnv
      : origin === undefined
        ? ''
        : `${origin}/dashboard/auth/callback`;
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

export function buildAuthorizeParams(config: OidcConfig): fhirclient.AuthorizeParams {
  return {
    iss: config.iss,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scope: config.scope,
    pkceMode: 'required',
  };
}

export async function authorize(): Promise<void> {
  await ensureClientId();
  await FHIR.oauth2.authorize(buildAuthorizeParams(getOidcConfig()));
}

export async function completeAuthorization(): Promise<Client> {
  return FHIR.oauth2.ready();
}

export { FHIR };
export type { Client };
