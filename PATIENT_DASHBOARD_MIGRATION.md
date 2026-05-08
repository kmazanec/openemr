# Patient Dashboard Migration — Framework Defense

This document defends the framework, deploy, integration, and auth
choices for the port of OpenEMR's patient dashboard from server-rendered
PHP to a modern client-side framework. Per the W2 brief, the dashboard's
UX is not changing; only the presentation technology is.

The audit that informs every decision below is in
[`docs/dashboard-audit/`](docs/dashboard-audit/) — feature map,
dependency map, UX flows, data model, bug catalog, and a framework
options survey. References to `01-feature-map.md`, etc. point at that
folder.

---

## Decision summary

| Axis | Choice |
|---|---|
| Framework | **React 19 + TypeScript, built with Vite 6** |
| Routing | **TanStack Router** (file-based, type-safe) |
| Data + auth | **fhirclient** (the SMART-on-FHIR JS client) running the **SMART EHR Launch** sequence — OpenEMR session implicit step 1, OIDC + PKCE + JWT for the rest |
| FHIR types | **`@medplum/fhirtypes`** (TypeScript types only, no runtime) |
| Client-side cache | **None for W2.** Each card fetches on mount. TanStack Query as a stretch goal if invalidation cost becomes painful. |
| Component library | **Bootstrap 5** classes directly. No `react-bootstrap`, no Tailwind, no Mantine. |
| Token storage | **fhirclient's defaults** — sessionStorage, in-browser. Compensated by strict CSP. |
| BFF | **None.** fhirclient was designed for browser-side use; introducing a BFF would defeat the point of picking it. |
| Deploy mode | **Static bundle served by Apache** at `/dashboard/`, same-origin with `/oauth2/*` and `/fhir/*` |
| Bundle location in repo | **`dashboard/`** at the repo root (top-level, not nested under `interface/modules/custom_modules/`) |
| Integration model | **PHP menu stays; SPA replaces everything below it.** The legacy `main.php` keeps rendering the top nav, search, user dropdown, notification dropdowns. Below that, our SPA renders the patient identity bar, the tab strip, and the active tab's content. |
| Legacy pages | **Hosted as iframes inside our SPA.** When a non-dashboard tab is active (Calendar, Message Center, Encounter, etc.), the SPA mounts the existing legacy page in an iframe. The dashboard tab itself is plain React, no iframe. |
| Cross-frame contract | **SPA shims the legacy `top.*` and `left_nav.*` methods on `window`.** Legacy iframes call into them as they always did; our shims translate the calls into router/state changes. |
| `dlgopen` | **SPA provides a `dlgopen` shim on `window`** that opens a Bootstrap 5 modal in the SPA. Legacy iframes calling `top.dlgopen(...)` get the modal hosted by us. |
| Patient context | **URL is canonical** (`/patient/$pid`). Shimmed `left_nav.setPatient(...)` writes to the URL; the router observes. Bookmarkable, back-button works. |
| Required clinical cards | Patient header, Allergies, Problem List, Medications (`MedicationStatement`), Prescriptions (`MedicationRequest`), Care Team |
| "+1" priority order | **Encounters → Labs → Vitals → Immunizations.** Encounters guaranteed; the rest as time permits. |
| Visual parity target | **"Close enough."** Same shapes, same density, same affordances; modern under the hood. Not pixel-for-pixel. |
| Test runner | **Vitest** + React Testing Library |
| E2E tests | **Playwright** for smoke tests (login flow, render dashboard, assert cards) |
| Lint / format | **ESLint + Prettier**, hooked into the existing `prek` pre-commit |
| TypeScript | **`strict: true` + `noUncheckedIndexedAccess`** |
| CSP | **Strict, path-scoped to `/dashboard/`**, report-only-first rollout |
| Logging | **Structured `console`** via a single `logger` module |
| Error handling | Global error boundary + per-card error boundary; fhirclient handles 401 refresh; per-card "Retry" on network failure |
| Release | **Build in CI, vendor `dist/` into git** — same shape as the rest of OpenEMR (no install-time transpile) |

The rest of this document defends each of those choices.

---

## Why React 19 + Vite

The single biggest constraint on this decision is that the change lands
in **OpenEMR**, an open-source project with a community of contributors
who maintain it well past whatever I commit. The framework that ships
the patient dashboard is the framework future contributors will be
asked to learn, debug, and extend. That argument dominates every other
one.

### Why React

OpenEMR's existing front-end already mixes Angular 1.8, jQuery 3.7,
Knockout 3, and Bootstrap 4. It is not a green field. The dashboard
port is the first piece of a longer modernization, and the framework
it picks will set the gravitational pull for what comes after.

