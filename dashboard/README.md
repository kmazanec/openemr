# OpenEMR Dashboard SPA

Modern patient-dashboard SPA for OpenEMR. Replaces the legacy
PHP/iframe dashboard rendered below `interface/main/tabs/main.php`.
The framework decision and integration architecture are defended in
[`PATIENT_DASHBOARD_MIGRATION.md`](../PATIENT_DASHBOARD_MIGRATION.md);
the story-by-story build plan lives in
[`docs/dashboard/build-plan.md`](../docs/dashboard/build-plan.md).

## Stack

- React 19 + TypeScript 5 (strict + `noUncheckedIndexedAccess`)
- Vite 6 (static SPA bundle, no Node runtime in production)
- Vitest + React Testing Library (unit/component)
- Playwright (smoke E2E)
- ESLint 9 (flat config) + Prettier

## Commands

The default workflow runs the build inside a docker container —
no host Node toolchain required. The `dashboard` service in
`docker/development-easy/docker-compose.yml` runs `vite build --watch`
in the background and writes `dist/` to the bind-mounted host tree;
the openemr container's docroot picks it up and Apache serves
`/dashboard/*` (T1.6).

```sh
# Once: start the dev stack (builds the dashboard image on first run).
cd docker/development-easy && docker compose up -d

# Tail the watcher's rebuild logs.
docker compose logs -f dashboard

# Hit the SPA via openemr's Apache.
open http://localhost:8300/dashboard/

# Ad-hoc commands inside the dashboard container.
docker compose run --rm dashboard npm test
docker compose run --rm dashboard npm run lint
docker compose run --rm dashboard npm run typecheck
```

Host-side commands also still work if you have Node 22+ installed
locally (`cd dashboard && npm install && npm run …`); the docker
service is the recommended path for day-to-day work because it
matches what CI and the production deploy do.

| Command            | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| `npm install`      | Install deps. First-time only.                              |
| `npm run dev`      | Vite dev server on http://localhost:5173/.                  |
| `npm run build`    | Typecheck + production build to `dist/`.                    |
| `npm test`         | Vitest, single run.                                         |
| `npm run test:watch` | Vitest, watch mode.                                       |
| `npm run typecheck`| `tsc --noEmit`. No emit; just type errors.                  |
| `npm run lint`     | ESLint over `dashboard/`. CI gate.                          |
| `npm run lint:fix` | ESLint with `--fix`.                                        |
| `npm run format`   | Prettier `--write`.                                         |
| `npm run format:check` | Prettier `--check`.                                     |
| `npm run e2e`      | Playwright smoke. Auto-spawns the Vite dev server.          |
| `npm run e2e:install` | One-time: `playwright install --with-deps`.              |
| `npm run ci`       | `tsc --noEmit && vitest run`. Mirrors the CI gate.          |

## Project layout

```
dashboard/
├── src/
│   ├── App.tsx                    # Wires the router and exports <App>
│   ├── App.test.tsx
│   ├── main.tsx                   # Vite entry
│   ├── lib/
│   │   ├── fhir.ts                # fhirclient + OIDC config (T2.1)
│   │   └── fhir.test.ts
│   └── routes/
│       ├── routeTree.tsx          # TanStack Router tree (code-based)
│       ├── login.tsx              # /login → FHIR.oauth2.authorize
│       ├── authCallback.tsx       # /auth/callback → FHIR.oauth2.ready
│       ├── dashboardLanding.tsx   # / and /dashboard placeholder
│       ├── patient.tsx            # /patient/$pid placeholder (T4 fills)
│       └── auth.test.tsx          # T2.2 unit coverage
├── tests/
│   ├── setup.ts                   # @testing-library/jest-dom registration
│   └── e2e/
│       └── smoke.spec.ts          # Playwright smoke
├── eslint.config.js
├── playwright.config.ts
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json                  # Solution-style: refs app + node configs
├── tsconfig.app.json              # `src/` + tests: strict, jsdom env
├── tsconfig.node.json             # config files (vite.config.ts, …)
└── README.md
```

> **Routing.** Routes are defined in code (`routes/routeTree.tsx`)
> rather than via TanStack Router's file-based plugin. Same library,
> same type safety, less generator churn for the small T2 route set.
> If/when the file count makes the code-based tree painful (T4–T5
> probably), a follow-up can migrate to file-based; the route
> components are already split per-file to keep that easy.

