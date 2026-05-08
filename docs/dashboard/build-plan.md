# Patient Dashboard — Build Plan

> Implementation breakdown for the W2 dashboard port. Each story is
> sized to be completable by one person or agent in one sitting. Tests
> are an implementation requirement of every story — write the failing
> test first, then make it pass. Cross-track blockers are called out so
> independent tracks can run in parallel.
>
> **Defended in:** [`PATIENT_DASHBOARD_MIGRATION.md`](../../PATIENT_DASHBOARD_MIGRATION.md)
> **Audit context in:** [`docs/dashboard-audit/`](../dashboard-audit/)

## How to use this doc

- **Tracks** are independent workstreams. Stories within a track are
  ordered by dependency.
- **Story IDs** look like `T1.4` — track 1, story 4. Use them in
  commit messages and PR titles.
- **Blockers** are listed inline. A story can start as soon as its
  blockers are done, regardless of which track they're on.
- **Acceptance** lists what "done" means. Every box must check before
  the story closes.
- **Open question** items must be answered before the story starts.
  Bring them to the user in the kickoff conversation for that story.

## Tracks at a glance

| Track | Theme | Story count | Blocks |
|---|---|---|---|
| **T0** | Pre-flight (open questions, dev environment) | 4 | T1, T2, T3, T4 |
| **T1** | Project scaffold + tooling | 7 | T2, T3, T4, T5 |
| **T2** | Auth + FHIR client | 4 | T4 |
| **T3** | Integration glue with legacy `main.php` | 5 | T6 |
| **T4** | Patient header + clinical cards (the FHIR data layer) | 7 | T6 |
| **T5** | Tab strip + legacy iframe hosting | 4 | T6 |
| **T6** | Polish, error handling, deploy | 5 | — |
| **T7** | Stretch goals (post-MVP) | 6 | — |

Total: 36 stories pre-stretch (30) + 6 stretch.

---

## Open questions (T0) — answer before building

These need the user's call before T1 can start. None of them are
research items I can resolve myself.

### T0.1 — OpenEMR install for dev — **RESOLVED**

- **Resolution.** Develop against the standard
  `docker/development-easy/` Docker Compose environment.
- **Resolution.** For the initial pass, the SPA shell is mounted
  at a **separate top-level path** (e.g. `main_v2.php` — a copy of
  `main.php` with the SPA mount swapped in). The legacy
  `main.php` is left alone. A top-level toggle (env var, or a
  manual menu link) lets us switch between the legacy shell and
  the new shell during development.
- **Resolution.** Once the new shell is stable, T3 (or a later
  story) flips the toggle so `main.php` itself uses the SPA. Until
  then, T3.1 targets the *copy* file, not the original.
- **Implication for the plan.** T3.1 is updated below: the work is
  to create `interface/main/tabs/main_v2.php` (or similar) as a
  copy and swap the SPA mount in there. The legacy `main.php` is
  not modified yet.

### T0.2 — OAuth2 client registration — **RESOLVED**

- **Resolution.** Manual registration via
  `POST /oauth2/{site}/registration` against the dev install. The
  returned `client_id` is dropped into `dashboard/.env.local` for
  dev, and into the production env for prod.
- **Resolution.** This **is** going to production, so production
  setup is in scope. We need:
  - A documented one-time registration step in
    `dashboard/README.md` (admin runs this against the prod
    OpenEMR install to register the dashboard client).
  - A `dashboard/.env.production.example` showing every var that
    needs to be set at deploy time.
  - The redirect URI is the production dashboard URL,
    e.g. `https://prod-host/dashboard/auth/callback`.
- **Implication for the plan.** Adds a small story to T6 (deploy)
  for production env documentation and verification.

### T0.3 — Squad-ACL FHIR enforcement — **DEFERRED**

- **Resolution.** Defer to T6.4 (the dedicated story for it). T1-T5
  can build without knowing the answer. T6.4 verifies before merge;
  if the FHIR layer leaks, we file upstream and decide on the
  ship/no-ship there.
- **Why it doesn't block.** The FHIR data the new dashboard reads
  is the same the legacy `demographics.php` page-level check would
  have hidden. Confirming the API enforces it is a one-test
  exercise; not knowing the answer doesn't change the build, only
  whether we ship.

### T0.4 — Tab inventory — **RESOLVED**

- **Resolution.** Don't pre-declare the inventory. The new SPA's
  tab strip is **menu-driven**: whatever the legacy menu fires via
  `loadFrame(id, name, url)` (intercepted by our shim, T3.3) opens
  as a tab. T5.3 already builds this.
- **Resolution.** All ~13 named tabs (`pat`, `enc`, `rev`, `pop`,
  `fin`, `cal`, `msg`, `gdg`, `gfn`, `por`, `msc`, `fax`, `sms`)
  should be **supported** if the menu opens them. Until we have
  real renderers per tab, each unknown name is a generic
  legacy-iframe shim — same `<LegacyIframeTab>` rendering whatever
  URL the menu passed.
