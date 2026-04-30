# Clinical Co-Pilot — OpenEMR module

Browser-side surface for the Clinical Co-Pilot. The runtime that
actually talks to Anthropic and runs LangGraph lives in the sibling
[`/agent`](../../../../agent/) Node service; this module is the
in-OpenEMR proxy + UI that the clinician interacts with.

Status: **Phase 1.3 skeleton.** PSR-4 autoload is wired and the
module is discoverable by OpenEMR's installer. No controllers,
templates, or event listeners yet — those land in Phase 1.4 (proxy +
token mint), Phase 3.x (UC1 panel), and Phase 4.x (follow-up taps).

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
    Bootstrap.php          Module constants; gains listeners in 1.4+
    Controller/            (1.4+ proxy + UC handlers)
    Service/               (3.x snapshot adapters, see Phase 2)
  templates/               (3.x panel.html.twig)
  public/
    js/                    (3.x SSE client)
    css/                   (3.x panel styling)
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

## Tests

Structural checks live in
[`tests/Tests/Isolated/Modules/ClinicalCopilot/ModuleSkeletonTest.php`](../../../../tests/Tests/Isolated/Modules/ClinicalCopilot/ModuleSkeletonTest.php).
They verify the on-disk shape the installer scans for; the runtime
behaviour of the `Bootstrap` class is covered as listeners are added
in later sub-phases.

```sh
composer phpunit-isolated -- --filter ModuleSkeletonTest
```
