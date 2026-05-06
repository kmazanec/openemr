# Patient Dashboard — Bug & Smell Catalog

> **Scope.** Everything I noticed while reading the legacy dashboard code
> that *probably* shouldn't be there. Some are real bugs (broken behavior
> or data correctness), some are smells (works today but a porting hazard),
> and some are things explicitly self-marked `@todo` or "not working just
> yet" in the source. Severity is my judgement, not a CVE rating.

The legend:

- **Bug** — observable wrong behavior today.
- **Latent bug** — would manifest under specific config/runtime conditions.
- **Smell** — not strictly broken but actively hostile to a port.
- **Dead** — code self-flagged as unused or known-broken.

---

## B1. `viewPortalAudits` and `viewPortalPayments` go to the same URL

- **Severity:** Bug.
- **Where:** `interface/main/tabs/js/user_data_view_model.js:86-91, 107-112`.
- **Detail:** Both functions navigate the `msc` tab to
  `/portal/patient/onsiteactivityviews`. Clicking "Payments" in the
  portal-alerts dropdown shows the audits view, not payments.
- **Impact:** A clinician can never reach a Payments-only view from this
  menu. Likely a copy-paste during an earlier refactor.
- **Port note:** Defining the destination URLs as data (table of
  `{label, url, target}` pairs) would prevent the recurrence.

---

## B2. `main.php:155` — broken `!empty(...) ?? null` precedence makes `isFax` untrustworthy

- **Severity:** Bug (latent — masks the real `oefax_enable_fax` flag).
- **Where:** `interface/main/tabs/main.php:154-156`.
- **Detail:** The lines are:

  ```php
  const isSms = "<?php echo !empty(OEGlobalsBag::getInstance()->get('oefax_enable_sms') ?? null); ?>";
  const isFax = "<?php echo !empty(OEGlobalsBag::getInstance()->get('oefax_enable_fax')) ?? null?>";
  const isServicesOther = (isSms || isFax);
  ```

  The `?? null` on the `isFax` line sits **outside** the `!empty(...)`
  call (different paren placement vs. the `isSms` line), so it
  null-coalesces a `bool` against `null` — useless. Worse, `!empty(...)`
  emits `1` or `""`, so the JS becomes `const isFax = "1"` (truthy) or
  `const isFax = ""` (falsy in `||`). That happens to work in
  `isServicesOther`, but it's brittle, type-confused, and inconsistent
  with how the surrounding code treats the values (later uses
  `isPortalEnabled` as a string in a `FormData` body). One of:

  - if the global is unset, JS sees `const isFax = "";`
  - if set to anything truthy, JS sees `const isFax = "1";`

  Then the value gets stuffed back into `request.append("isFax", isFax)`
  and POSTed to `dated_reminders_counter.php`, which presumably treats
  `"1"` as truthy and `""` as falsy. Works, but only by accident.
- **Impact:** Latent — if anyone touches this expression, it's almost
  certain to silently break the fax/SMS counters.
- **Port note:** Pass typed booleans to the client; do not stringify
  `!empty()` results.

---

## B3. Synchronous AJAX (`async: false`) in `isEncounterLocked`

- **Severity:** Smell / latent bug.
- **Where:** `interface/main/tabs/main.php:298-309`.
- **Detail:** When ESign encounter-locking is enabled, the SPA shell
  blocks the UI thread on a `$.ajax({ async: false, ... })` call to
  `interface/esign/index.php?module=encounter&method=esign_is_encounter_locked`.
  The source explicitly TODO's this:
  *"@TODO next clean up pass, turn into await promise and modify
  tabs_view_model.js L-309"*.
- **Impact:** UI freeze for the duration of the network round-trip.
  Modern browsers also warn about `async:false` use.
- **Port note:** Convert to `async`/`await`; the call site in
  `tabs_view_model.js` needs to learn to await the result.

---

## B4. `Alt+R` hotkey is wired but does not refresh

- **Severity:** Dead.
- **Where:** `interface/main/tabs/js/shortcuts.js:17-22`.
- **Detail:** Source comment: *"Eventually allow refreshing of a tab
  with alt+r, but not working just yet."* The handler calls
  `tabRefresh()` with no argument, which is invalid because
  `tabRefresh(data)` expects the active tab's KO model.
- **Impact:** Power-user feature silently fails. No error visible.
- **Port note:** Either delete or wire to an actual "active tab"
  accessor in the new shell.

---

## B5. `deleteme()` is dead code per its own author

- **Severity:** Dead.
- **Where:** `interface/patient_file/summary/demographics.php:416-432`.
- **Detail:** The function is annotated *"@todo don't think this is
  used any longer!!"* and its companion `imdeleted()` does not appear
  to have any callers in the JS. The associated `dlgopen` for
  `../deleter.php` is still wired into the `.deleter` modal class, but
  not to `deleteme()` itself.
