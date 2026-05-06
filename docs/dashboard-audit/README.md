# Patient Dashboard — Pre-Port Audit

This folder is the artifact set produced before we port the OpenEMR
patient dashboard to a modern framework (W2 surprise-challenge spec in
`docs/AgentForge — Clinical Co-Pilot W2 — Surprise Challenge_ Modernize the Patient Dashboard.pdf`).

The goal at this stage is **understand, don't rebuild**. No code changes
to the legacy dashboard were made; the only output is the documents
listed below.

## What "the dashboard" means here

The user-facing "patient dashboard" in OpenEMR is two pages glued
together:

- **`interface/main/tabs/main.php`** — the always-on SPA shell. It owns
  the top nav, search box, user/notification dropdowns, the patient
  identity strip, and the tab strip with sandboxed `<iframe>`s. It is
  loaded once per session and is the host for everything.
- **`interface/patient_file/summary/demographics.php`** (~2070 lines) —
  the actual per-patient summary content. It mounts inside the `pat`
  tab and is what clinicians mean when they say "the dashboard". This
  page is the centre of gravity for the audit.

A handful of fragments under `interface/patient_file/summary/*_fragment.php`
fill the bodies of the async cards (notes, vitals, labs, etc.).

## Artifacts in this folder

| File | What it covers |
|---|---|
| [`01-feature-map.md`](01-feature-map.md) | Every feature on the dashboard: outer shell, identity bar, three-column issues row, primary section, async fragments, dynamic LBF cards, secondary section, hidden-card admin, event hooks, feature flags. |
| [`02-dependency-map.md`](02-dependency-map.md) | Every backend service, JS lib, CSS bundle, DB table, AJAX endpoint, Twig/Smarty template, ACL surface, event hook, and module integration the dashboard touches. |
| [`03-ui-ux-flows.md`](03-ui-ux-flows.md) | Every user-triggered interaction: header bar, tab strip, hotkeys, per-card actions, modals (~15), inline editors, fragment lifecycle, cross-frame messaging, session keep-alive, print/export. |
| [`04-data-model.md`](04-data-model.md) | Every domain entity the dashboard reads/writes, backing tables, owning service, business rules/invariants, and current REST/FHIR API coverage with port-risk tier. |
| [`05-bug-catalog.md`](05-bug-catalog.md) | Bugs, smells, and porting hazards observed while reading the codebase (24 entries). |
| [`06-framework-options.md`](06-framework-options.md) | Framework, deploy mode, integration point, auth model, and data layer options for the W2 port — informed by what OpenEMR's OAuth2/OIDC server actually supports plus a Jan 2026 SPA-landscape survey. Recommends Vite + React + browser-direct OIDC + static-under-Apache. |

## How the artifacts were assembled

For each artifact I:

1. Read the relevant entry-point files (`main.php`, `demographics.php`,
   the fragments, the SPA shell JS) directly.
2. Spawned a focused Explore subagent in parallel to dig into one of the
   four audit dimensions (features / deps / UX / data).
3. Spot-checked each agent's most surprising claims against the code
   (e.g. confirming the FHIR route table, the `Header::setupHeader`
   bundles, the `dlgopen` call sites, and the `viewPortalPayments`
   duplicate URL).
4. Wrote each artifact by hand to merge what I saw with what the agent
   reported, qualifying claims I couldn't independently verify.

This means the artifacts reflect the actual code, not just an agent's
summary of it.

## What is intentionally not in scope

- **The new framework choice.** That decision lives in the (forthcoming)
  `PATIENT_DASHBOARD_MIGRATION.md` per the W2 spec.
- **A migration plan or schedule.** This is a fact-finding pass; planning
  comes next.
- **Code changes.** Per the prompt, this round produced docs only. The
  one self-flagged "@todo don't think this is used any longer" function
  in the legacy dashboard is documented (B5 in the bug catalog) but not
  removed.

## Quick takeaways

- **Surface area is large.** ~15 PHP files, ~20 Twig templates, 11 JS
  view-model files, ~25 DB tables touched per render, ≥18 module event
  hooks, ≥25 OE feature flags consulted. A pixel-perfect feature-parity
  port is a multi-week effort, not a one-week one.
- **The W2 required-cards set is fully covered by the existing FHIR
  API.** Patient, Allergies, Conditions, Medications (read),
  MedicationRequest (read), CareTeam (read) all have FHIR routes.
- **The optional "+1" cards that have full FHIR coverage are
  Encounters, Labs, Vitals, Immunizations, and Appointments.** Picking
  any of these keeps the port pure-FHIR and avoids the API gaps below.
- **Pnotes, disclosures, amendments, reminders, recall, LBF custom
  forms, and Track Anything have NO REST or FHIR coverage.** They are
  out of W2 scope and should stay out of W2 scope; if a clinic depends
  on them today, that's a future-iteration problem.
- **Two real bugs surfaced** worth filing upstream: the duplicate
  Audits/Payments URL (`B1`) and the broken `!empty(...) ?? null`
  expression for `isFax` (`B2`). The dead `Alt+R` hotkey (`B4`) and the
  CWD leak in the Rx Smarty bridge (`B6` / `B20`) are also worth a
  patch.
- **One potential security gap** (`B17`) deserves verification before
  the port goes live: the squad ACL gate is enforced at the dashboard
  page level, not (apparently) at the FHIR API. If the new UI bypasses
  the dashboard, squad-restricted patients may become readable.

## Next steps (suggested, not committed)

1. Pick the framework + auth stack and write `PATIENT_DASHBOARD_MIGRATION.md`.
2. Verify squad ACL enforcement at the FHIR layer (B17).
3. Decide whether the "+1" optional card is Encounters, Labs, Vitals,
   Immunizations, or Appointments.
4. Stand up an OAuth2 / OIDC client against `interface/oauth2/`.
5. Build the patient identity bar + the six required cards against
   FHIR.
