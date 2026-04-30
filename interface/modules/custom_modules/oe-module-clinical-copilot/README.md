# Clinical Co-Pilot — OpenEMR module

Browser-side surface for the Clinical Co-Pilot. The runtime that
actually talks to Anthropic and runs LangGraph lives in the sibling
[`/agent`](../../../../agent/) Node service; this module is the
in-OpenEMR proxy + UI that the clinician interacts with.

Status: **Phase 1.4 — proxy + token mint.** The `/agent/{action}` proxy
entry point is in place: `public/agent.php` boots OpenEMR's session,
runs `PolicyGate`, mints a 5-minute RS-signed JWT via League's OAuth2
key material (no self-loopback HTTP — see `docs/PRESEARCH.md` §18),
and streams the upstream agent service's SSE response back to the
browser preserving chunk boundaries. The agent-side JWT verification
middleware (Phase 1.5) and the UC1 panel UI (Phase 3) come next.

See [`docs/IMPLEMENTATION_PLAN.md`](../../../../docs/IMPLEMENTATION_PLAN.md)
and [`ARCHITECTURE.md`](../../../../ARCHITECTURE.md) for the build
plan and architecture.

## Layout

```
oe-module-clinical-copilot/
  composer.json            PSR-4 (OpenEMR\Modules\ClinicalCopilot\)
  info.txt                 Display name read by Manage Modules
  openemr.bootstrap.php    Loaded by ModulesApplication when enabled
  src/
    Auth/                  PolicyGate + AgentTokenMinter + value objects
    Bootstrap.php          Module constants; gains listeners in Phase 3
    Controller/
      AgentProxyController.php   Browser → agent SSE proxy
    Service/               (Phase 3 snapshot adapters, see Phase 2)
  templates/               (Phase 3 panel.html.twig)
  public/
    agent.php              Browser entry: /interface/modules/custom_modules/
                           oe-module-clinical-copilot/public/agent.php?action=...
    js/                    (Phase 3 SSE client)
    css/                   (Phase 3 panel styling)
```

## Registering the module

The on-disk skeleton is necessary but not sufficient — OpenEMR only
loads modules whose row in the `modules` table has `mod_active = 1`.
First-time registration uses the admin UI:

1. Sign in as a user with the **Admin → Manage Modules** ACL.
2. Open **Modules → Manage Modules**. The installer scans
   `interface/modules/custom_modules/` on each visit; a row labelled
   "Clinical Co-Pilot" appears under **Unregistered**.
3. Click **Register** to insert the row in the `modules` table, then
   **Install** and **Enable**. The module then loads on every request
   via `OpenEMR\Core\ModulesApplication::bootstrapCustomModules()`.

A green dot in the Status column confirms the bootstrap loaded
without throwing. The skeleton has nothing visible to the clinician
yet — that arrives with the Phase 3 UI.

To re-register on a fresh database, repeat the steps above. The
state lives in MySQL, not in this directory.

## Configuration

The proxy needs to know how to reach the agent service. Set
`AGENT_SERVICE_URL` in OpenEMR's container environment (defaults to
`http://agent:8080`, the conventional service name on the shared
Docker network). The agent service container itself lands in a later
sub-phase; until then this URL points at nothing and the proxy will
fail with `upstream_unavailable` — which is the correct behavior.

## Tests

Structural checks and policy-gate behavior live under
[`tests/Tests/Isolated/Modules/ClinicalCopilot/`](../../../../tests/Tests/Isolated/Modules/ClinicalCopilot/):

- `ModuleSkeletonTest` — on-disk shape the installer scans for.
- `Auth/PolicyGateTest` — fail-closed denials for missing session,
  wrong site, wrong patient, unknown action, out-of-scope requests.

```sh
composer phpunit-isolated -- --filter ClinicalCopilot
```