- **Impact:** None today (dead path). But it injects a CSRF token
  into JS unnecessarily.
- **Port note:** Drop on the way through.

---

## B6. Smarty/Twig bridge for the Prescription card

- **Severity:** Smell.
- **Where:** `interface/patient_file/summary/demographics.php:1228-1241`.
- **Detail:** The Rx card is rendered by:

  ```php
  $cwd = getcwd();
  chdir("../../../");
  $c = new Controller();
  ob_start();
  echo $c->dispatch(['controller' => 'prescription', 'action' => 'fragment', 'patient_id' => $pid]);
  $viewArgs['content'] = ob_get_contents();
  ob_end_clean();
  ```

  Source comment: *"This is a hacky way to get a Smarty template from
  the controller and injecting it into a Twig template."* It also
  changes the working directory mid-render and never restores `$cwd`
  (no `chdir($cwd)` after the bridge), leaking the CWD change to
  everything that runs after.
- **Impact:** Future code that depends on `getcwd()` from this point
  forward sees the wrong directory. Even today, fragments loaded after
  this block are using a CWD that's three levels up from where they
  expect.
- **Port note:** Decide whether the new UI reads prescriptions from
  `/fhir/MedicationRequest` (clean) or keeps the Smarty controller
  alive for write parity (still messy).

---

## B7. Document-relative URLs everywhere

- **Severity:** Smell (port hazard).
- **Where:** Most `dlgopen` calls in `demographics.php`, every
  `placeHtml()` call, and every fragment self-POST.
- **Detail:** Examples:
  `dlgopen('../../main/calendar/add_edit_event.php?...')`,
  `placeHtml('vitals_fragment.php', 'vitals_ps_expand')`,
  `pnotes_fragment.php?docUpdateId=…`. All assume the page is loaded
  from `interface/patient_file/summary/`.
- **Impact:** If you mount the dashboard at a different path (e.g. via
  a SPA router) every modal and fragment 404s.
- **Port note:** All URLs in the new client must be absolute or
  router-relative; never path-relative to the document.

---

## B8. Hardcoded iframe / tab names leak through the codebase

- **Severity:** Smell.
- **Where:** `tabs_view_model.js`, `frame_proxies.js`, every fragment,
  every cross-frame call.
- **Detail:** Names: `pat`, `enc`, `rev`, `pop`, `fin`, `cal`, `msg`,
  `gdg`, `gfn`, `por`, `msc`, `fax`, `sms`. They appear as bare
  string literals all over the place; there is no enum or registry.
- **Impact:** Renaming or splitting any tab requires a repo-wide grep.
- **Port note:** Replace with a typed route/tab registry.

---

## B9. `dlgopen('onClosed': 'refreshme')` resolves a window-scope global

