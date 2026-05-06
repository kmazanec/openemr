# Framework & Integration Options for the Dashboard Port

> **Purpose.** This is the decision document the W2 spec asks for in
> `PATIENT_DASHBOARD_MIGRATION.md` — but cast as a survey of options
> rather than a single committed answer, so we can argue tradeoffs
> before locking in. It pulls from:
>
> - The W2 brief in `docs/AgentForge — Clinical Co-Pilot W2 — Surprise Challenge_ Modernize the Patient Dashboard.pdf`.
> - The audit artifacts in this folder (`01`-`05`).
> - A first-hand read of OpenEMR's OAuth2/OIDC/SMART implementation
>   (`src/RestControllers/AuthorizationController.php`,
>   `src/Common/Auth/OpenIDConnect/`,
>   `src/RestControllers/Subscriber/CORSListener.php`,
>   `apis/routes/_rest_routes_fhir_r4_us_core_3_1_0.inc.php`).
> - Current (Jan 2026) external research on SPA frameworks, FHIR
>   client libraries, and OAuth2 best practices for browser apps.

The brief's hard requirements are: OIDC login, persistent patient
header, the five required clinical cards (Allergies, Problem List,
Medications, Prescriptions, Care Team), and one optional section.
Everything goes through the **existing** REST/FHIR API; the backend
is off-limits.

---

## 1. What OpenEMR's auth server actually gives us

These facts shape every other decision below, so we confirm them up
front instead of assuming.

| Capability | Status | Where |
|---|---|---|
| Authorization-code grant **with PKCE** | ✅ Required for public clients | `CustomAuthCodeGrant.php:53,245-268` |
| PKCE methods | **S256 only** (per SMART spec) | `CustomAuthCodeGrant.php:53` |
| Public-client (no secret) registration | ✅ — `is_confidential = 0` when secret is empty | `ClientRepository.php:55,79` |
| Refresh-token grant | ✅ | `AuthorizationController.php:719-728` |
| Refresh-token rotation | ✅ (League OAuth2 default) | inferred from `CustomRefreshTokenGrant` |
| Implicit / hybrid flow | ❌ | Not registered |
| Dynamic client registration (RFC 7591) | ✅ | `AuthorizationController.php:244-392`, route `/oauth2/{site}/registration` |
| Manual client registration UI | Limited — `/interface/smart/register-app.php` (SMART-only) | (no admin "API clients" page) |
| `.well-known/openid-configuration` | ✅ | `OAuth2AuthorizationListener.php:129` |
| `.well-known/smart-configuration` | ✅ | `_rest_routes_fhir_r4_us_core_3_1_0.inc.php:821`, `SMARTConfigurationController.php` |
| JWKS endpoint | ✅ | `/oauth2/{site}/jwk` |
| Scopes accepted | `openid`, `profile`, `email`, `fhirUser`, `launch`, `launch/patient`, `offline_access`, `online_access`, `api:oemr`, `patient/*.*`, `user/*.*`, `system/*.*` | `ScopeRepository.php` |
| Token format | JWT bearer | `BearerTokenAuthorizationStrategy.php:327` |
| Patient-context binding under `launch/patient` | Stored **server-side** in `api_token.context`, not in JWT claims; surfaced on the `/token` response body | `AccessTokenRepository.php:74-76`, SMART app launch §6.4 of the spec |
| Token TTLs (hardcoded) | access **1h**, refresh **3 months**, auth code **1m**, client-creds token **5m** | `AuthorizationController.php:99-106,703` |
| FHIR API auth model | Bearer-token only — **no session cookie required** | `BearerTokenAuthorizationStrategy.php:258` |
| CORS | Reflects the request's `Origin` header back as `Access-Control-Allow-Origin`, `Allow-Credentials: true`, allows `Authorization`, `Content-Type`, etc. **No origin allow-list.** | `CORSListener.php:50-90` |
| Apps using `launch` / `launch/patient` | Require admin to flip `is_enabled` after registration | `ClientEntity.php:35-39` |