React, in 2026, is what most contributors to a generalist OSS project
will already know. The contributor pool is the largest of any
framework. The healthcare-and-FHIR-specific component ecosystem
(fhirclient, `@medplum/fhirtypes`, the SMART-on-FHIR sample apps)
is React-first. Picking React means the dashboard is something a
contributor with no OpenEMR context can productively read on day one.

The real alternatives:

- **SvelteKit.** Real win on bundle size; published 2026 benchmarks
  put it ~50% smaller than React. Loses on contributor pool, on
  FHIR-React ecosystem, and on "what is the rest of OpenEMR going to
  use next." For an OSS module, optimizing for the contributor base
  is more important than optimizing for the bundle.
- **Vue / Nuxt.** Smaller community than React. No specific
  argument for it here.
- **Angular 18+.** OpenEMR has Angular 1.8 in places, but the
  upgrade path between 1.x and modern Angular is a full rewrite.
  Picking it would commit the whole project to Angular, which a
  one-tab port shouldn't do on the project's behalf.
- **Astro.** Islands architecture is the wrong shape for a dense
  interactive clinician dashboard.

### Why Vite (and not Next.js)

The next question after "React" is "React with what runtime?" The
two serious answers are **Vite** (pure SPA, static build) and
**Next.js** (Node server, App Router, optional RSC).

Vite wins for this port for four reasons:

1. **No new runtime to operate.** OpenEMR ships as a PHP/Apache
   monolith. Adding a Node sidecar to host Next.js means the project
   has two runtimes in production: PHP-FPM and Node. That is a
   meaningful operational change for every clinic running OpenEMR,
   not just for this PR. Vite's output is a folder of static files;
   Apache already knows how to serve those.
2. **The dashboard is authenticated and behind a LAN.** SSR's main
   benefit — sub-second first paint for cold, anonymous traffic —
   doesn't apply. The audience is a clinician who already logged in,
   on the clinic network. The SSR/RSC tradeoff space tilts the
   wrong way here.
3. **RSC fights real-time clinical data.** React Server Components
   render once on the server; anything reactive needs `'use client'`
   anyway. The audit's UX flow doc shows the legacy dashboard is
   mostly reactive: poll counters, fragment reloads after edits,
   modal close-event refreshes. A pure SPA matches that shape; RSC
   would force-fit it.
4. **A December 2025 RSC DoS CVE in React 19** is a reminder that
   the RSC surface is still maturing. For a healthcare app that
   doesn't need RSC, opting in to that surface is uncompensated
   risk.

What we give up by picking Vite: SSR-grade first paint, server
actions, edge streaming. Behind LAN auth, those don't matter enough
to pay for the operational complexity Next.js would add.

---

## What we gain by moving away from PHP

The brief asks specifically what we *gained*. The audit makes the
answer concrete.

1. **Component reuse.** The legacy dashboard renders ~25 cards
   ([`01-feature-map.md`](docs/dashboard-audit/01-feature-map.md)).
   Most are minor variations of the same shape: title bar, edit
   button, collapsible body, optional async load. In PHP/Twig today,
   each is its own template plus inline JS. In React, the shape is
   one `<Card>` component, shared.
2. **A single state model.** The legacy dashboard mixes Knockout
   observables (patient strip), jQuery (fragment reloads), inline
   `<script>` (per-card behavior), and `dlgopen` string callbacks
   (modal lifecycle). That's four overlapping mental models; React
   reduces them to one.
3. **Type safety on FHIR data.** `@medplum/fhirtypes` gives full
   R4 TypeScript definitions. Server-side PHP has no equivalent —
   `sqlQuery` returns `array<string,mixed>` in PHPStan level 10's
   eyes. The TS compiler catches `patient.birthDate` (correct) vs
   `patient.birthdate` (wrong) at build time.
4. **Static analysis.** ESLint + TypeScript catch unused state,
   missing dependencies, prop mismatches, dead code. The legacy
   dashboard has 24 documented bugs/smells
   ([`05-bug-catalog.md`](docs/dashboard-audit/05-bug-catalog.md));
   about a third would be flagged by linting in the new stack.
5. **Test ergonomics.** Vitest + React Testing Library run on the
   host without Docker, in milliseconds per test. The legacy
   dashboard's testing story is integration-only via the OpenEMR
   E2E suite — a heavy hammer for unit-level concerns.