- **Severity:** Smell.
- **Where:** Multiple sites in `demographics.php`'s `dlgopen` calls
  (e.g. line 638's `.medium_modal`).
- **Detail:** The `onClosed` field of the `dlgopen` options is a
  **string** which resolves to a `window[onClosed]` function lookup
  at close time. Stringly-typed callbacks survive a long time exactly
  because they break silently when the named function disappears.
- **Impact:** Any rename of e.g. `refreshme` will silently no-op the
  close handler.
- **Port note:** Use real callbacks; the new modal abstraction should
  not accept strings.

---

## B10. Auto-firing reminder/birthday popups via hidden `<a>` tags

- **Severity:** Smell.
- **Where:** `demographics.php:1062-1063, 832-870`.
- **Detail:** The reminder and birthday popups are triggered by reading
  `$('#reminder_popup_link').attr('href')` and
  `$('#birthday_popup').attr('href')` on `DOMContentLoaded`. The
  anchors themselves are hidden `<a>` elements rendered conditionally
  by PHP — if the PHP block doesn't run (e.g. CDR disabled), the
  anchor is missing and JS reads `undefined` as the URL.
- **Impact:** Brittle; every change to the conditional rendering needs
  to be matched in the JS bootstrap.
- **Port note:** Have the server send the popup data as a JSON blob,
  not as HTML attributes that JS reads.

---

## B11. Card collapse state is per-user, persisted via a generic
`user_settings.php` AJAX endpoint with no rate-limiting

- **Severity:** Smell.
- **Where:** `library/ajax/user_settings.php` and the inline POSTs at
  `demographics.php:451, 459, 903`.
- **Detail:** Every chevron click round-trips a write to
  `users_settings`. There is no debouncing, no batching, and no
  optimistic UI — if the user expands and collapses several cards in a
  row, every keypress triggers a POST.
- **Impact:** Trivial today; can compound under flaky networks.
- **Port note:** Move to `localStorage` for transient state; keep
  per-user defaults on the server for first-load only.

---

## B12. Encounter-list sync via `left_nav.syncRadios()` assumes a frame
that no longer exists

- **Severity:** Latent bug.
- **Where:** `interface/main/tabs/js/frame_proxies.js:126-138`.
- **Detail:** `left_nav.syncRadios()` and friends were designed for a
  multi-frame layout (left nav + body + footer). The current SPA shell
  has no left frame; the calls succeed because `left_nav` is just a
  bag of methods on `window`, but the radio-button selectors
  (`encounterArray` etc.) assume DOM in a specific frame.
- **Impact:** Functions can silently no-op or error if the encounter
  list rebinds in an unexpected order.
- **Port note:** Pure architectural smell; will be replaced by the
  new app's state management.

---

## B13. `placeHtml` re-executes inline `<script>` blocks each fetch

- **Severity:** Smell.
- **Where:** `demographics.php:526` (`placeHtml` definition) and every
  fragment that contains its own `<script>`.
- **Detail:** When a fragment is reloaded after a state change (e.g.
  marking a note "Done"), the inline scripts inside the fragment run
  again. Handlers attached to elements that survive the reload (rare,
  because the fragment replaces innerHTML) are not cleaned up; handlers
  attached to non-fragment DOM (e.g. the wrapper div) accumulate.
- **Impact:** Over the lifetime of a long session, multiple bound
  handlers per element are possible; debugging becomes hard.
- **Port note:** The new SPA's component lifecycle replaces this
  whole pattern.

---

## B14. `clearPatient()` forgets to clear the encounter on the server

- **Severity:** Latent bug.
- **Where:** `interface/main/tabs/js/tabs_view_model.js:408-432`.
- **Detail:** `clearPatient()` POSTs to
  `library/ajax/unset_session_ajax.php?func=unset_pid` to clear the
  PID. There is no parallel call to `unset_encounter`. If the user
  closes the patient while a different patient's encounter is in the
  session, the next patient pickup may resurface that encounter.
- **Impact:** Hard to reproduce, but the failure mode would be a
  cross-patient encounter context — i.e. a clinician filing a note
  against the wrong patient.
- **Port note:** Treat patient/encounter context atomically; clearing
  one should always clear the other downstream.

---

## B15. Search-box mode comparison uses a magic string

- **Severity:** Smell.
- **Where:** `interface/main/tabs/main.php:499`,
  `tabs_view_model.js:viewPtFinder`.
- **Detail:** The search box's behavior depends on
  `$GLOBALS['search_any_patient']` (rendered into JS as
  `search_any_type`). Modes seen in the JS: `comprehensive`, `dual`,
  `fixed`, `none`. The comparisons are open-coded across multiple
  files.
- **Impact:** Easy to drift between client and server interpretations.
- **Port note:** Centralize as an enum / typed value; emit only a
  single source-of-truth.

---

## B16. The "default open tabs" list is read every render but written
only via session

- **Severity:** Latent bug.
- **Where:** `interface/main/tabs/main.php:415-433`.
- **Detail:** When `default_open_tabs` is set in the session, the loop
  pushes them as KO models on every render. If the realpath check
  fails (`realpath($_unsafe_url) === false || !str_starts_with(...)`)
  the loop *mutates* `default_open_tabs` and writes it back to the
  session inside the loop:

  ```php
  unset($default_open_tabs[$i]);
  $session->set('default_open_tabs', $default_open_tabs);
  continue;
  ```

  Mutating the array you're iterating is a classic foot-gun. PHP's
  `foreach` copies the array header but not the entries, so this
  *happens* to work, but is fragile.
- **Impact:** None today, but anyone refactoring this loop is one
  reference modifier away from infinite loops or dropped entries.
- **Port note:** Filter once before iterating; persist once after.

---

## B17. Squad ACL enforcement is server-rendered, not API-enforced
(unverified)

- **Severity:** Potential security issue — needs verification.
- **Where:** `interface/patient_file/summary/demographics.php:1066`.
- **Detail:** The dashboard refuses to render when the patient's
  `squad` doesn't match an ACL the user holds. The legacy SQL queries
  do **not** filter by squad themselves — the gate is at the page
  level. If the FHIR / standard REST API does not also enforce squad
  ACLs, the new UI could load patient data for a squad-restricted
  patient simply by bypassing the legacy dashboard render.
- **Impact:** Potential PHI leak if confirmed.
- **Port note:** Confirm `FhirPatientService` and friends honor the
  squad gate before declaring port parity. If not, file an upstream
  issue and add a server-side filter.

---

## B18. CSRF token is regenerated per AJAX call site instead of read once

- **Severity:** Smell.
- **Where:** `main.php:132,134,175`, `demographics.php` ~19 inline
  AJAX call sites.
- **Detail:** `CsrfUtils::collectCsrfToken($session)` is called
  multiple times per page render. It's idempotent (returns the same
  token for a session), but the repeated calls are noise that makes
  the inline JS harder to read.