- **Implication for the plan.** T5.1-T5.4 remain as-is. No
  hardcoded tab map; menu-driven.

---

## T1 — Project scaffold + tooling

Foundational; everything else depends on it.

### T1.1 — Initialize Vite + React + TS at `dashboard/` — **DONE**

- **What.** Create `dashboard/` at the repo root. Set up
  `package.json`, `vite.config.ts`, `tsconfig.json` (strict +
  `noUncheckedIndexedAccess`), `index.html`, `src/main.tsx`,
  `src/App.tsx` rendering "Hello dashboard".
- **Acceptance.**
  - [x] `cd dashboard && npm install && npm run dev` boots Vite,
        prints "Hello dashboard" at `http://localhost:5173/`.
  - [x] `npm run build` produces `dist/` with hashed JS/CSS bundles.
  - [x] TypeScript config has `strict: true` and
        `noUncheckedIndexedAccess: true`. A test asserts a typed
        array index returns `T | undefined` (proves the flag is on).
  - [x] `dashboard/README.md` lists `npm install`, `dev`, `build`,
        `test`, `e2e` commands.
- **Blockers.** T0.1.

### T1.2 — Wire Vitest + React Testing Library — **DONE**

- **What.** Add Vitest config and one passing component test for
  the `App` placeholder. Use Vite's native plugin path.
- **Acceptance.**
  - [x] `npm test` runs `App.test.tsx` and passes.
  - [x] `App.test.tsx` uses RTL's `render` and `screen.getByText`.
  - [x] CI script in `package.json` runs `tsc --noEmit && vitest run`.
- **Blockers.** T1.1.

### T1.3 — Wire ESLint + Prettier — **DONE**

- **What.** Standard React + TS ESLint config. Prettier for
  formatting. Hook them into `prek` so `git commit` runs them on
  staged `dashboard/` files only.
- **Acceptance.**
  - [x] `npm run lint` exits 0 on a clean tree.
  - [x] `npm run lint` fails on a deliberate violation
        (e.g. unused import).
  - [x] `prek run` on a staged `dashboard/` file runs ESLint.
  - [x] We do not lint files outside `dashboard/`
        (per the no-repo-wide-reformat convention).
- **Blockers.** T1.1.

### T1.4 — Wire Playwright for E2E smoke — **DONE**

- **What.** Install Playwright, set up `playwright.config.ts`. One
  smoke test that loads `http://localhost:5173/` and asserts the
  body renders. No browser auth flow yet — that comes in T2.
- **Acceptance.**
  - [x] `npm run e2e` runs the smoke test against a Vite dev server,
        passes.
  - [x] Test screenshots / traces on failure go to
        `dashboard/test-results/`, gitignored.
- **Blockers.** T1.1.

### T1.5 — `dashboard/dist/` vendoring + GitLab CI build job — **DONE (deviation)**

- **Deviation from the original plan.** We chose **not** to vendor
  `dashboard/dist/`. Source maps alone are ~900 KB per build and
  would churn on every PR. Instead:
  - `dashboard/dist/` stays gitignored.
  - `test:dashboard` builds the bundle in CI as a smoke test that the
    source compiles. (Originally we uploaded dist/ as a CI artifact
    too; that was dropped after the named-volume incident — see CI
    YAML comment at `test:dashboard`.)
  - Production rebuilds dist/ at deploy time inside a one-shot
    `node:22-alpine` container against the release tree (see T1.5b).
- **Acceptance (revised).**
  - [x] `.gitlab-ci.yml` has a `test:dashboard` job that follows the
        existing `test:agent` pattern (named volume, runs in a
        `node:22-alpine` container, gated by the `.test-rules`
        anchor — runs on MRs and on push to master).
  - [x] `node_modules` and `dist/` both ride on named volumes
        (`openemr-ci-dashboard-node-modules`,
        `openemr-ci-dashboard-dist`) so the container's root-owned
        writes never reach the gitlab-runner-owned bind mount.
  - [x] Both volumes are added to the `cache-prune` job's nuke list.
  - [x] `dashboard/README.md` documents the workflow.
  - [ ] ~~`dashboard/dist/` is committed~~ — superseded.
  - [ ] ~~Stale-dist diff check~~ — superseded (no committed dist
        to be stale).
  - [ ] ~~prek hook for src-without-dist~~ — superseded.
- **Blockers.** T1.1.

### T1.5b — Verify `infra/deploy.sh` ships the dashboard correctly — **DONE (deviation)**

- **Deviation from the original plan.** Because T1.5 dropped the
  vendored `dist/`, deploy.sh now has to **build** it. A new step
  was added (between symlink swap and openemr container recreate)
  that runs `node:22-alpine` against the release tree and produces
  `dashboard/dist/` in place. The flex entrypoint's source-rsync
  picks it up on container boot.