Three implications worth calling out, because they overturn a couple of
defaults from generic SPA-OIDC writeups:

1. **The FHIR API doesn't need a session cookie.** That collapses one of
   the usual "do I need a BFF to share cookies?" arguments. A pure SPA
   that holds a bearer token can talk to `/fhir/*` directly.
2. **CORS is open by default.** Any origin gets a reflected
   `Access-Control-Allow-Origin`. That's deliberate (the source comment
   says so) but lax for production. **We should never rely on this for
   security**; it makes browser-direct calls *possible*, but if the W2
   port is to be defensible, we should at minimum operate same-origin.
3. **Patient context for `launch/patient` is delivered in the token
   response body, not in the access token.** Whatever we use as an OIDC
   client must capture and persist `response.patient`, not just the
   tokens.

---

## 2. The decision space

Five orthogonal choices we have to make. Naming them up front so we can
keep the tradeoff discussion clean.

| Axis | Options |
|---|---|
| **A. Framework** | Vite + React 19, Next.js 15 (App Router), React Router v7 framework mode, TanStack Start v1, SvelteKit 2, Vue 3 + Nuxt 3, Angular 20+, Astro 5 |
| **B. Deploy mode** | (1) Static bundle inside Apache under `/dashboard/`, (2) Node SSR/SSG server reverse-proxied behind Apache, (3) Off-host CDN (Vercel/Netlify) calling OpenEMR cross-origin |
| **C. Integration point** | (i) Replace just the body of the `pat` tab inside `interface/main/tabs/main.php`, (ii) Live alongside the legacy SPA shell as a sibling tab, (iii) Top-level replacement (own the chrome) |
| **D. Auth model** | (a) Browser-direct OIDC + bearer token in memory, (b) BFF (PHP shim) holds tokens, (c) BFF (Node sidecar) holds tokens |
| **E. Data layer** | TanStack Query v5, SWR, RTK Query, Apollo (no — we're not GraphQL), or framework-native (RSC fetch / Nuxt useFetch / SvelteKit load) |

Choices interact: a static-Apache deploy (B1) means same-origin and the
SPA can talk to `/fhir/*` directly with a bearer token (D-a). A
cross-origin Vercel deploy (B3) makes OpenEMR's wide-open CORS the only
defense, which we should not lean on for production.

---

## 3. Axis A — framework

### Top contenders

#### React 19 + Vite 6 (pure SPA)

- **What it is.** Vite-built static bundle. No SSR, no edge runtime, no
  RSC mental model. Pair with TanStack Query v5 for FHIR fetching and
  TanStack Router or React Router for client routing.
- **Why it's a strong default for this project.** The legacy code already
  has React-shaped patterns (Knockout view models map cleanly to
  components; the audit's `01-feature-map.md` cards map cleanly to
  React components). Bundle is shippable as a folder of static files,
  which slots straight into Apache under `/dashboard/`. Bearer token
  in memory + `oidc-client-ts` is the well-trodden path. No server to
  operate.
- **Tradeoffs.** No SSR means a slightly slower initial paint than a
  server-rendered alternative; but the W2 audience is a clinician on a
  workstation hitting an internal LAN, not anonymous traffic. Bundle
  size is bigger than Svelte's, but well within budget for an
  authenticated app behind a login.
- **Hiring / continuity.** React 19 is the broadest hiring pool in the
  ecosystem.
- **Maturity.** Vite 6 + React 19 is the stable, boring choice in 2026.

#### Next.js 15 (App Router, Server Components)

- **What it is.** Full-stack React with RSC, server actions, and a Node
  runtime (or edge / static export).
- **Why we'd pick it.** The "FHIR-fetch-on-the-server, render to the
  client" pattern is a clean fit when paired with a Node BFF; tokens
  never reach the browser. Built-in `fetch()` deduplication is a free
  win for our many parallel resource reads.
- **Why we wouldn't.** Adds a second runtime to operate next to PHP-FPM;
  RSC's mental model for live-updating clinical data (lab results,
  reminders) is awkward — RSCs render once on the server, and anything
  reactive needs a `'use client'` island anyway. December 2025 saw a
  RSC-related DoS CVE patched in 19.1; the surface area is real. For
  our scope (one dashboard, one auth, one set of cards), Next.js's
  benefits don't compound.