## Dev environment integration

The SPA is served at `/dashboard/` in production. `dashboard/.htaccess`
(T1.6) handles two things:

- Maps real files under `dashboard/dist/` to clean URLs at
  `/dashboard/*` (so the bundle's `<script src="/dashboard/assets/...">`
  resolves without leaking `dist/` into URLs).
- Falls through to `dashboard/dist/index.html` for any unknown path
  so TanStack Router can resolve it.
- Sets `Content-Security-Policy-Report-Only` per the policy in
  `PATIENT_DASHBOARD_MIGRATION.md`. T6.5 flips report-only to
  enforced after the integration cycle.

For local iteration, `npm run dev` is the canonical loop — the SPA
stands alone on `:5173` outside OpenEMR. Vite's `base` is set to
`/dashboard/` for production builds and to `/` for the dev server
(via `VITE_BASE=/` in `playwright.config.ts`'s webServer block).

`dashboard/dist/` is **not vendored**. It is built fresh on every
push and on every deploy:

```
git push to master
  → CI runs test:dashboard
      (lint, typecheck, vitest, vite build)
      → emits dashboard/dist/ as a pipeline artifact (1 week TTL)
  → CI deploy stage runs runner-bootstrap.sh
      → fresh git clone into /srv/openemr/releases/<sha>/
      → exec into infra/deploy.sh
          → builds dashboard/dist/ inside a node:22-alpine container
            against the release tree
          → openemr container's bind mount picks up dist/ automatically
  → Apache serves /dashboard/* off the new release tree
```

The CI artifact is for **inspection only** (download from the MR UI
to spot-check a build). The bundle that reaches production is the
one `deploy.sh` builds from the deploy SHA's source.

## SMART EHR Launch — auth setup

The dashboard is hosted inside `interface/main/tabs/main_v2.php`, so
the user has already authenticated to OpenEMR by the time the SPA
loads. We use the **SMART EHR Launch sequence** (not standalone): the
SPA hands the OAuth server an opaque `launch` token bound to the
active patient + the existing OpenEMR session cookie, and the OAuth
server issues an access token without prompting for credentials a
second time. Strict OIDC + PKCE + JWT bearer tokens; the only
difference from standalone is that step 1's "log in" is implicit
because the user is already in the EHR.

**Two prerequisites** must be set on the OpenEMR install before the
flow works. Both are one-time per install.

### 1. site_addr_oath must match the SPA's origin

OpenEMR's OAuth server advertises endpoint URLs based on the
`site_addr_oath` global. If it points at `https://localhost:9300`
but the SPA loads from `http://localhost:8300`, the OAuth redirect
chain crosses origins and the browser will reject the OAuth issuer's
self-signed cert. Set it to the same origin the SPA is served from.

**Dev (Docker compose):**

```sh
docker exec development-easy-mysql-1 \
  mariadb -uopenemr -popenemr openemr -e \
  "UPDATE globals SET gl_value = 'http://localhost:8300' \
   WHERE gl_name = 'site_addr_oath'"
```

**Prod (Admin UI):** *Admin → System → Globals → Connectors* → set
**OAuth2/JWT Server Address** to the public URL of the OpenEMR
deployment (e.g. `https://emr.example.com`).

### 2. Register the dashboard's OAuth2 client and enable EHR-launch skip

The dashboard registers itself the first time it runs (`ensureClientId`
in `src/lib/fhir.ts` POSTs to `/oauth2/{site}/registration`), but the
RFC 7591 registration endpoint doesn't take the
`skip_ehr_launch_authorization_flow` flag — that has to be set
separately, by an admin.

**The flag is what makes the second login screen go away.** Without
it, even though OpenEMR has a valid session cookie, the OAuth
authorization endpoint will still render its `oauth2-login.html.twig`
template asking the user to sign in. With it, OpenEMR trusts the
existing session and issues a code immediately. There's also a
parallel global flag — `oauth_ehr_launch_authorization_flow_skip` —
that gates this behavior site-wide.

**Dev (Docker compose):** the global is already 1 in the seed data.
After the SPA's first run auto-registers the client, flip the
per-client flag and add the `launch` scope:

```sh
docker exec development-easy-mysql-1 \
  mariadb -uopenemr -popenemr openemr -e \
  "UPDATE oauth_clients
     SET skip_ehr_launch_authorization_flow = 1,
         scope = CONCAT(scope, ' launch')
   WHERE client_name = 'OpenEMR Patient Dashboard'
     AND scope NOT LIKE '%launch %'
     AND scope NOT LIKE '% launch'"
```

The dashboard's redirect URI must also match the SPA's actual origin
(`http://localhost:8300/dashboard/auth/callback`). Auto-registration
uses the SPA's `window.location.origin`, but if you registered the
client manually first, update it:

```sh
docker exec development-easy-mysql-1 \
  mariadb -uopenemr -popenemr openemr -e \
  "UPDATE oauth_clients
     SET redirect_uri = 'http://localhost:8300/dashboard/auth/callback'
   WHERE client_name = 'OpenEMR Patient Dashboard'"
```

**Prod (Admin UI):**

1. *Admin → System → Globals → Connectors* — confirm
   **OAuth2/JWT — Allow EHR Launch authorization flow skip** is on.
2. Load the SPA once at `https://emr.example.com/?v2=1` while
   logged in. The SPA auto-registers via
   `POST /oauth2/{site}/registration`. Confirm a new row in
   *Admin → System → API Clients (OAuth2)* with the name
   "OpenEMR Patient Dashboard".
3. Open the new client and:
   - **Enable** the client (`is_enabled = 1`).
   - **Skip EHR Launch Authorization Flow**: check the box.
   - **Scope**: append ` launch` to the existing scope list.
   - **Redirect URI**: confirm it matches
     `https://emr.example.com/dashboard/auth/callback`.
4. Save.

### How the auth flow looks at runtime

1. User logs into OpenEMR with `?v2=1`. `main_v2.php` renders.
2. User picks a patient via the legacy Finder iframe →
   `top.RTop.location = "...?set_pid=N"` → SPA shim → router
   navigates to `/patient/N`.
3. `RequireFhirSession` mounts and checks for an existing SMART
   session in `sessionStorage`. If present, it renders the cards.
4. If not, the SPA calls
   `interface/main/tabs/main_v2_launch.php?pid=N` to get a fresh
   encrypted launch token bound to that patient's UUID. It then
   calls `fhirclient.oauth2.authorize` with `launch` + `aud`
   parameters.
5. OpenEMR's authorization server sees the launch token + the
   `skip_ehr_launch_authorization_flow` flag + the active session
   → issues an authorization code without showing a login screen.
6. fhirclient lands at `/dashboard/auth/callback?code=...` (Apache
   rewrite serves the SPA there), exchanges the code for an access
   token, and stores the SMART session in `sessionStorage`.
7. `AuthCallbackRoute` redirects through
   `interface/main/tabs/main_v2_resume.php`, which mints a fresh
   `token_main` and lands the user back on `main_v2.php`.
8. `RequireFhirSession` mounts again, sees the session, and the
   cards' patient-scoped FHIR fetches succeed.

The whole dance happens once per browser tab. Subsequent patient
picks reuse the session — no second redirect chain.

> **Note on Medications scope.** OpenEMR's FHIR layer does not expose a
> `patient/MedicationStatement.read` scope (verified against the dev
> install on 2026-05-07). The Medications card sources from
> `MedicationRequest?intent=plan` instead — see build plan T4.4.

## Conventions

- **No repo-wide reformat.** `npm run lint`/`format` only operate
  inside `dashboard/`. Drive-by lint changes outside this directory
  are reverted before commit (project-wide convention — fork of
  upstream `openemr/openemr`).
- **No `any` without an inline justification.** Prefer `unknown` +
  narrowing.
- **Conventional Commits, scope `dashboard`.** Story IDs land in
  the commit body: `Story: T1.4`.

## Pre-commit (prek)

The repo's `prek` config runs the dashboard's lint + typecheck on
staged `dashboard/**/*.{ts,tsx}` files. To install the hooks:

```sh
prek install
```

If you don't yet have prek, the same checks run in CI on every
push. Local install is recommended but not required.