- **Acceptance (revised).**
  - [x] `infra/deploy.sh` builds `dashboard/dist/` inside a one-shot
        `node:22-alpine` container against `${RELEASE_DIR}` before
        the openemr container recreate.
  - [x] Named volume `openemr-deploy-dashboard-node-modules` caches
        the install across deploys.
  - [x] `dashboard/README.md` documents the production deploy flow.
  - [ ] Manual smoke after a real deploy: visit
        `https://emr.biograph.dev/dashboard/` and confirm the
        bundle loads.
- **Blockers.** T1.5, T1.6.

### T1.6 — Web-server config: SPA routing + CSP — **DONE**

- **Context.** Production has **two** layers in front of OpenEMR:
  Caddy at the public edge (TLS, security headers — see
  `docker/digitalocean/Caddyfile`) and Apache inside the openemr
  container. Dev (`docker/development-easy/`) is Apache only. We
  need the SPA-fallback rewrite at the Apache layer (it's the
  one that knows the filesystem) and the CSP at the Apache layer
  too (so it works in dev where Caddy doesn't exist; Caddy will
  pass it through unchanged in prod).
- **What.** Add the SPA-fallback rewrite + CSP header for
  `/dashboard/*` to OpenEMR's existing Apache config. Find the
  right include path — likely an `.htaccess` at the docroot or
  a config snippet picked up by the flex image. CSP starts as
  `Content-Security-Policy-Report-Only` per the migration doc;
  T6.5 flips to enforced after the integration cycle.
- **Acceptance.**
  - [x] In the dev Docker Compose env, hit
        `http://localhost:8300/dashboard/anything` — gets
        `dashboard/dist/index.html`. Static assets under
        `/dashboard/assets/...` are served directly (rewrite must
        skip files that exist).
  - [x] Response includes `Content-Security-Policy-Report-Only`
        header with the policy from
        `PATIENT_DASHBOARD_MIGRATION.md`.
  - [ ] In prod, the Caddy → Apache hop preserves the header. (We
        verify this in T1.5b's manual smoke, after we have
        something at `/dashboard/` to load.)
  - [x] No CSP `report-uri` configured yet — note in the doc that
        T6 may add one.
  - [x] The change is **additive only**. We don't touch existing
        Apache rules for legacy paths.
- **Blockers.** T0.1, T1.5.

---

## T2 — Auth + FHIR client

Owns OIDC handshake and the FHIR transport. No UI.

### T2.1 — Bootstrap fhirclient

- **What.** Install `fhirclient`. Create `src/lib/fhir.ts` exporting
  a single `client` getter that reads OIDC config from
  `import.meta.env` (`VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`,
  `VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_SCOPE`).
- **Acceptance.**
  - [x] Test: importing `client` with missing env vars throws a
        descriptive error, not silently returns `undefined`.
  - [x] Test: with env set, `client` returns a configured fhirclient
        instance.
  - [x] `dashboard/.env.example` lists the required vars.
- **Blockers.** T1.1, T0.2.

### T2.2 — Implement OIDC login + callback routes

- **What.** Two routes: `/login` initiates the auth code + PKCE flow
  via `FHIR.oauth2.authorize(...)`. `/auth/callback` handles the
  redirect via `FHIR.oauth2.ready()`. After successful auth, redirect
  to `/dashboard/patient/$pid` (pid from the SMART context).
- **Acceptance.**
  - [x] Test: visiting `/login` calls `FHIR.oauth2.authorize` with
        the right scopes.
  - [x] Test: visiting `/auth/callback` with mock fhirclient
        completion redirects to the patient route.
  - [x] Test: when the SMART token response includes a `patient`
        field, that pid lands in the URL.
  - [x] Manual smoke (Playwright): log in against the dev OpenEMR
        install, end on the dashboard with the pid in the URL.
        *Verified up to OpenEMR's provider login page* — automated
        Playwright drove `/login` → discovery → authorize redirect
        → provider login screen on 2026-05-07 against the dev compose
        stack. Manual login + callback round-trip is left as a one-off
        the human runs (we don't commit credential typing into a
        committed test).
- **Blockers.** T2.1, T0.2.

> **T2.2 architecture finding.** OpenEMR's
> `/oauth2/{site}/registration` endpoint overloads `application_type`:
> `"public"` → no client secret, auto-enabled if scopes are
> `patient/*` only; `"private"` → confidential client, generates a
> secret, requires admin approval. Use `"public"` for the dashboard.
> Also, `VITE_OIDC_ISSUER` is the **FHIR base URL**
> (`https://host/apis/{site}/fhir`), not the OAuth2 issuer URL —
> fhirclient runs SMART discovery off the FHIR base. Both points are
> documented in `dashboard/README.md` and
> `PATIENT_DASHBOARD_MIGRATION.md`.