- **Verdict.** Strong second choice; first choice if we decide we want
  a Node BFF anyway.

#### React Router v7 framework mode

- **What it is.** What used to be Remix, now folded back into React
  Router. Loaders + actions, optional server runtime, Vite-based.
- **Why we'd pick it.** Loader pattern matches FHIR perfectly: each
  route declares the resources it needs, the framework parallelizes
  fetches. Less RSC magic than Next.js.
- **Why we wouldn't.** The Remix→RR7 transition is recent (2024-25) and
  community ecosystem is in flux. Adoption is real but smaller than
  Next.js.
- **Verdict.** A respectable middle ground if we want SSR-flavoured
  data loading without committing to RSC.

### Honourable mentions

- **TanStack Start v1.** Stable, type-safe server functions, Vite-based.
  Smaller ecosystem; we'd be early adopters.
- **SvelteKit 2.** ~50% smaller bundles than React equivalents in
  published 2026 benchmarks. Real win for older clinic hardware.
  Counterargument: the FHIR-React ecosystem (Medplum components,
  fhir-client-react, sample SMART apps) has nothing equivalent in
  Svelte; we'd write more from scratch. Hiring pool is also tighter.
- **Vue 3 + Nuxt 3.** Mature; smaller FHIR-component story than React.
  No reason to pick it unless team preference dictates.
- **Angular 20+.** OpenEMR has Angular 1.8 in places, but the upgrade
  path is a full rewrite. Choosing Angular signals "we'd build other
  modules in Angular too"; for a one-off dashboard port it's
  overweight.
- **Astro 5.** Islands architecture is great for content-heavy pages
  with sparse interactivity. A clinician dashboard is the opposite —
  dense interactive data — so Astro forfeits its main advantage.

### Recommendation (axis A)

**React 19 + Vite 6** is the lowest-risk, highest-leverage choice. The
ecosystem (TanStack Query, Medplum components, oidc-client-ts) is
React-first; the deploy story is a flat folder of static files; the
mental model matches the audit's component decomposition.

If we discover we need server-rendered data (RSC) for performance
reasons during the build, Next.js 15 is the upgrade path; we'd lose
Vite-specific features but the React code travels.

---

## 4. Axis B — deploy mode

### B1. Static bundle under Apache (`/dashboard/`)

- **How.** `vite build` → copy `dist/` into the OpenEMR docroot at
  `public/dashboard/`. Apache serves the static files; an Apache
  `RewriteRule` sends sub-paths back to `index.html` for SPA routing.
- **Pros.** Same-origin (no CORS reliance). No new process to operate.
  No Node in production. Cookies/auth share the OpenEMR site. We can
  even reuse OpenEMR's TLS cert.
- **Cons.** No SSR, so first paint waits on JS. No edge caching
  beyond what Apache provides. Build artifacts have to be deployed
  with the OpenEMR release.
- **Fits with.** Vite + React 19 (or any static-export-capable
  framework). Paired with auth model D-a (browser holds bearer token).

### B2. Node sidecar reverse-proxied behind Apache

- **How.** A Node service on `localhost:3000` (Next.js, RR7, or a
  thin Express BFF). Apache proxies `/dashboard/*` to it via
  `ProxyPass`. The Node side can SSR pages, hold tokens, or just
  proxy FHIR calls.
- **Pros.** Tokens can stay server-side (auth model D-c). Full SSR.
  Edge-style streaming if we want it. Good place to add caching or
  audit logging in front of the FHIR API.
