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
│   ├── App.tsx              # Mount point for the SPA tree
│   ├── App.test.tsx
│   └── main.tsx             # Vite entry
├── tests/
│   ├── setup.ts             # @testing-library/jest-dom registration
│   └── e2e/
│       └── smoke.spec.ts    # Playwright smoke
├── eslint.config.js
├── playwright.config.ts
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json            # Solution-style: refs app + node configs
├── tsconfig.app.json        # `src/` + tests: strict, jsdom env
├── tsconfig.node.json       # config files (vite.config.ts, …)
└── README.md
```

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

## OAuth2 client registration (T2 onwards)

Production deploys need a registered OIDC client (see T0.2 in the
build plan). One-time admin step:

```sh
# Replace {site} with the OpenEMR site (e.g. `default`) and
# {host} with the production host (https://emr.example.com).
curl -X POST "https://{host}/oauth2/{site}/registration" \
  -H 'Content-Type: application/json' \
  -d '{
    "application_type": "private",
    "redirect_uris": ["https://{host}/dashboard/auth/callback"],
    "client_name": "OpenEMR Patient Dashboard",
    "token_endpoint_auth_method": "none"
  }'
```

The response includes `client_id`. Drop it into `.env.local` (dev) or
the production deployment env as `VITE_OIDC_CLIENT_ID`. See
`.env.example` for the full var surface.

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