6. **Rendering predictability.** The legacy dashboard relies on
   document-relative URLs, hardcoded iframe names, CWD changes
   during render, and inline scripts that re-bind on every fragment
   reload (audit B6/B7/B8/B13/B20). None of those translate; the new
   dashboard has one absolute route, one component tree, and one
   transport layer.

The gains are real. They are also the gains of *moving to any
modern component framework with a typed data layer*; they are not
unique to React. The framework choice defends *which* modern stack
is best for OpenEMR's OSS context.

---

## What we lose / what's harder now

Equally honest about what gets harder in the new stack.

1. **Module extension points.** The legacy dashboard fires ~18 PHP
   events that 3rd-party modules listen to in order to inject cards
   or wrap existing cards
   ([`02-dependency-map.md`](docs/dashboard-audit/02-dependency-map.md)
   §7). The new SPA cannot listen to PHP-side events. If a clinic
   depends on a module that does, the new dashboard breaks it for
   that one tab. This is the single most defensible reason for a
   clinic to keep running the legacy dashboard alongside the new
   one.
2. **No Twig template inheritance.** Modules that override
   `patient/card/allergies.html.twig` to inject custom markup will
   not affect the new dashboard.
3. **Auto-fired CDR popups.** The legacy dashboard auto-fires a
   reminder popup and a birthday popup via hidden anchors that PHP
   conditionally renders (audit B10). The new dashboard doesn't
   replicate this; if a clinic relies on it, it'll need to be
   re-added later as a card or banner.
4. **The Smarty/Twig prescription bridge.** The legacy Rx card
   buffers a Smarty controller's HTML into a Twig template (audit
   B6). The new dashboard reads from `/fhir/MedicationRequest`
   directly. That means the new card has read-only parity but does
   not call into the eRx submission flow. For W2 (display-only
   parity) this is fine; if anyone expected the new card to also
   *prescribe*, it doesn't.

These are honest losses, not nuisances. The defense is: the W2
brief asks for parity on the dashboard cards, not for parity on
every legacy feature.

---

## Integration architecture

This is the part the brief left to us — "Own both" the framework
and the UX — and it's where the architecture earns its keep.

### What stays as PHP

`interface/main/tabs/main.php` keeps rendering the top nav: the
logo, the main menu (Patient / Fees / Modules / Admin / Reports /
Misc), the global search box, the user dropdown, and the
notification dropdowns. We don't reimplement that. The menu is
data-driven by `MainMenuRole::getMenu()` with ~600 menu items
gated by ACL and module event hooks; rebuilding it in React is its
own multi-day project that doesn't earn W2 grade points.

### What our SPA replaces

Everything below the menu:

- The patient identity bar (today: `#attendantData` Knockout strip)
- The tab strip (today: `tabs_view_model.js` Knockout)
- The active tab's content (today: an `<iframe>` per tab)

The SPA mounts into a single `<div id="dashboard-root">` that
`main.php` renders below the menu. Vite emits a hashed JS bundle
and CSS bundle; PHP reads a manifest and emits the right `<script>`
and `<link>` tags.

### How tabs work in the new model

Our SPA owns tab state in TanStack Router. Each tab is a route:

- `/dashboard/patient/$pid` — our new React dashboard (no iframe)
- `/dashboard/calendar` — legacy `interface/main/calendar/index.php` in an iframe
- `/dashboard/messages` — legacy `interface/main/messages/messages.php` in an iframe
- `/dashboard/encounter/$eid` — legacy encounter form in an iframe
- ...etc.

The dashboard route renders plain React. Every other route renders
an `<iframe>` with the appropriate legacy URL. Same iframe model
the legacy app uses today; just hosted by our SPA instead of by
`main.php`.

This is the central design move. The brief's "no redesign" clause
is satisfied because the *interface model* — top menu, tab strip,
identity bar, per-tab content — is preserved. The implementation of
that model is now React; the legacy pages still run in their native
environment whenever a non-dashboard tab is active.

### Cross-frame contract

The legacy code is written assuming `top` is the legacy SPA shell.
Audit `02-dependency-map.md` enumerated the methods legacy iframes
call up to `top` and `left_nav`:

- `top.restoreSession()`
- `top.set_pid(pid)`, `top.clearPatient()`
- `left_nav.setPatient(name, pid, pubpid, frname, dob)`
- `left_nav.setEncounter(date, eid, frname)`
- `left_nav.setPatientEncounter(EncounterIdArray, EncounterDateArray, CalendarCategoryArray)`
- `left_nav.clearEncounter()`, `left_nav.removeOptionSelected(eid)`
- `left_nav.loadFrame(id, name, url)`, `left_nav.loadFrame2(...)`
- `left_nav.syncRadios()`
- `RTop.setLocation(url)`
- `top.dlgopen(...)`