- **Cons.** Two runtimes to operate (PHP-FPM + Node). Process
  management, restarts, health checks. Deploys are no longer "drop
  files in `htdocs/`".
- **Fits with.** Next.js 15, RR7 framework mode, or a Node BFF in
  front of a Vite SPA.

### B3. Off-host SPA on Vercel / Netlify, cross-origin to OpenEMR

- **How.** SPA hosted on a separate origin; SPA hits OpenEMR's `/fhir/`
  directly across the network.
- **Pros.** Clean ops separation. Free hosting tier. CDN edge.
- **Cons.** Relies entirely on OpenEMR's reflective CORS — which the
  source explicitly flags as a `@TODO: review security implications`.
  Tokens land in the browser on a different origin from OpenEMR; cookie
  options like `SameSite=Strict` are unavailable. PHI traffic now
  crosses the public internet by design. **Don't ship this for a real
  clinic** without first locking down CORS to a known origin.
- **Fits with.** Demos, public marketing, hosted-eval scenarios. Not
  appropriate for production patient data.

### Recommendation (axis B)

**B1 (static bundle under Apache) is the right default for the W2
port.** It gives us same-origin auth, lowest ops surface, and the
fewest moving parts. If we later decide we need a BFF for token
isolation (axis D), we can introduce a thin PHP BFF (D-b, see §6)
without changing the deploy model.

---

## 5. Axis C — integration point

### C-i. Replace just the `pat` tab body

- **How.** Modify `interface/main/tabs/main.php` so that when the
  patient tab activates, its iframe loads `/dashboard/?pid=…` instead
  of `interface/patient_file/summary/demographics.php`.
- **Pros.** Smallest blast radius. The legacy SPA shell, top nav,
  hotkeys, search box, notifications, and other tabs (encounters,
  reports, etc.) all keep working. Users don't see a regression.
- **Cons.** We inherit every UX hazard from `03-ui-ux-flows.md`:
  hardcoded iframe names (`pat`, `enc`, `rev`, …), `top.set_pid`
  cross-frame calls, `dlgopen` style modals, `restoreSession()`
  pings. The new app has to play nicely with all of that.
- **Best for.** Incremental rollout. Lowest user disruption.

### C-ii. New sibling tab next to the legacy dashboard

- **How.** Add a `pat2` tab that loads the new dashboard; keep the old
  `pat` tab pointing at `demographics.php`. Users can A/B between
  them.
- **Pros.** Easiest rollback (just delete the new tab). Field-test in
  production without committing.
- **Cons.** Doubles the audit/QA surface during the transition. Two
  patient identities visible in two tabs is confusing.
- **Best for.** Pilot phase if we're nervous.

### C-iii. Top-level SPA, owns the chrome

- **How.** SPA hosted at `/dashboard/` becomes the entry point. We
  reimplement the top nav and tab strip in React; OpenEMR's
  `main.php` is bypassed for the dashboard flow.
- **Pros.** Clean break from Knockout, hardcoded iframe names, the
  whole legacy SPA shell. Best long-term fit.
- **Cons.** Massively expands W2 scope. We'd have to rebuild the
  global menu, search, user dropdown, notification dropdowns, hotkeys,
  and tab management. The brief explicitly says "you are not
  redesigning the interface" — owning the chrome is a redesign whether
  we mean it to be or not.
- **Best for.** A future, bigger initiative. Out of scope for W2.

### Recommendation (axis C)

**C-i for the W2 deliverable; C-iii is the future state.** The brief's
parity standard rules out C-iii. C-i lets us hit parity for the
required cards while leaving the legacy plumbing intact.

For C-i to work cleanly, we need to know where the iframe gets the
`pid` from and how it tells the parent shell when the patient changes
(see §7 on integration glue).

---

## 6. Axis D — auth model

This is the most consequential decision and the one our research
flips against the textbook recommendation.

### Background