### T2.3 — `useFhir()` hook

- **What.** A React hook that returns the authenticated fhirclient
  instance, or throws if not authenticated (caught by the global
  error boundary, redirects to `/login`).
- **Acceptance.**
  - [x] Test: hook returns the client when fhirclient has a session.
  - [x] Test: hook throws a `NotAuthenticatedError` when no session.
  - [x] Test: error boundary catches `NotAuthenticatedError` and
        renders a "redirecting to login" UI.
- **Blockers.** T2.1.

### T2.4 — `useFhirRequest` hook (no cache)

- **What.** A small hook around `client.request()` that handles
  loading/error states. No caching layer (per the doc — TanStack
  Query is a stretch goal). Returns `{ data, error, loading,
  retry }`.
- **Acceptance.**
  - [x] Test: hook calls `client.request()` once on mount.
  - [x] Test: `retry()` re-fetches.
  - [x] Test: 401 from fhirclient (refresh token failed) bubbles up
        as a typed `AuthExpiredError` for the auth boundary to
        handle.
  - [x] Test: types: `useFhirRequest<Patient>(url)` returns
        `data: Patient | undefined`.
- **Blockers.** T2.1, T2.3.

---

## T3 — Integration glue with legacy `main.php`

The cross-frame contract — shims for `top.*`, `left_nav.*`,
`dlgopen`. This is the *risky* track; do not ship without manual
integration testing.

### T3.1 — Create `main_v2.php` shell that mounts the SPA below the menu

- **What.** **Copy** `interface/main/tabs/main.php` to
  `interface/main/tabs/main_v2.php`. In the copy, replace the
  existing `attendantData` strip, tabs strip, and frames-display
  block (audit lines ~517-521) with `<div id="dashboard-root"></div>`
  plus the SPA's hashed bundle tags read from the Vite manifest.
  The copy keeps the menu, search, user dropdown, and notification
  dropdowns intact. The legacy `main.php` is **not modified** in
  this story.
- **What also.** Wire the OpenEMR login flow to redirect to
  `main_v2.php?token_main=...` instead of `main.php?token_main=...`
  when a `?v2=1` query string or a `OPENEMR_DASHBOARD_V2` env var is
  set. This is the "top-level toggle" between legacy and new shells.
  Until the toggle is set, OpenEMR keeps using `main.php` exactly as
  before.
- **Acceptance.**
  - [x] `interface/main/tabs/main_v2.php` exists, is a near-copy of
        `main.php` with the SPA mount swapped in.
  - [x] `main_v2.php` reads `dashboard/dist/.vite/manifest.json` and
        injects the right `<script type="module" src="...">` and
        `<link rel="stylesheet" href="...">` tags.
  - [x] PHPStan passes on `main_v2.php`.
  - [x] Toggle: `?v2=1` (or `OPENEMR_DASHBOARD_V2` env var) routes
        login to `main_v2.php`; absent, login still goes to `main.php`.
  - [x] Manual: with `?v2=1`, load the OpenEMR site, see the menu
        plus a blank SPA root. Without, the legacy dashboard
        renders normally.
  - [x] Audit B16 (mutating `default_open_tabs` while iterating)
        is left alone — we don't fix unrelated legacy bugs in this
        change.
- **Blockers.** T1.5, T1.6.
- **Future story (post-MVP).** Once T2-T6 are stable, a follow-up
  story in T6 (or T7) flips the default by editing `main.php`
  itself (or by deleting it and renaming `main_v2.php` →
  `main.php`). Until then, `main_v2.php` lives as a sibling.

### T3.2 — Implement `top.*` shims

- **What.** `src/lib/shims.ts` installs shims on `window` at SPA
  mount. Methods: `top.restoreSession`, `top.set_pid`,
  `top.clearPatient`. Each wires into the SPA's router.
- **Acceptance.**
  - [x] Test: calling `window.top.set_pid(123)` triggers a router
        navigation to `/patient/123`.
  - [x] Test: `window.top.clearPatient()` navigates to `/dashboard`
        and clears patient state.
  - [x] Test: `window.top.restoreSession()` POSTs to
        `/library/restoreSession.php` and resolves.
  - [x] Globals (`csrf_token_js`, `webroot_url`, `site_id_js`,
        `api_csrf_token_js`) are exposed on `window` from values
        injected by `main.php`.
- **Blockers.** T1.1.

### T3.3 — Implement `left_nav.*` shims

- **What.** Same module, more shims:
  `left_nav.setPatient(name, pid, pubpid, frname, dob)`,
  `setEncounter`, `setPatientEncounter`, `clearEncounter`,
  `loadFrame`, `loadFrame2`, `RTop.setLocation`. No-ops:
  `syncRadios`, `removeOptionSelected`.
