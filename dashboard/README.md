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

Run from this directory.

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

## Dev environment integration (T0.1 + T1.5/T1.6)

The SPA is served at `/dashboard/` in production and dev. T1.6 adds
the Apache rewrite that maps `/dashboard/*` to `dist/index.html`
and the path-scoped CSP. Until then, `npm run dev` is the canonical
way to iterate; the SPA stands alone outside OpenEMR.

T1.5 vendors `dashboard/dist/` into git and adds a `test:dashboard`
GitLab CI job that mirrors `test:agent`. Once that lands, the
release flow is:

```
git push to master
  → CI runs test:dashboard (lint, typecheck, test, build, dist diff)
  → CI deploy stage runs runner-bootstrap.sh
  → infra/deploy.sh rsyncs the new release tree
  → Apache picks up the new dashboard/dist/
```

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