The current best-practice answer (per IETF
draft-ietf-oauth-browser-based-apps-26) is **don't store tokens in
the browser if you can help it**. Use a BFF that holds tokens
server-side and gives the browser an httpOnly cookie. The reason: any
XSS on the SPA can exfiltrate any token reachable from JavaScript.
This is the right baseline assumption.

But: the BFF assumes you don't already have a way to share auth with
the backend. We do — same-origin under Apache. So the question is
*which* server holds the token, not whether one of them does.

### D-a. Browser holds the bearer token (in memory)

- **Library.** `oidc-client-ts` + `react-oidc-context`. Authorization
  code + PKCE. Tokens kept in memory (or `sessionStorage` if we want
  them to survive a tab reload — XSS risk increases).
- **Pros.** Simplest. No new server-side code. Fits B1 cleanly.
- **Cons.** Any XSS = full PHI compromise. The SPA is rendered
  same-origin under OpenEMR, so a stored-XSS bug *anywhere* in the
  legacy OpenEMR codebase that lands script in our origin can read
  the token. We have an entire legacy codebase next to us.
- **Mitigations.** Strict CSP (`script-src 'self'` + nonces), sealed
  bundle, no inline scripts, no `eval`. Realistic against the legacy
  app's inline-`<script>` pattern? Not without work.

### D-b. PHP BFF inside OpenEMR

- **How.** Add a small PHP module under
  `interface/modules/custom_modules/oe-module-clinical-copilot/` (we
  already have one) that exposes:
  - `POST /…/auth/login` — kicks off the OIDC code exchange
    server-side and stores the access/refresh tokens in PHP session
    storage.
  - `GET /…/fhir/*` — proxies to OpenEMR's `/fhir/*` using the
    server-stored bearer token, after checking the SPA's session
    cookie.
- **Pros.** Tokens never enter the browser. CSRF + SameSite cookies
  carry the auth instead. Same origin, same TLS, same admin surface.
- **Cons.** The proxy is one more piece of code to maintain. Latency
  is one extra hop (PHP → Apache → PHP). The audit catalogued PHP
  smells we don't want to add to.
- **Honesty about novelty.** OpenEMR's existing custom-modules
  scaffolding (Symfony routes + controllers) is well-trodden. The
  proxy pattern is ~150 lines.

### D-c. Node BFF

- Same as D-b but in Node, alongside option B2. Same pros/cons except
  we operate Node now.

### Recommendation (axis D)

**D-a for the W2 deliverable, with the door open to D-b later.**
Reasoning:

1. We're building an authenticated-only app behind OIDC. The XSS
   threat is real but not infinite — the OpenEMR origin has been
   security-reviewed for years and the dashboard surface we own is
   small.
2. The W2 brief specifically calls out OAuth2/OIDC. The "textbook"
   browser-based-apps recommendation is a BFF, but it's a *guidance
   draft*, not a rule. Many production SMART-on-FHIR apps hold
   bearer tokens in memory.
3. We can ship D-a in days; D-b adds a week of infra work that
   doesn't earn parity points.
4. D-b stays available as a follow-up if a security review demands
   it. The SPA's data-fetching layer should be written behind a
   single `fetch` wrapper so swapping the auth model later is one
   file's work.

What we **must** do under D-a:

- Use `oidc-client-ts` + `react-oidc-context`. PKCE S256 enforced.
- Tokens in memory only. **No localStorage.** SessionStorage only if
  we accept the F5-survives tradeoff after a security review.
- Refresh-token rotation. (OpenEMR supports it.)
- Strict CSP on `/dashboard/`. No inline scripts, nonced styles,
  `script-src 'self'`.
- Register the SPA as a public client via DCR
  (`/oauth2/{site}/registration`). Capture the `client_id` and store
  it in build-time config — no secret needed because public.
- Capture the `patient` field from the token response (not just the
  tokens) — see §1; SMART patient context lives there.

---

## 7. Integration glue (axis C in practice)