- **Acceptance.**
  - [x] Test: each method exists on `window.left_nav` (or on
        `window` directly, matching legacy callers' lookups).
  - [x] Test: `setPatient` updates the URL via the router.
  - [x] Test: `loadFrame(id, name, url)` navigates the SPA to
        `/dashboard/legacy/$name?url=...`.
  - [x] Test: `RTop.setLocation(url)` matches `loadFrame` semantics.
  - [x] Test: no-op methods don't throw.
- **Blockers.** T3.2.

### T3.4 — Implement `dlgopen` shim

- **What.** Replace the legacy `dlgopen` with a Bootstrap-5-modal
  implementation that hosts an iframe of the requested URL. Match
  the legacy signature: `(url, target, w, h, modal, title, opts)`.
  Honor `opts.dialogId`, `opts.allowResize`, `opts.allowDrag`,
  `opts.onClosed`, `opts.type === 'iframe'`.
- **Acceptance.**
  - [x] Test: `top.dlgopen('http://...', '_blank', 800, 500)` opens
        a Bootstrap modal containing an iframe.
  - [x] Test: `opts.onClosed` (string or function) fires on modal
        close.
  - [x] Test: `opts.dialogId` sets the modal's id.
  - [x] Test: closing the modal via Escape or backdrop click fires
        `onClosed`.
  - [x] Manual: an existing legacy page (e.g. an encounter form)
        opens its own modals via `top.dlgopen` correctly.
- **Blockers.** T3.2.

### T3.5 — Patient context flow end-to-end — **DONE**

- **What.** Hook the shimmed `left_nav.setPatient` to the URL.
  Verify the patient finder's existing flow lands on the new
  dashboard with the right pid.
- **Implementation note.** T3.2-T3.4 built the shim modules but
  never installed them at boot. T5 added `src/lib/bootShims.ts`
  (`installShims()`) which wires `top.*`, `left_nav.*`, `RTop`, and
  `top.dlgopen` to the TanStack router + tabs store. App's
  `useEffect` calls `installShims` at mount time, so any iframe
  hosted in `main_v2.php` finds the shims on `window.top` immediately.
- **Acceptance.**
  - [ ] Manual: search a patient in the legacy patient finder, click
        the result, end on `/dashboard/patient/$pid` with that pid
        rendered in the dashboard's identity bar. (Run after merge,
        on the dev compose stack with `?v2=1`.)
  - [x] Test (Playwright): same flow scripted —
        `tests/e2e/patient-context.spec.ts` boots the SPA, calls
        `top.left_nav.setPatient(...)` from the page, asserts the
        URL becomes `/patient/$pid`. Vitest also pins the install
        layer in `src/lib/installShims.test.ts` (4 cases covering
        `set_pid`, `setPatient`, `dlgopen`, and `loadFrame`).
  - [x] Bookmark: copy the URL, open in a new tab, the same patient
        loads. (`/patient/$pid` is a real router path; the route
        component is wrapped in `RequireFhirSession`, which calls
        `FHIR.oauth2.ready()` at mount and recovers the SMART
        session from sessionStorage. Verified by routing tests in
        `src/routes/auth.test.tsx`.)
- **Blockers.** T3.3, T4.1, T5.1.

---

## T4 — Patient header + clinical cards

The FHIR data UI. Each card is a story.

### T4.1 — `<PatientHeader />` (the persistent identity bar) — **DONE**

- **What.** Card-shape component pinned at the top of the dashboard.
  Reads `Patient` via `useFhirRequest`. Renders name, DOB + age,
  sex, MRN, active-status badge.
- **Acceptance.**
  - [x] Tests written before the implementation, using
        `@medplum/fhirtypes` `Patient` mocks. Cover: full data,
        missing optional fields, deceased patient, inactive patient.
  - [x] Renders all five fields the W2 brief calls out.
  - [x] Loading state is a skeleton placeholder, not a spinner that
        shifts layout.
  - [x] Error state shows "Couldn't load patient — Retry" with a
        retry button that calls the hook's `retry()`.
  - [x] Bootstrap 5 classes; no `react-bootstrap`.
  - [x] Stays visible regardless of which tab is active. (The
        component lives in `PatientRoute`'s top region, above the
        card grid; tab strip below it lands in T5.)
- **Blockers.** T2.4.

### T4.2 — `<AllergiesCard />` — **DONE**

- **What.** Reads `AllergyIntolerance?patient={id}&clinical-status=active`.
  Renders allergen, severity, reaction, verification status. "View
  all" link to the legacy `stats_full.php?category=allergy`.
- **Acceptance.**
  - [x] Tests first, using fixture FHIR Bundles. Cover: empty,
        single allergy, multiple, missing fields.
  - [x] Title bar matches legacy "Allergies".
  - [x] Link to legacy edit page is plain `<a href>` — no router
        navigation.
  - [x] Per-card error boundary catches FHIR errors without blanking
        the dashboard. (Implemented as a card-level error/retry
        slot inside the shared `<Card>` shell — one failed FHIR
        call shows a retryable error in that card only. The React
        ErrorBoundary class for unrecoverable render errors lands
        in T6.1.)
