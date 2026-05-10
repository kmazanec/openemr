/**
 * Same-origin client for the dashboard-editor module's ajax endpoint.
 *
 * Reads still flow through the FHIR layer (`useFhirRequest`); this
 * surface is for the writes the FHIR routes don't expose
 * (allergies, problems, medications, vitals, lab results, care team).
 *
 * All requests carry the page-level CSRF token (`window.csrf_token_js`
 * — the same one OpenEMR's PHP forms post) so the host session check
 * passes. The endpoint returns `{ ok: true, ...payload }` on success
 * or `{ ok: false, error: <code> }` on failure; this client narrows
 * to a discriminated-union result so the calling form can render the
 * right message without re-introspecting status + body.
 */

const ENDPOINT_URL =
  '/interface/modules/custom_modules/oe-module-dashboard-editor/public/ajax.php';

export type EditorAction =
  | 'save_allergy'
  | 'delete_allergy'
  | 'save_problem'
  | 'delete_problem'
  | 'save_medication'
  | 'delete_medication'
  | 'save_prescription'
  | 'delete_prescription'
  | 'save_lab_result'
  | 'save_vitals'
  | 'save_care_team';

export type EditorResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; code: string; messages?: Record<string, string[]> };

interface EditorRequestOptions {
  // Test-only override for the same-origin endpoint URL.
  endpointUrl?: string;
  // Test-only override for the global fetch.
  fetchFn?: typeof fetch;
  // Test-only override for window.csrf_token_js lookup.
  csrfOverride?: string;
}

export async function callEditor<T = Record<string, unknown>>(
  action: EditorAction,
  payload: Record<string, unknown>,
  options: EditorRequestOptions = {},
): Promise<EditorResult<T>> {
  const fetchImpl = options.fetchFn ?? fetch;
  const url = options.endpointUrl ?? ENDPOINT_URL;
  const csrf = options.csrfOverride ?? readCsrfToken();
  if (csrf === '') {
    return { ok: false, code: 'no_csrf' };
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, csrf_token: csrf, ...payload }),
    });
  } catch {
    return { ok: false, code: 'network_error' };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, code: 'malformed_response' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: 'malformed_response' };
  }
  const body = parsed as { ok?: unknown; error?: unknown; messages?: unknown } & Record<
    string,
    unknown
  >;
  if (response.ok && body.ok === true) {
    return { ok: true, data: body as unknown as T };
  }
  const code = typeof body.error === 'string' ? body.error : 'unknown';
  const messages =
    typeof body.messages === 'object' && body.messages !== null
      ? (body.messages as Record<string, string[]>)
      : undefined;
  return messages !== undefined
    ? { ok: false, code, messages }
    : { ok: false, code };
}

function readCsrfToken(): string {
  if (typeof window === 'undefined') return '';
  const w = window as Window & { csrf_token_js?: unknown };
  return typeof w.csrf_token_js === 'string' ? w.csrf_token_js : '';
}

/**
 * Translate an editor-error code to a human-readable string. Codes
 * mirror the PHP controller's `sendError(code)` constants. Unknown
 * codes fall back to a generic message rather than the raw code so a
 * stray response shape never leaks to the doctor.
 */
const ERROR_MESSAGES: Record<string, string> = {
  csrf_failed: 'Your session expired — please reload the page and try again.',
  not_authenticated: 'You are signed out — please sign in and try again.',
  acl_denied: 'You do not have permission to make this change.',
  missing_field: 'A required field was not filled in.',
  missing_uuid: 'This record could not be identified.',
  missing_puuid: 'This patient could not be identified.',
  unknown_patient: 'This patient could not be found.',
  invalid_team: 'Care team data was malformed.',
  unknown_action: 'This action is not supported.',
  validation_failed: 'Please correct the highlighted fields.',
  no_csrf: 'Page is not yet ready — please reload and try again.',
  network_error: 'Could not reach the server. Please try again.',
  malformed_response: 'The server returned an unexpected response.',
  server_error: 'Something went wrong on the server. Please try again.',
  unknown: 'Something went wrong. Please try again.',
};

export function messageForEditorError(result: EditorResult): string {
  if (result.ok) return '';
  return ERROR_MESSAGES[result.code] ?? ERROR_MESSAGES.unknown!;
}