If we go with C-i (iframe in the `pat` tab) the new SPA needs to
interop with the SPA shell at exactly two points:

1. **Receive the patient context.** The shell calls
   `top.set_pid(pid)` today and the iframe page reads it. In the new
   world we have two options:
   - URL parameter: `/dashboard/?pid=…`. Simplest. Reload on patient
     switch.
   - `postMessage` listener: shell posts `{type: 'set_pid', pid}` to
     the iframe. Smooth in-place updates.
2. **Tell the shell when something dashboard-side changes.** Mostly
   for the patient identity strip's notification badges (which the
   shell polls anyway, so we may not need to do anything).

The legacy `left_nav.setPatient(...)`,
`left_nav.setPatientEncounter(...)` etc. fire from *outside* the
dashboard (encounters frame, finder frame). We don't need to
reimplement them — they already exist; they just call into the
legacy SPA shell, which then sets the iframe URL.

Hazard: many legacy fragments (`pnotes_fragment.php` etc.) are
addressable from outside via `dlgopen('../patient_file/summary/...')`.
Our iframe doesn't expose those URLs, so anything that opens a modal
*against the dashboard* still goes to the legacy fragments. That's
fine for parity — the modal lives outside our React tree — but it
means the new SPA can't be the sole source of truth for, say, "did
the user mark a note done?" We'd need to listen for the modal's close
event and refetch. TanStack Query handles this trivially via cache
invalidation on focus/visibility change.

---

## 8. Axis E — data layer

For a React SPA against FHIR, **TanStack Query v5** is the safe
default. Reasoning:

- Built-in caching, dedupe, background refresh, stale-while-revalidate
  — all exactly what a clinician dashboard needs.
- Suspense support pairs with React 19 `<Suspense>` boundaries for
  per-card loading.
- Cache invalidation by query key, which maps cleanly to FHIR
  resource types (`['allergies', patientId]` etc.).

Alternatives:

- **SWR** is simpler but less feature-rich; we'd reach for TanStack
  Query within a week.
- **RTK Query** is excellent if we'd already chosen Redux. We haven't.
- **Apollo / urql** — irrelevant; FHIR is REST/JSON, not GraphQL.

For the FHIR types themselves, **`@medplum/fhirtypes`** gives us the
R4 TypeScript definitions without forcing us to use the rest of
Medplum. **`fhir-kit-client`** is a usable typed client; if it gets in
the way we drop down to plain `fetch`.

For the patient header and clinical cards, **`@medplum/react`**
provides battle-tested FHIR-aware components (PatientHeader,
ResourceTable, Allergies). We can adopt selectively — pull in the
ones that fit, write our own where Medplum's design language clashes
with whatever we settle on for visual style. The brief says we're not
redesigning, so matching OpenEMR's existing look is fine — but
nothing about Medplum components forces a particular skin.

---

## 9. Putting it together — three reference stacks

Three concrete combinations, ranked by how confident I am each one
ships W2 on time without later regret.

### Stack 1 — Vite + React (recommended)

| Axis | Choice |
|---|---|
| A. Framework | React 19 + Vite 6 + TypeScript |
| B. Deploy | Static bundle under Apache at `/dashboard/` |
| C. Integration | iframe in the `pat` tab |
| D. Auth | Browser-direct: `oidc-client-ts` + `react-oidc-context`, public client via DCR, PKCE S256, tokens in memory |
| E. Data | TanStack Query v5 + `@medplum/fhirtypes`; `@medplum/react` selectively |
| Routing | TanStack Router or React Router |

Why I lead with this:

- Smallest deploy and ops footprint.
- All five W2-required cards (Patient/Allergies/Conditions/MedicationStatement/MedicationRequest/CareTeam) have full FHIR coverage — see `04-data-model.md`.
- Optional "+1" can be Encounters / Vitals / Labs / Immunizations / Appointments — all covered.
- Same-origin makes the cookie/CORS argument moot.
- React + Vite + TanStack Query is the industry default in 2026; lowest hiring/onboarding risk.