- **Blockers.** T2.4, T4.1.

### T4.3 — `<ProblemListCard />` — **DONE**

- **What.** Reads `Condition?patient={id}&category=problem-list-item`.
  Renders title, ICD/SNOMED code, onset date, status. "View all"
  link to `stats_full.php?category=medical_problem`.
- **Acceptance.**
  - [x] Tests first. Fixture with active + resolved + multiple
        conditions; only active should render.
  - [x] Coding column shows the SNOMED display when present, falls
        back to ICD-10, falls back to text.
  - [x] Link to legacy edit page works.
- **Blockers.** T2.4, T4.1.

### T4.4 — `<MedicationsCard />` — **DONE (deviation)**

- **Open question — RESOLVED 2026-05-07.** OpenEMR's FHIR layer
  exposes **no** `MedicationStatement` scope at all (not under
  `patient/*`, `user/*`, or `system/*` — verified in the dev
  install's `.well-known/openid-configuration`). The only available
  resource for "currently-taking medications" is `MedicationRequest`.
  Inspection of `src/Services/PrescriptionService.php` shows OpenEMR
  splits its two legacy lists across `MedicationRequest.intent`:
  - `lists_medication` ("Medications" — the patient's current med
    list) → `intent=plan`
  - `prescriptions` (eRx-style) → `intent=order`
- **Deviation from the original plan.** The card reads
  `MedicationRequest?patient={id}&status=active&intent=plan`
  instead of `MedicationStatement`. T4.5 (`PrescriptionsCard`)
  reads the `intent=order` slice. The two cards stay distinct,
  matching the legacy dashboard's layout (no parity loss).
- **What (revised).** Reads
  `MedicationRequest?patient={id}&status=active&intent=plan`.
  Renders drug, dose, route, frequency. View-all link goes to the
  legacy `stats_full.php?category=medication` page.
- **Acceptance.**
  - [x] Open question above resolved before implementation
        started.
  - [x] Tests first. Fixtures cover dosed/undosed, with/without
        route.
  - [x] Display matches the legacy issue-card column ordering.
- **Blockers.** T2.4, T4.1.

### T4.5 — `<PrescriptionsCard />` — **DONE**

- **What.** Reads
  `MedicationRequest?patient={id}&status=active&intent=order`
  (the eRx slice — see T4.4 for the intent split). Renders
  prescription details. "Add prescription" link goes to
  `eRx.php?page=compose` if eRx is enabled, else to the legacy
  `controller.php?prescription&list&id=$pid` (matches the legacy
  conditional). The `erx_enable` flag is read from
  `window.erx_enable`, set by `main_v2.php` in the same
  `<script>` block that already injects `csrf_token_js`,
  `webroot_url`, etc.
- **Acceptance.**
  - [x] Tests first. Fixtures cover eRx-on (link → `eRx.php`)
        and eRx-off (link → `controller.php?prescription`).
  - [x] `main_v2.php` injects `window.erx_enable` from
        `OEGlobalsBag`. (Already in place from T3.1 — see
        `interface/main/tabs/main_v2.php` line ~176.)
  - [x] Card has a typed config helper that reads
        `window.erx_enable` once at module load and exposes it
        as a strongly-typed boolean (`src/lib/config.ts`,
        `isErxEnabled()`).
- **Blockers.** T2.4, T4.1, T3.1 (for the globals injection).

### T4.6 — `<CareTeamCard />` — **DONE**

- **What.** Reads
  `CareTeam?patient={id}&status=active&_include=CareTeam:participant`.
  Renders participant name, role.
- **Acceptance.**
  - [x] Tests first. Fixtures cover multi-participant teams,
        missing role displays, inactive participants.
  - [x] Practitioner names resolve from the participant references
        (`_include=CareTeam:participant` is requested; falls back
        to `member.display` whatever the server returns. If the
        server ignores `_include`, the card still works — it just
        shows whatever display the FHIR layer already inlined,
        rather than firing N+1 follow-up reads. We accept that
        trade rather than ship a guaranteed N+1).
- **Blockers.** T2.4, T4.1.

### T4.7 — `<EncountersCard />` — the guaranteed +1 — **DONE**

- **What.** Reads `Encounter?patient={id}&_sort=-date&_count=10`.
  Renders date, type, provider, reason. No click-through (legacy
  encounter open is out of scope for W2).
- **Acceptance.**
  - [x] Tests first. Fixtures cover empty, recent encounters,
        multi-page (`_count` truncated).
  - [x] Empty state ("No recent encounters") visually matches the
        empty state used by other cards (same `text-muted` paragraph
        rendered inside the shared `<Card>` shell).
- **Blockers.** T2.4, T4.1.

---

## T5 — Tab strip + legacy iframe hosting

The SPA's chrome below the patient header. Owns navigation between
the new dashboard tab and the legacy-iframe tabs.

### T5.1 — `<TabStrip />` component — **DONE**

- **What.** Renders a Bootstrap-5 tabs strip. Tabs are driven by
  an external `tabsStore` (a `useSyncExternalStore`-backed singleton
  in `src/lib/tabsStore.ts`) so the shim layer can drive it from
  legacy iframe callbacks without going through React hooks. The
  dashboard tab is special-cased; everything else is a legacy URL.
  **No cap on simultaneous tabs** (matches legacy behavior).
- **Acceptance.**
  - [x] Tests first. Cover: dashboard tab active, legacy tab active,
        switching tabs updates the URL (`tabsStore.test.ts` +
        `TabStrip.test.tsx`).
  - [x] Tabs keep their iframes mounted while inactive (so reopening
        is instant) but visually hidden via the `hidden` attribute.
        Trade the memory cost for the UX.
  - [x] No cap on number of open tabs. (Pinned by a 9-tabs test.
        If memory becomes an issue in real-world use, revisit as a
        follow-up — out of W2 scope.)
- **Blockers.** T1.1, T3.3.

### T5.2 — `<LegacyIframeTab />` component — **DONE (with carve-out)**

- **What.** Component that hosts a legacy URL in a sandboxed iframe.
  Sized to fill the tab content area.
- **Title-shim carve-out — DEFERRED to T6.1.** The original story
  bundled a `top.document.title` interception shim into T5.2. The
  current `LegacyIframeTab` ships without that shim — the title
  manager belongs alongside the global error/title boundary that
  T6.1 builds. Acceptance items below tagged *(deferred)* track
  back to T6.1.
- **Acceptance.**
  - [x] Tests first. Cover: renders an iframe with the right `src`,
        re-renders when URL prop changes.
  - [x] Iframe inherits the parent's session (same-origin via the
        sandbox `allow-same-origin` flag).
  - [x] iframe `sandbox` attribute allows same-origin, forms, and
        scripts but not popups (popups are handled by `dlgopen`
        shim — pinned in `LegacyIframeTab.test.tsx`).
  - [ ] *(deferred to T6.1)* `top.document.title = ...` from inside
        a legacy iframe is intercepted and routed to the SPA's
        title manager.
  - [ ] *(deferred to T6.1)* When the patient changes, the title
        updates within one render cycle.