In our architecture, **our SPA is `top`**. So our SPA installs shims
for each of these on `window` at startup. The shims translate
legacy calls into router/state changes:

- `restoreSession()` — `fetch(/library/restoreSession.php)`. No-op shim, just keeps the session warm.
- `set_pid(pid)` / `setPatient(...)` — `router.navigate({ to: '/dashboard/patient/$pid', params: { pid } })`.
- `clearPatient()` — `router.navigate({ to: '/dashboard' })`, clear patient state.
- `setEncounter(...)` / `setPatientEncounter(...)` — update SPA encounter context.
- `loadFrame(id, name, url)` — `router.navigate({ to: '/dashboard/legacy/' + name, params: { url } })`. The router opens the legacy URL in an iframe under `/dashboard/legacy/$name`.
- `RTop.setLocation(url)` — same translation, treats the URL as a tab navigation.
- `syncRadios()`, `removeOptionSelected(...)` — no-ops; their UI is the legacy left-nav frame, which we don't render.
- `dlgopen(url, target, w, h, modal, title, opts)` — opens a Bootstrap 5 modal in our SPA hosting an iframe with the URL. Legacy modals work without modification.

Globals the legacy pages read from `top` (`csrf_token_js`,
`api_csrf_token_js`, `webroot_url`, `site_id_js`) — our SPA exposes
these on `window` at boot, sourced from the same data PHP would
have set.

This is real work, but it's a defined surface. The audit listed
every method.

### Patient context flow

URL is canonical. `/dashboard/patient/$pid` is the source of
truth for which patient is active. The shimmed `left_nav.setPatient`
writes to the URL; the router observes the change and re-renders
the dashboard. Bookmarking and back-button work. Patient finder
calls into `left_nav.setPatient` as it always did; our shim
catches it.

---

## Why this works without an iframe for the dashboard tab

The dashboard is the one tab that's React-native. Every other tab
is hosted in an iframe of the corresponding legacy URL. That asymmetry
is deliberate:

- The dashboard is the part the brief asks us to port; the rest is
  not in scope. Putting the dashboard in an iframe of itself would
  add friction for nothing.
- Legacy pages running in iframes are running in *their* native
  environment — `Header::setupHeader` brings their own CSS, their
  own jQuery, their own `dlgopen` definitions. There's no
  cross-contamination with our React tree.
- The cross-frame shims we install on `window` (above) are the only
  surface that the legacy iframes interact with. That's bounded;
  every legacy `top.*` call has a documented shim.

---

## Auth — OAuth2 / OpenID Connect (SMART EHR Launch)

The brief requires OIDC login. OpenEMR ships its own OAuth2 / OIDC
authorization server (League OAuth2-based); I confirmed its
capabilities directly against the source.

We use the **SMART EHR Launch sequence** (not Standalone), because
the SPA is hosted inside `main_v2.php` — the user is already
authenticated to OpenEMR by the time the SPA's auth flow runs.
SMART defines this exact case: the EHR hands the SMART app a
short-lived `launch` parameter that carries the patient context, and
the OAuth server can issue an authorization code without a second
login screen because it trusts the existing session cookie. All the
defenses of the Standalone flow (OIDC + PKCE + JWT bearer tokens)
still hold; the only thing that goes away is the redundant credential
prompt.

### What we use

- **SMART EHR Launch sequence.** `main_v2.php` builds an opaque
  encrypted `SMARTLaunchToken` carrying the active patient's UUID
  and intent. When the SPA needs to authorize, it requests a fresh
  per-patient launch token from `interface/main/tabs/main_v2_launch.php`
  (a small same-origin endpoint protected by the legacy session
  cookie + `APICSRFTOKEN`). fhirclient passes that token plus the
  FHIR `aud` to OpenEMR's authorize endpoint. The OAuth server,
  recognizing the launch token + the existing OpenEMR session +
  the client's `skip_ehr_launch_authorization_flow` flag, issues
  an authorization code immediately.
- **Authorization code grant with PKCE (S256).** PKCE is enforced;
  S256 is the only allowed challenge method
  (`CustomAuthCodeGrant.php:53`). The SMART app launch spec
  mandates this; OpenEMR follows.
- **Public client.** The dashboard registers with no client secret.
  Use `application_type: "public"` in the registration payload —
  OpenEMR's `application_type` field overloads the public/
  confidential distinction (`"public"` → no secret, auto-enabled
  when scopes are `patient/*` only; `"private"` → confidential
  client, secret generated, requires admin approval).