Risks and mitigations:

- **Bearer token in memory under same origin as legacy code → XSS
  risk.** Mitigate with strict CSP and treat the existing OpenEMR XSS
  posture as a separate work item. Be explicit in
  `PATIENT_DASHBOARD_MIGRATION.md` that we accepted this tradeoff.
- **First paint isn't SSR'd.** Authenticated app on a LAN; not a
  meaningful UX issue.
- **CSP rollout could break legacy inline scripts on the same origin.**
  Scope the CSP to the `/dashboard/` path via Apache headers, not the
  whole site.

### Stack 2 — Next.js 15 + PHP-BFF-lite

| Axis | Choice |
|---|---|
| A. Framework | Next.js 15 App Router |
| B. Deploy | Node sidecar reverse-proxied behind Apache |
| C. Integration | iframe in the `pat` tab |
| D. Auth | PHP BFF: thin OIDC client in our custom module, session cookie to the SPA, FHIR proxy |
| E. Data | RSC fetch + TanStack Query for client-side mutations |

When I'd pick this:

- We expect the new dashboard to grow well beyond W2's scope and we
  want SSR / streaming as a baseline.
- We've decided up-front that bearer-in-browser is unacceptable.
- We have someone happy to operate Node next to PHP-FPM.

Why I don't lead with this:

- Bigger ops surface. Next.js cold-start, log shipping, restarts.
- RSC's mental model fights real-time clinical data — every card
  ends up `'use client'` anyway.
- Adds PHP code in a codebase we just audited for legacy PHP smells.
  Even ~150 lines of new PHP is movement in the wrong direction
  unless we have a separate reason to keep it.

### Stack 3 — SvelteKit static + browser auth

Same axes as Stack 1 but Svelte. Wins on bundle size by a wide
margin; loses on FHIR-React ecosystem (Medplum components, sample
SMART apps, hiring). Not wrong, but only worth it if performance is
a hard constraint and we're willing to write our own clinical
components from scratch.

---

## 10. Recommendation

Adopt **Stack 1 (Vite + React + browser-direct OIDC, deployed as a
static bundle under Apache, mounted as the `pat` tab body)** for W2.
Document the bearer-token-in-memory tradeoff explicitly in
`PATIENT_DASHBOARD_MIGRATION.md` (the brief asks for that document
anyway; this is one of the things it should defend). Plan Stack 2
as the upgrade path if a future security review asks for token
isolation, or if we extend the dashboard scope past one tab.

Concrete next steps once we agree:

1. Register a public client via
   `POST /oauth2/{site}/registration` with our redirect URI and the
   scopes we need (`openid fhirUser launch/patient offline_access
   patient/Patient.read patient/AllergyIntolerance.read
   patient/Condition.read patient/MedicationStatement.read
   patient/MedicationRequest.read patient/CareTeam.read` plus the
   "+1" card's scope). Have an admin flip `is_enabled` for the
   `launch` scope.
2. Decide the "+1" card. My pick: **Encounters** — full FHIR coverage,
   straightforward UI, and it pairs with the patient header
   ergonomically.
3. Stand up `interface/modules/custom_modules/oe-module-clinical-copilot/dashboard/`
   as the build target, with Apache rewrite rules for SPA routing.
4. Wire `oidc-client-ts` + a single `fhirFetch()` wrapper that handles
   token attach + refresh + 401 retry. Every card calls through it.
5. Write `PATIENT_DASHBOARD_MIGRATION.md` last, after we've actually
   built it — not as a pre-commitment.

---

## 11. Things this document is deliberately not

- A pre-commitment. I want disagreement before we start building.
- A redesign brief. The brief explicitly forbids redesign; UX parity
  is the standard.
- A schedule. That's the next document.
- A defense of the framework choice in the W2 grading sense — that's
  what `PATIENT_DASHBOARD_MIGRATION.md` will be, written from
  experience after we ship.