- **Blockers.** T5.1, T3.2.

### T5.3 — Tab registry from `loadFrame` interception — **DONE**

- **What.** Don't hardcode the tab→URL map. The boot shim
  (`bootShims.ts`) bridges `ShimRouter.openLegacyTab(name, url)` to
  the tabs store *and* navigates the TanStack router to
  `/dashboard/legacy/$name?url=$url` so each tab is deep-linkable.
  A new `LegacyTabRoute` re-registers the tab from the URL when
  the user opens a bookmark cold.
- **Acceptance.**
  - [x] Tests first. Cover: `loadFrame('framecal', 'cal',
        '/interface/main/calendar/index.php')` opens the calendar
        tab with that URL (`installShims.test.ts`).
  - [x] If the same `name` is loaded twice with different URLs, the
        existing iframe navigates rather than rebuilding
        (`tabsStore.test.ts` pins the object-identity preservation
        across URL changes).
  - [x] First load of a name registers the tab in the strip; tabs
        persist across navigations until closed.
- **Blockers.** T3.3, T5.1, T5.2.

### T5.4 — Tab close + active-tab default — **DONE**

- **What.** "✕" on each tab closes it. Closing the active tab
  activates the next (or the dashboard if none). Closing the
  dashboard tab is a no-op (the dashboard is always present).
  **No persistence** of the open-tabs list across page reloads —
  legacy `default_open_tabs` (audit B16) is out of W2 scope and
  lives as a stretch story (T7.5).
- **Acceptance.**
  - [x] Tests first (`tabsStore.test.ts` covers the close-active,
        close-non-active, close-dashboard, and close-only-legacy
        cases).
  - [x] Closing a tab removes the entry from the store, which
        unmounts its iframe in `PatientShell` (the iframe is
        keyed by tab id; React drops the DOM node, freeing memory).
  - [x] Page reload starts with only the dashboard tab open
        (the store starts in its initial state on every fresh
        SPA mount; current patient context is preserved via the
        `/patient/$pid` URL).
- **Blockers.** T5.1.

---

## T6 — Polish, error handling, deploy

Pre-merge work. Don't ship without these.

### T6.1 — Global + per-card error boundaries

- **What.** `<ErrorBoundary />` at the SPA root for unrecoverable
  errors (renders "Something went wrong, refresh"). `<CardError />`
  wrapper used by every card so a single failed FHIR call doesn't
  blank the page.