- **Dynamic client registration.** OpenEMR exposes RFC 7591 at
  `/oauth2/{site}/registration`. The SPA auto-registers itself the
  first time it runs and caches the resulting `client_id` in
  `localStorage`. RFC 7591 doesn't take the
  `skip_ehr_launch_authorization_flow` flag, so an admin must
  enable it (and add the `launch` scope) on the registered client
  exactly once — see `dashboard/README.md` for the runbook.
- **Refresh-token rotation.** Refresh tokens have a 3-month TTL,
  access tokens 1 hour. fhirclient does silent refresh in the
  background; the user doesn't see token expiry.
- **Discovery.** `/oauth2/{site}/.well-known/openid-configuration`
  and `/fhir/.well-known/smart-configuration` at app startup — no
  hardcoded endpoint URLs. The SPA derives its OIDC config from
  `window.location.origin` so dev and prod work without per-env env
  vars.
- **SMART scopes** requested at startup:
  `openid fhirUser launch launch/patient offline_access patient/Patient.read patient/AllergyIntolerance.read patient/Condition.read patient/MedicationRequest.read patient/CareTeam.read patient/Encounter.read`.
  The `launch` scope is what enables the EHR Launch flow. We use
  `patient/*.read` rather than `user/*.read` because OpenEMR
  reserves `user/*` for confidential clients only;
  `patient/*` works for public clients and the SMART launch token's
  patient context binds the access token to the right record.
  `patient/MedicationStatement.read` is intentionally **not** in the
  set: OpenEMR's FHIR layer does not advertise that scope (verified
  against the dev install via `.well-known/openid-configuration`).
  The Medications card sources from `MedicationRequest?intent=plan`
  as a result; the build plan flags this.

### Why this works

A SMART **Standalone** launch would have required a second login
screen (OpenEMR's OAuth server has no shared-session view of the
core OpenEMR session by default). That's friction for no security
benefit — the user has already proven their identity to the EHR.
The EHR Launch sequence is exactly the SMART-defined answer to
that case.

A non-SMART, cookie-only design would have skipped the OAuth
infrastructure entirely. Tempting, but it gives up the "we used
the SMART-on-FHIR reference client" defense — which is the
strongest alignment story we have for an OSS port of *the SMART
reference EHR*. EHR Launch keeps fhirclient and the SMART contract
intact while removing the only piece of friction (the second
login).

### Why fhirclient

The library decision conflated three concerns: data fetching
transport, OIDC dance, and FHIR-specific session handling
(especially `launch/patient` patient-context capture, which OpenEMR
delivers in the token response body, not as a JWT claim).

`fhirclient` was specifically designed for this. It is the SMART
Health IT team's reference SMART-on-FHIR JS client. It handles the
PKCE flow, captures the patient context from the token response
correctly, refreshes silently, and exposes `client.request()` for
typed FHIR calls. One library does what would otherwise be three.

The alternative was a hand-wired stack:
`oidc-client-ts` for auth, plain `fetch` + a manual fhirContext
capture, and a separate cache layer. Workable, more flexible, but
three libraries to maintain and a custom OIDC integration that has
to get the token-response patient claim right.

For an OSS port of *the SMART-on-FHIR reference EHR*, "we used the
SMART-on-FHIR reference client" is a stronger story than "we wired
together three libraries."

### Why no BFF

The current best-practice draft for browser-based apps
(`draft-ietf-oauth-browser-based-apps-26`) recommends a
backend-for-frontend pattern: the SPA never sees an OAuth token;
the BFF holds tokens server-side. The reasoning is that XSS on the
SPA exposes any token reachable from JavaScript.

We considered the BFF pattern and chose against it for this port,
deliberately:

1. **OpenEMR's FHIR API is bearer-only.** It does not require a
   session cookie. The typical BFF benefit ("the SPA can't reach
   the API directly so the token has to live on the BFF") doesn't
   apply.
2. **A BFF means more PHP code.** The audit catalogs 24 bugs and
   smells in the existing PHP dashboard chain. Adding ~150 lines
   of new PHP to act as a token proxy adds to that surface in a
   codebase we're explicitly trying to step away from.
3. **fhirclient was designed to live in the browser.** Putting it
   behind a BFF means either running fhirclient in Node alongside
   PHP (a sidecar runtime, which we ruled out) or replacing it with
   PHP that re-implements the OIDC dance. Both options give up
   the "use the SMART reference client" defense we picked
   fhirclient for.
4. **The W2 audience is a clinician on a LAN behind auth.** The
   XSS surface is the OpenEMR origin. The threat is real but
   bounded by our compensating controls — strict CSP on
   `/dashboard/`, no inline scripts in our bundle, sealed Vite
   build, no third-party scripts loaded. That bounds the
   exploitable surface.

What we accept:

- Bearer tokens live in browser memory (via fhirclient's
  sessionStorage default). An XSS bug in our bundle would expose
  them. The CSP and the Vite build's no-inline-script behavior are
  the compensating controls.
- A future security review can promote this to a BFF; the abstractions
  are sized for that. fhirclient runs against an OIDC issuer URL,
  which in a BFF world becomes "the BFF instead of OpenEMR direct."
  One config change.

### CSP

Strict, path-scoped to `/dashboard/`:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  connect-src 'self';
  img-src 'self' data:;
  frame-ancestors 'self';
  object-src 'none';
  base-uri 'self';
```

- `script-src 'self'` — Vite's production build emits no inline
  scripts; we keep it that way (no `dangerouslySetInnerHTML` of
  scripts, no inline `<script>` in our `index.html`).
- `style-src 'self' 'unsafe-inline'` — Bootstrap and React both inline
  some style attributes; relaxing this for styles only is acceptable.
- `connect-src 'self'` — FHIR and OAuth on-origin only. Cross-origin
  network calls are blocked by the CSP.
- `frame-ancestors 'self'` — our SPA can be framed by `main.php` (the
  one place we want it). The legacy iframes we *host* are unaffected.
- Path-scoped. The legacy app is full of inline `<script>` (audit B21,
  B23); a strict CSP applied site-wide breaks it.
- Rolled out report-only first (`Content-Security-Policy-Report-Only`),
  watched for unexpected violations from fhirclient and TanStack Router,
  then flipped to enforced.

---

## Deploy mode — same-origin static bundle under Apache

`vite build` produces a `dist/` folder of static assets. They go to
`dashboard/dist/` at the repo root; Apache serves them at `/dashboard/`.

Why same-origin and not Vercel:

1. **CORS isn't a defense at OpenEMR's CORS layer.** The audit
   confirmed `CORSListener.php` reflects whatever `Origin` is sent
   back as `Access-Control-Allow-Origin` and includes
   `Access-Control-Allow-Credentials: true` — there is no origin
   allow-list (the source itself flags it as
   `@TODO: review security implications`). A cross-origin SPA would
   be relying on a CORS layer that the project itself flags as too
   lax. Same-origin avoids depending on it.
2. **TLS, session, audit logging, deployment are shared with
   OpenEMR.** One deploy, one cert, one log stream.
3. **Patient data on a third-party CDN is a HIPAA conversation we
   don't need to have.**

Apache config (sketch):

```apache
# SPA routing fallback
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^dashboard/(.*)$ dashboard/dist/index.html [L]

# Strict CSP scoped to the dashboard
<LocationMatch "^/dashboard/">
  Header set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
</LocationMatch>
```

`frame-ancestors 'self'` lets `main.php` host the SPA inside its
`<body>` without breaking.

---

## Required cards

The W2 brief lists Patient header, Allergies, Problem List,
Medications, Prescriptions, and Care Team. The audit
([`04-data-model.md`](docs/dashboard-audit/04-data-model.md))
confirmed all six have full FHIR coverage.

| Card | FHIR resource | Endpoint |
|---|---|---|
| Patient header | `Patient` | `GET /fhir/Patient/{id}` |
| Allergies | `AllergyIntolerance` | `GET /fhir/AllergyIntolerance?patient={id}&clinical-status=active` |
| Problem List | `Condition` | `GET /fhir/Condition?patient={id}&category=problem-list-item` |
| Medications | `MedicationStatement` | `GET /fhir/MedicationStatement?patient={id}&status=active` |
| Prescriptions | `MedicationRequest` | `GET /fhir/MedicationRequest?patient={id}&status=active` |
| Care Team | `CareTeam` | `GET /fhir/CareTeam?patient={id}&status=active` |

All read-only. Mutations stay on the legacy dashboard for W2.

---

## "+1" priority order

The brief lets us pick one of: encounter history, lab results,
vitals, immunizations, upcoming appointments, patient notes.

We commit to **Encounters** as the guaranteed +1, and pick up
**Labs**, **Vitals**, and **Immunizations** opportunistically if
time permits. Order:

1. **Encounters** (guaranteed). Full FHIR coverage. Clinically
   central — "show me the patient and their last 5 visits" is
   what the page is for.
2. **Lab results.** Full FHIR coverage via `DiagnosticReport`
   plus observation linking. Slightly more wiring than encounters.
3. **Vitals.** Full FHIR coverage via `Observation?category=vital-signs`.
   Needs flattening across observations; fiddly mapping.
4. **Immunizations.** Full FHIR coverage. Easy to render but less
   clinically central than the others.

Patient notes (`pnotes`) is **excluded** because it has no FHIR
coverage (audit `04-data-model.md` §9). Appointments is excluded
because the legacy card pulls past + recurrences which are harder
to match for parity than encounters.

---

## Visual parity target

"Close enough" rather than pixel-for-pixel. The dashboard preserves:

- Same number of columns at desktop widths
- Same card identity (allergies/problems/meds at the top, patient
  notes in the center, etc.)
- Same edit affordances and "view all" links per card
- Same information density per card (fields, counts, dates)

It does not preserve:

- Bootstrap 4 quirks (border-radius, exact padding, exact spacing)
- Legacy color scheme drift (some cards have inline color overrides)
- Per-card collapse-state persistence (we use sessionStorage, not
  the legacy `users_settings` round-trip)

A clinician opening the new dashboard sees the same information
in the same places. The implementation is modern; the page is not
redesigned.

---

## Build, test, and deploy details

### Toolchain

- **Build.** Vite 6, TypeScript 5.x, React 19.
- **Routing.** TanStack Router (file-based, type-safe params and
  search params).
- **Auth + transport.** fhirclient.
- **FHIR types.** `@medplum/fhirtypes` (no runtime weight).
- **Components.** Bootstrap 5 classes directly. We do not pull in
  `react-bootstrap`.
- **Tests.** Vitest + React Testing Library for unit/component
  tests; Playwright for smoke E2E (login flow, dashboard renders,
  cards populate from FHIR).
- **Lint / format.** ESLint + Prettier, hooked into the project's
  existing `prek` pre-commit. Linting runs only on staged files in
  `dashboard/`; we do not lint repo-wide (per the project's
  no-repo-wide-reformat convention).
- **TypeScript.** `strict: true` + `noUncheckedIndexedAccess`.
  FHIR `Bundle.entry[i]` is a real source of "I assumed it exists"
  bugs; `noUncheckedIndexedAccess` catches that class at compile
  time. Stricter flags (`exactOptionalPropertyTypes`) introduce
  noise without enough benefit for W2.

### Repository layout

```
dashboard/
├── src/
│   ├── routes/                    # TanStack Router file-based routes
│   ├── components/
│   │   ├── PatientHeader.tsx
│   │   ├── cards/
│   │   │   ├── AllergiesCard.tsx
│   │   │   ├── ProblemListCard.tsx
│   │   │   ├── MedicationsCard.tsx
│   │   │   ├── PrescriptionsCard.tsx
│   │   │   ├── CareTeamCard.tsx
│   │   │   └── EncountersCard.tsx
│   │   └── legacy/
│   │       └── LegacyIframeTab.tsx
│   ├── lib/
│   │   ├── fhir.ts                # fhirclient setup
│   │   ├── shims.ts               # window.top.* / left_nav.* / dlgopen shims
│   │   ├── logger.ts
│   │   └── errors.ts              # error boundaries
│   ├── App.tsx
│   └── main.tsx
├── tests/
│   ├── unit/
│   └── e2e/
├── dist/                          # vendored, refreshed in CI on PRs
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

### Build & deploy lifecycle

1. **Source.** `dashboard/src/` (TypeScript + Vite).
2. **Install.** `cd dashboard && npm install`.
3. **Dev.** `npm run dev` — Vite dev server on `:5173`. For the
   in-OpenEMR experience, point `main.php` at the dev URL via an
   env flag, or copy the served bundle into a temp dir Apache
   serves.
4. **Build.** `npm run build` — produces `dashboard/dist/`. CI
   fails on TypeScript or ESLint errors.
5. **Tests.** `npm test` runs Vitest; `npm run e2e` runs Playwright.
6. **Vendoring.** `dashboard/dist/` is committed to git. CI
   refreshes it on every PR that touches `dashboard/src/`. End
   users `git clone openemr/openemr` and the dashboard works
   without an install-time transpile, matching how the rest of
   OpenEMR ships.
7. **Client registration.** A one-time admin step against the
   target OpenEMR install: POST to `/oauth2/{site}/registration`
   with the dashboard's redirect URI (`/dashboard/auth/callback`).
   Capture the `client_id` and write it to
   `dashboard/.env.production` as `VITE_OIDC_CLIENT_ID`. No secret
   to manage (public client).

### Logging

A single `logger` module emits structured `console` entries:

```ts
logger.error('fhir.fetch.failed', { resource: 'AllergyIntolerance', patientId, status: 503 });
```

No external logging dependency for W2. Easy to swap to a real
sink later; every call site uses the module rather than raw
`console`.

### Error handling

- **Global error boundary** at the SPA root. Renders a "Something
  went wrong, refresh the page" UI and emits a structured log
  entry.
- **Per-card error boundary** wrapping each clinical card. A failed
  Allergies fetch shouldn't blank the whole dashboard.
- **401 handling.** fhirclient handles silent token refresh
  automatically. If refresh fails (refresh token expired, server
  rotated keys), redirect to the OIDC login.
- **Network failure.** Per-card "Couldn't load — Retry" UI with a
  manual retry button.

---

## Open questions / acknowledged risks

1. **Squad ACL enforcement** (audit B17). The legacy dashboard
   refuses to render for a patient whose `squad` the user doesn't
   have ACL access to. The check happens at the page level in
   `demographics.php`. I have not yet confirmed whether the FHIR
   layer enforces the same check. If not, the new dashboard will
   render data for patients the legacy dashboard would have
   hidden. **Action: verify before merge.**
2. **`viewPortalPayments` URL bug** (audit B1) and the
   `!empty(...) ?? null` parenthesis bug (audit B2) are in
   `main.php` and `user_data_view_model.js`, not in the dashboard.
   They survive the port unchanged. Filing them upstream is a
   separate item.
3. **CSP rollout scope.** The Apache config above scopes the CSP
   to `/dashboard/`. If a future change broadens it to the whole
   OpenEMR origin, dozens of legacy inline scripts will break. The
   CSP is deliberately path-scoped and we should not relax that.
4. **The `dlgopen` shim is a contract.** Legacy code calls
   `top.dlgopen(...)` from inside iframes and expects a working
   modal. Our shim has to handle every option the legacy code
   passes — `type: 'iframe'`, `dialogId`, `allowResize`,
   `onClosed`, etc. We expect to discover one or two we missed
   during integration testing; reserve a day for shim coverage.
5. **`left_nav` shim coverage.** Same risk shape: we have the
   audit's list of methods, but a clinic-specific module might
   call into `left_nav` with a less-common signature. Reserve
   half a day.
6. **fhirclient's session-storage default.** Tokens survive a
   tab refresh but not a browser close. If a clinician closes the
   browser mid-shift, they re-login on the next open. That's
   a UX cost we accept for the security benefit; if the team
   wants longer-lived sessions, fhirclient supports
   `localStorage` (worse XSS posture) or a custom storage adapter.

---

## Why this defense, not a different one

The W2 brief grades the defense, not just the build. The
defendable claims this document makes:

1. **React + Vite is the right framework for OpenEMR's OSS
   context.** Defended on contributor pool, FHIR-React ecosystem,
   and operational simplicity (no second runtime).
2. **fhirclient is the right auth + transport library for an
   OpenEMR port.** Defended on "it is the SMART-on-FHIR reference
   client, and OpenEMR is a SMART-on-FHIR-conformant EHR." Using
   the reference client is the strongest possible alignment.
3. **Same-origin under Apache is the right deploy.** Defended on
   the audit's discovery that OpenEMR's CORS layer is permissive
   by self-acknowledged design. Same-origin sidesteps depending
   on it.
4. **The "PHP menu + SPA below" integration model is the right
   compromise between the brief's "no redesign" clause and the
   brief's persistent-identity-bar requirement.** Defended on
   preservation of the interface model (top menu, tab strip,
   identity bar, per-tab content) while modernizing the
   implementation. The legacy iframes still run in their native
   environment for any tab we haven't ported.
5. **No BFF, with strict CSP as compensation.** Defended on the
   FHIR API being bearer-only (the BFF pattern's main benefit
   doesn't apply), and on fhirclient being designed for browser
   use (a BFF would defeat the purpose of picking it).

The choices we did *not* make and why:

- **Next.js / SSR.** Would add a Node runtime to operate next to
  PHP-FPM. The performance benefits don't apply to authenticated
  LAN traffic.
- **Off-host CDN deploy.** Would lean on OpenEMR's permissive
  CORS, which the project itself flags as too lax.
- **PHP BFF.** Would add new PHP to a codebase the audit just
  enumerated 24 bugs in.
- **Top-level chrome replacement.** Would cross into "redesign"
  territory and turn a one-week port into a multi-week chrome
  rewrite.
- **Pixel-for-pixel BS4 parity.** Would cost engineering time
  for no clinical benefit.

The framework decision is mine; the UX decision is mine. Both are
defended above. The trade I'd make again on every axis is the trade
I made.
