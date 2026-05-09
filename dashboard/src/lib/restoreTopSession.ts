/**
 * Re-pin the OpenEMR session cookie to this tab's PHP-assigned
 * session id before any same-origin fetch into the OpenEMR
 * Co-Pilot endpoints (agent.php, document_view.php, etc.).
 *
 * Why: OpenEMR supports parallel logins per browser by leaving the
 * core session cookie writable from JS (cookie_httponly is
 * intentionally false). When another tab in the same browser mints
 * a new session id — common after a SMART OAuth round-trip, a second
 * login, or even an iframe reload — `document.cookie` carries the
 * new id but the PHP session bound to *this* tab's request still
 * expects the old one. Without calling `top.restoreSession()` first,
 * the request lands on a session row with no `site_id`, and
 * `interface/globals.php` 400s with
 *
 *   "Site ID is missing from session data!"
 *
 * Every other AJAX caller in the codebase calls `top.restoreSession`
 * before posting — see `library/js/utility.js`, `ajtooltip.js`. The
 * legacy Co-Pilot panel was retrofitted to do the same in master's
 * `593681f69`; this helper is the SPA equivalent.
 *
 * Defensive: `top` may be sealed in tests or in a hosting context
 * where the SPA is not nested under main_v2.php. The helper no-ops
 * silently in those cases — the fetch may still succeed if the
 * cookie happens to be current.
 */
export function restoreTopSession(): void {
  try {
    if (typeof window === 'undefined') return;
    const top = window.top as Window & { restoreSession?: () => void };
    if (typeof top.restoreSession === 'function') {
      top.restoreSession();
    }
  } catch {
    // Sealed top (cross-origin) — no-op.
  }
}