- **Acceptance.**
  - [ ] Tests first. Cover: a child throws synchronously; child
        throws on render; FHIR error in a child.
  - [ ] Errors are logged via `lib/logger.ts`.
  - [ ] Recovery: per-card "Retry" calls back into the hook's
        retry function.
- **Blockers.** T2.4, T4.1.

### T6.2 — Auth-expiration redirect

- **What.** When fhirclient's silent refresh fails, catch
  `AuthExpiredError`, log out cleanly, redirect to `/login`.
- **Acceptance.**
  - [ ] Tests first. Mock fhirclient to reject refresh.
  - [ ] User sees a brief "session expired" toast, then is on
        `/login`.
  - [ ] Tokens are cleared from sessionStorage.
- **Blockers.** T2.2, T6.1.

### T6.3 — Logger module

- **What.** `src/lib/logger.ts` exports `logger.error/warn/info`,
  each emitting structured JSON to console. Single dependency
  point so we can swap to a real sink later.
- **Acceptance.**
  - [ ] Tests first. Cover: `logger.error(eventName, ctx)` calls
        `console.error` once with a JSON-shaped object.
  - [ ] No raw `console.*` calls anywhere else in `src/` (ESLint
        rule).
- **Blockers.** T1.1.

### T6.4 — Squad-ACL FHIR enforcement check (resolves T0.3)

- **What.** Manual + automated test that confirms the FHIR layer
  enforces patient-squad ACL the same way the legacy dashboard
  did. If it doesn't, file an upstream issue and decide whether to
  ship.
- **Acceptance.**
  - [ ] Test patient with a `squad` field set; user without that
        squad ACL.
  - [ ] FHIR `GET /fhir/Patient/$pid` returns 403 or 404 (not 200).
  - [ ] Documented finding in `docs/dashboard-audit/05-bug-catalog.md`
        B17 entry — promoted from "needs verification" to "verified
        OK" or "verified leak, upstream issue #X filed".
- **Blockers.** T2.1.

### T6.5 — CSP report-only → enforced flip

- **What.** Once T1-T5 are all integrated and tested, watch the
  CSP-report-only logs for unexpected violations from fhirclient,
  TanStack Router, or Bootstrap 5. Triage; flip to enforced.
- **Acceptance.**
  - [ ] One full integration test cycle with no unresolved
        report-only violations.
  - [ ] Apache config switched from
        `Content-Security-Policy-Report-Only` to
        `Content-Security-Policy`.
  - [ ] A regression test triggers the CSP and confirms a violation
        blocks rendering (proves enforcement is on).
- **Blockers.** T1.6, T6.1, all of T4 and T5.


## T6.6 - Bug List
- What. Various bugs the user found while testing

---

## T7 — Stretch goals (post-MVP)

Built only after T0-T6 are green. Each is a story; same TDD rule.

### T7.1 — TanStack Query as a cache layer

- **What.** Wrap `useFhirRequest` in TanStack Query. Resource-keyed
  cache, background refetch, per-card invalidation via query keys.
- **Acceptance.** Cards refetch on focus regain; modal-driven edits
  invalidate the relevant cache key; no double-fetching on
  re-render.
- **Blockers.** T2.4.

### T7.2 — Lab Results card (`<LabsCard />`)

- Same shape as `EncountersCard`; reads
  `DiagnosticReport?patient={id}&category=LAB&_sort=-date&_count=10`.

### T7.3 — Vitals card (`<VitalsCard />`)

- Reads `Observation?patient={id}&category=vital-signs&_sort=-date`.
  Flattens into a row-per-encounter view.

### T7.4 — Immunizations card (`<ImmunizationsCard />`)

- Reads `Immunization?patient={id}&_sort=-date`. Renders date,
  vaccine code, status.

### T7.5 — Persistent open-tabs (`default_open_tabs` parity)

- The legacy SPA persists each user's open tabs across logins
  (audit B16). Match that, or skip if the convention is unloved.

### T7.6 — Promote auth model to a BFF (security upgrade path)

- The migration doc commits to bearer-in-browser with strict CSP.
  If a future review asks for token isolation, this is the upgrade
  path: a thin PHP module that does the OIDC dance server-side and
  proxies FHIR. Out of scope for W2; documented here so the
  abstractions stay sized for it.

---

## Working agreements (cross-cutting)

- **TDD.** Every story's first commit is the failing test.
- **Type safety.** No `any` without an inline justification comment.
  Prefer `unknown` + type narrowing.
- **Bundle hygiene.** No new runtime dependency without a sentence
  in the PR description on why.
- **No repo-wide reformat.** Lint/format only files the story is
  already touching (per the project convention).
- **Commits.** Conventional Commits, scope `dashboard`. Story ID in
  the body: `Story: T4.2`.
- **Multi-commit work goes in a worktree** on a `feat/...` branch,
  not on master directly.
- **CSP report-only stays on** until T6.5 explicitly flips it.