- **Port note:** Mint once, pass via a globally-available constant or
  fetch interceptor.

---

## B19. Background-services tick runs on every poll cycle, even when
nothing is due

- **Severity:** Smell.
- **Where:** `interface/main/tabs/main.php:264-284`.
- **Detail:** Every 60 s, the SPA shell fires a POST to
  `/apis/{site}/api/background_service/$run` regardless of whether any
  background job is actually due. The endpoint internally checks
  due-ness and may be a no-op, but the request still hits the REST
  stack and runs a SiteId resolution + auth check. Skippable via the
  `OPENEMR__NO_BACKGROUND_TASKS` env var, but on by default.
- **Impact:** Background load proportional to the number of logged-in
  users.
- **Port note:** Move to a server-side scheduler (cron / supervisord),
  not a UI poll.

---

## B20. `prescriptions` Smarty bridge leaks the CWD

- **Severity:** Latent bug.
- **Where:** `demographics.php:1228-1240` (see B6).
- **Detail:** The Rx-card render does `$cwd = getcwd(); chdir("../../../");`
  but never `chdir($cwd)`. Anything later in the page that uses a
  relative include or `realpath()` may resolve from the wrong root.
- **Impact:** Today, the only thing that runs after the bridge is
  more inline rendering with absolute or page-relative paths, so the
  bug is asymptomatic. But any reorder of card render order could
  surface it.
- **Port note:** Either delete the bridge or wrap it in a try/finally.

---

## B21. `onclick='top.restoreSession()'` strewn through markup

- **Severity:** Smell.
- **Where:** `demographics.php:1062-1063` and many other inline
  anchors throughout the legacy summary pages.
- **Detail:** Every "doesn't really need it" anchor still has an
  inline `onclick='top.restoreSession()'` to keep the session warm.
  CSP-unfriendly, hard to refactor, and drowns out real handlers.
- **Port note:** A single `fetch` interceptor on the new client can
  do the keep-alive once.

---

## B22. `pnotes_fragment.php?docUpdateId=…` mutates state via GET

- **Severity:** Bug (correctness/CSRF concern).
- **Where:** `pnotes_fragment.php` (mentioned in dashboard's auto-load
  flow).
- **Detail:** Marking a note "Completed" round-trips through the
  fragment with a `docUpdateId` *query parameter*, which performs a
  state-changing UPDATE. GET should be safe; this isn't.
- **Impact:** Anything that prefetches the URL (browser, security
  scanner) could inadvertently mark notes done. CSRF protection on a
  GET is also non-standard.
- **Port note:** Move to POST/PATCH on the new endpoint.

---

## B23. `setupI18n` failure is swallowed silently

- **Severity:** Smell.
- **Where:** `main.php:323-349`.
- **Detail:** If `library/ajax/i18n_generator.php` fails, the catch
  block logs the error to console and i18next is initialized with no
  resources. The page continues to render but every `xl()` call
  returns the key unchanged. There is no user-facing notification.
- **Impact:** Silent translation failure for non-English locales.
- **Port note:** Surface a banner; or block render until i18n is
  ready.

---

## B24. `default_open_tabs` realpath check is a security band-aid

- **Severity:** Smell.
- **Where:** `main.php:420-424`.
- **Detail:** The check `realpath($_unsafe_url) === false ||
  !str_starts_with($_unsafe_url, (string) $fileroot)` traverses the
  filesystem on every render. If the array contains a real path, this
  is a `stat()`-per-tab; the existence and prefix check is the only
  defense against a `default_open_tabs` payload pointing at
  `/etc/passwd`.
- **Port note:** The new app doesn't need this surface — it's a
  legacy mechanism for "log in, here are the tabs you had open last
  time".

---

## Out-of-scope notes

The following were called out in the W2 spec or surfaced in earlier
conversations and are **not** bugs in the legacy dashboard, but are
worth keeping a sticky note on:

- **The W2 spec asks for OAuth2 / OpenID Connect login.** The legacy
  dashboard has no such flow — it relies on session cookies. Implementing
  OIDC against the existing OpenEMR `oauth2/` module is its own work
  item, not a "fix" to the dashboard.
- **The OpenEMR FHIR API requires a SMART app registration** for some
  scopes. Make sure the registration is in place before declaring
  port parity.
- **`OEGlobalsBag` typed getters** (the project's own coding standard)
  are not used consistently in the dashboard chain — there are still
  raw `OEGlobalsBag::get('...')` calls scattered through. We should
  not "fix" these on the way through (per the no-repo-wide-reformat
  feedback in CLAUDE.md), but the new code we write should use the
  typed getters.
