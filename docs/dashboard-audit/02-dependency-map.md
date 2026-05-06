# Patient Dashboard — Dependency Map

> **Scope.** Every backend service, JS library, CSS bundle, DB table, AJAX
> endpoint, Twig/Smarty template, ACL surface, and event hook the legacy
> dashboard touches. The goal is to know what we have to either replicate,
> replace, or deliberately drop in the port. File:line references are to the
> repo root.

---

## 1. Entry-point graph

```
interface/main/tabs/main.php                  ← outer SPA shell (loaded once per session)
 ├─ templates/interface/main/tabs/menu_template.html.twig
 ├─ templates/interface/main/tabs/menu_json.html.twig
 ├─ templates/interface/main/tabs/tabs_template.html.twig
 ├─ templates/interface/main/tabs/user_data_template.html.twig
 ├─ templates/interface/main/tabs/therapy_group_template.html.twig
 └─ interface/main/tabs/templates/patient_data_template.php   ← Knockout patient strip

interface/patient_file/summary/demographics.php   ← dashboard body (loaded into the "pat" tab)
 ├─ require: globals.php → boots OEGlobalsBag, session, auth.inc, kernel
 ├─ require: srcdir/lists.inc.php, patient.inc.php, options.inc.php,
 │           clinical_rules.php, group.inc.php
 ├─ require: ../history/history.inc.php
 ├─ require: ../../../library/appointments.inc.php
 ├─ render:  Twig templates under patient/* (see §6)
 └─ async:   placeHtml() → 9 fragments (see §10)
```

`main.php` and `demographics.php` both `require_once globals.php`, so every
constant, helper, and `$GLOBALS` setup applies to both.

---

## 2. Backend PHP namespaces (use statements)

### `main.php` (`use` block at lines 26-41)

| Class | Purpose |
|---|---|
| `ESign\Api` | Encounter-locking detection for the `isEncounterLocked()` helper. |
| `OpenEMR\Common\Acl\AclMain` | Super-admin gate for the registration dialog. |
| `OpenEMR\Common\Csrf\CsrfUtils` | Mints the two CSRF tokens (form + API) injected into JS. |
| `OpenEMR\Common\Session\SessionUtil` / `SessionWrapperFactory` | Session bootstrap, `token_main_php` handshake. |
| `OpenEMR\Common\Twig\TwigContainer` | Renders the menu/tabs/user templates. |
| `OpenEMR\Core\Header` | Asset bundler — `Header::setupHeader(['knockout', 'tabs-theme', 'i18next', 'hotkeys', 'i18formatting'])` (line 318). |
| `OpenEMR\Core\OEEnvBag` | Reads `OPENEMR_DISABLE_TELEMETRY` and `OPENEMR__NO_BACKGROUND_TASKS`. |
| `OpenEMR\Core\OEGlobalsBag` | Replaces `$GLOBALS` for typed config reads. |
| `OpenEMR\Events\Main\Tabs\RenderEvent` | Body-render lifecycle hooks (PRE/NAV/POST). |
| `OpenEMR\Menu\MainMenuRole` | Builds the top-nav menu tree with ACL filtering. |
| `OpenEMR\Services\LogoService` | Per-tenant logo. |
| `OpenEMR\Services\ProductRegistrationService` | Registration dialog status. |
| `OpenEMR\Services\VersionService` | Footer version string. |
| `OpenEMR\Telemetry\TelemetryService` | Whether telemetry is enabled. |
| `Symfony\Component\Filesystem\Path` | Path canonicalization for "default open tabs". |

### `demographics.php` (lines 40-65)

| Class | Purpose |
|---|---|
| `OpenEMR\Common\Acl\AclMain` | Every per-card ACL check (≈40 calls). |
| `OpenEMR\Common\Csrf\CsrfUtils` | CSRF tokens injected into ~19 inline AJAX call sites. |
| `OpenEMR\Common\Session\SessionUtil` / `SessionWrapperFactory` | Session reads/writes around `pid` and per-card collapse state. |
| `OpenEMR\Common\Twig\TwigContainer` | Most card markup is rendered through `patient/card/*.html.twig`. |
| `OpenEMR\Core\Header` | `Header::setupHeader(['common', 'utility'])` (line 382). |
| `OpenEMR\Core\OEGlobalsBag` | All feature flags (CDR, eRx, calendar, portal, etc.). |
| `OpenEMR\Events\Patient\Summary\Card\RenderEvent` (alias `CardRenderEvent`) | Per-card prepend/append injection points. |
| `OpenEMR\Events\Patient\Summary\Card\SectionEvent` | Lets modules add cards to primary/secondary columns. |
| `OpenEMR\Events\PatientDemographics\RenderEvent` | Page-level lifecycle: TOP / BEFORE / AFTER / POST_PAGELOAD. |
| `OpenEMR\Events\PatientDemographics\ViewEvent` | Audit hook fired when a chart is opened (line 1052). |
| `OpenEMR\FHIR\SMART\SmartLaunchController` | Fires SMART-app context registration so SMART apps can target this patient. |
| `OpenEMR\Menu\PatientMenuRole` | Builds the per-patient menu actions. |
| `OpenEMR\OeUI\OemrUI` | Page chrome / breadcrumbs. |
| `OpenEMR\Patient\Cards\*` (Billing, CareExperiencePreference, CareTeam, Demographics, Insurance, Portal, TreatmentPreference) | The seven first-class card classes; everything else is rendered procedurally. |
| `OpenEMR\Reminder\BirthdayReminder` | Triggers the birthday-popup modal. |
| `OpenEMR\Services\AllergyIntoleranceService` | Allergies card data. |
| `OpenEMR\Services\PatientIssuesService` | Problems & medications cards. |
| `OpenEMR\Services\PatientService` | Core patient identity + recent-list touch. |
| `Symfony\Component\EventDispatcher\EventDispatcher` | Type hint. |

### Legacy globals/helpers consumed (procedural)

`sqlQuery`, `sqlStatement`, `sqlInsert`, `getUserSetting`, `setUserSetting`,
`xl/xlt/xla/xlj`, `text`, `attr`, `attr_url`, `js_escape`, `js_url`,
`oeFormatShortDate`, `oeFormatDateTime`, `getPatientAgeDisplay`,
`fetchNextXAppts`, `fetchXPastAppts`, `fetchRecurrences`,
`getPnotesByDate`, `pic_array`, `get_document_by_catg`,
`allergy_conflict`, `active_alert_summary`, `clinical_summary_widget`,
`patient_reminder_widget`, `print_as_money`, `setpid`, plus the auth-screen
fall-through (`authCloseSession`, `authLoginScreen`).

---

## 3. JavaScript stack

### Asset bundles (via `Header::setupHeader`)

- `main.php` loads: `knockout`, `tabs-theme`, `i18next`, `hotkeys`,
  `i18formatting`. Plus jQuery and Bootstrap 4 are pulled in implicitly by
  `globals.php`.
- `demographics.php` loads: `common`, `utility` — these bundles include
  jQuery, jQuery UI, Bootstrap, `dlgopen`, `restoreSession`, common CSS.

### Custom JS files in the SPA shell (`interface/main/tabs/js/`)

| File | Role |
|---|---|
| `tabs_view_model.js` (501 lines) | Knockout view model for the tab strip. Defines `navigateTab`, `tabRefresh`, `tabClose*`, `loadCurrentPatient`, `clearPatient`. Owns the iframe registry. |
| `patient_data_view_model.js` | Observable bag for the patient identity strip (name, DOB, MRN, badges). |
| `user_data_view_model.js` | Observable bag for the logged-in user (incl. portal/messages/services counters). |
| `therapy_group_data_view_model.js` | Observable bag when a therapy group is in context instead of a patient. |
| `application_view_model.js` | Top-level KO model that owns the others; binds at `ko.applyBindings(app_view_model)` in `main.php:531`. |
| `frame_proxies.js` | Cross-frame API: `left_nav.setPatient`, `setEncounter`, `setTherapyGroup`, `loadFrame`, `clearEncounter`, `removeOptionSelected`, `syncRadios`, plus an `RTop` helper. Hardcoded tab names: `pat`, `enc`, `rev`, `pop`, `gdg`, `gfn`. |
| `custom_bindings.js` | Knockout custom bindings (collapse, route, tooltip, etc.). |
| `dialog_utils.js` | Wrapper around `dlgopen` (the legacy modal helper) used by every card edit button. |
| `shortcuts.js` | Hotkeys: `alt+1` (calendar), `alt+2` (finder), `alt+r` (refresh — currently no-op per source comment), `alt+shift+w` (clear patient). |
| `menu_analysis.js` | Dev-only helper for menu introspection. |
| `include_opener.js` | Restores `window.opener` semantics for code that expects them. |

### Third-party JS the dashboard relies on

- **Knockout 3.x** — bindings on the patient strip, tab strip, user strip,
  notification dropdowns.
- **jQuery 3.7 + jQuery UI** — used for `$.post`, `.load()`, `dlgopen`'s
  underlying dialog, and Bootstrap modal interop.
- **Bootstrap 4.6** — collapse (`data-toggle="collapse"`), modal, dropdown,
  card, badge utility classes. Card collapse/expand uses Bootstrap's
  data-API.
- **i18next** — runtime translation strings, hydrated from
  `library/ajax/i18n_generator.php` on load.
- **hotkeys-js** — keyboard shortcuts.

---

## 4. CSS / theming

Theme bundle name is `tabs-theme` (see `Header::setupHeader` call). Asset
versioning is via `v_js_includes` (cache-bust query param). Per-card
inline styles are minimal — most layout uses Bootstrap utility classes
(`flex-fill`, `mx-1`, `card`, `card-body`, `badge`, etc.). Dashboard-specific
overrides live in `public/themes/` (loaded by `Header::setupHeader`); the
cleanest signal of theme dependency on this page is `card_bg_color` and
`card_text_color` which are sourced from the per-card class
(`$card->getBackgroundColorClass()`).

---

## 5. Patient-dashboard card classes

Located in `src/Patient/Cards/`. Used by `demographics.php` either directly
(`new DemographicsViewCard(...)`) or through the section event dispatcher.

- `DemographicsViewCard`
- `BillingViewCard`
- `InsuranceViewCard`
- `CareTeamViewCard`
- `CareExperiencePreferenceViewCard`
- `TreatmentPreferenceViewCard`
- `PortalCard`

Every card implements an `isInitiallyCollapsed()`, `getBackgroundColorClass()`,
`getTextColorClass()` interface and exposes `getTwigVariables()` so the
template can render uniformly.

---

## 6. Twig templates referenced from the dashboard chain

(Names are passed to `$twig->render()` calls in `demographics.php` and
its peers.)

- `core/unauthorized-partial.html.twig`
- `patient/dashboard_header.html.twig`
- `patient/card/loader.html.twig`  *(generic async-card frame — used ~15 times)*
- `patient/card/allergies.html.twig`
- `patient/card/medical_problems.html.twig`
- `patient/card/medication.html.twig`
- `patient/card/erx.html.twig`
- `patient/card/rx.html.twig`
- `patient/card/amendments.html.twig`
- `patient/card/photo.html.twig`
- `patient/card/adv_dir.html.twig`
- `patient/card/appointments.html.twig`
- `patient/card/recall.html.twig`
- `patient/partials/erx.html.twig`
- `patient/partials/deceased.html.twig`
- `interface/main/tabs/menu_template.html.twig`
- `interface/main/tabs/menu_json.html.twig`
- `interface/main/tabs/tabs_template.html.twig`
- `interface/main/tabs/therapy_group_template.html.twig`
- `interface/main/tabs/user_data_template.html.twig`
- `product_registration/product_registration_modal.html.twig`
- `product_registration/product_reg.js.twig`

The **Prescriptions** card (`demographics.php:1208-1243`) is rendered by a
Smarty template — `controller.php?prescription&list&id=…` is invoked via
`chdir()` + `ob_start()`, and the captured Smarty HTML is re-injected into
the Twig page. This is the only spot on the dashboard that mixes
templating engines mid-render.

---

## 7. Event hooks the dashboard fires

| Event | Where | Purpose |
|---|---|---|
| `RenderEvent::EVENT_RENDER_PRE` (`Main\Tabs\RenderEvent`) | `main.php:460` | Outer body `<body>` open. |
| `RenderEvent::EVENT_RENDER_NAV` | `main.php:514` | Top-nav region. |
| `RenderEvent::EVENT_RENDER_POST` | `main.php:562` | Outer body close. |
| `ViewEvent::EVENT_HANDLE` | `demographics.php:1052` | Patient-chart-opened audit. |
| `RenderEvent::EVENT_SECTION_LIST_RENDER_TOP` | 1072 | Before the issues row. |
| `SectionEvent::EVENT_HANDLE` (`primary`) | 1335 | Module hook to add primary-column cards. |
| `SectionEvent::EVENT_HANDLE` (`secondary`) | 1589 | Module hook to add secondary-column cards. |
| `RenderEvent::EVENT_SECTION_LIST_RENDER_BEFORE` | 1350 | Pre-primary cards. |
| `RenderEvent::EVENT_SECTION_LIST_RENDER_AFTER` | 1529 | Post-primary cards. |
| `CardRenderEvent::EVENT_HANDLE` (per card kind) | Many (1381 note, 1401 reminder, 1423 disclosure, 1444 amendment, 1474 lab, 1504 vital_sign, 1556 LBF, 1626 demographics, 1637 patient_photo, 1700 advance_directive, 1726 clinical_reminders, 1904 recall, 1993 appointment, 2026 track_anything) | Per-card prepend/append HTML injection. |
| `RenderEvent::EVENT_RENDER_POST_PAGELOAD` | 2071 | Final hook. |

`SmartLaunchController::registerContextEvents()` is also called at line 95
to wire the SMART-app launch flow.

---

## 8. ACL surface

ACL checks during a single dashboard render include (non-exhaustive):

- `patients/demo` — overall view (line 1053)
- `squads/<patient.squad>` — squad-scoped patient access (1066)
- `patients/rx`, `patients/notes`, `patients/reminder`, `patients/disclosure`,
  `patients/amendment`, `patients/lab`, `patients/med`, `patients/alert`,
  `patients/appt` — per-card view + `write` / `addonly` variants
- `aclCheckIssue('allergy' | 'medical_problem' | 'medication')` — issue-type
  ACLs gated by patient squad (1092-1094)
- `admin/super` — only used in `main.php` for the registration dialog
- LBF cards: ACL is sourced from `layout_group_properties.grp_aco_spec`
  (pipe-delimited `section|subsection`)

---

## 9. CSRF surface

- `csrf_token_js` (form CSRF) and `api_csrf_token_js` (REST/LocalApi CSRF)
  are minted in `main.php:132,134` and read by every fragment / AJAX call.
- `demographics.php` injects the form token into ~19 inline AJAX call sites.
- The REST/LocalApi calls (e.g. `/apis/{site}/api/background_service/$run`)
  require the API token in the `APICSRFTOKEN` header.
- Fragments re-validate CSRF on POST via `CsrfUtils::verifyCsrfToken`.

---

## 10. Async fragments (loaded by `placeHtml()`)

All under `interface/patient_file/summary/`. Each one re-includes
`globals.php`, re-checks ACL/CSRF, and renders an HTML chunk that is
injected into a host `<div>` whose id matches the collapse-state key.

| Fragment | Default host div | Triggered when |
|---|---|---|
| `stats.php` | `stats_div` | Always (line 604) |
| `pnotes_fragment.php` | `pnotes_ps_expand` | Always (line 609) |
| `disc_fragment.php` | `disclosures_ps_expand` | Always (624) |
| `labdata_fragment.php` | `labdata_ps_expand` | Always (625) |
| `track_anything_fragment.php` | `track_anything_ps_expand` | Always (626) |
| `vitals_fragment.php` | `vitals_ps_expand` | When vitals registered + ACL (629) |
| `clinical_reminders_fragment.php` | `clinical_reminders_ps_expand` | When CDR enabled (633) |
| `patient_reminders_fragment.php` | `patient_reminders_ps_expand` | When CDR-PRW enabled (713) |
| `lbf_fragment.php?formname=…` | per-form id | One per LBF group (loop 1531-1570) |
| `add_edit_issue_medication_fragment.php` | (popup body) | From the issue editor modal |

---

## 11. AJAX / REST endpoints called from the dashboard

From the SPA shell (`main.php`) and child JS:

- `library/ajax/set_pt.php?csrf_token_form=…` — async session getter (177).
- `library/ajax/dated_reminders_counter.php` — combined portal/reminders/fax
  counters, polled every 60 s (209).
- `library/ajax/i18n_generator.php?lang_id=…` — language pack hydration (323).
- `library/ajax/track_events.php` — per-tab telemetry (`tabs_view_model.js:396`).
- `library/ajax/unset_session_ajax.php?func=unset_pid` — patient close
  (`tabs_view_model.js:430,452`).
- `apis/{site}/api/background_service/$run` — fires the background-service
  runner once per polling cycle (270). REST stack — uses `APICSRFTOKEN`
  header.

From the dashboard body (`demographics.php` and fragments):

- `library/ajax/user_settings.php` — collapse-state persistence (451, 459, 903).
- `pnotes_fragment.php?docUpdateId=…` — mark a note "completed".
- `interface/main/calendar/add_edit_event.php` (via `dlgopen`).
- `interface/patient_file/advancedirectives.php` (via `dlgopen`).
- `interface/patient_file/deleter.php` (via `dlgopen`).
- `interface/eRx.php?page=compose` (eRx module, dialog).
- `controller.php?prescription&list&id=…` (legacy controller for Rx list).
- `interface/patient_file/education.php` (referential CDS dialog, 387-394).
- `portal/import_template_ui.php?from_demo_pid=…` (portal doc assignments).

The dashboard does **not** call the FHIR API today. Every "live" data read
is via `sqlQuery`/`sqlStatement` or a service backed by them.

---

## 12. Database tables read or written

A representative list (any read, write, or count); not exhaustive.

| Table | Used by | R/W |
|---|---|---|
| `patient_data` | demographics, header, photo, portal | R + W (via `demographics_save.php`) |
| `patient_access_onsite` | portal card | R |
| `lists` | allergies/medications/problems cards | R + W (issue editor) |
| `lists_medication` | medications card | R |
| `issue_encounter` | problems card / issue editor | R + W |
| `prescriptions` | "Current Medications" + Rx card | R |
| `form_encounter` | header (last visit), appointments, issue→encounter joins | R |
| `forms` | LBF discovery, vitals lookup, deleted-flag check | R |
| `form_vitals` | vitals fragment | R |
| `procedure_order` / `procedure_report` / `procedure_result` | labs fragment | R |
| `pnotes` | notes fragment | R + W (mark done) |
| `extended_log` | disclosures fragment | R + W |
| `amendments` | amendments card | R |
| `documents`, `categories`, `categories_to_documents` | photo + advance directive cards | R |
| `openemr_postcalendar_events`, `openemr_postcalendar_categories` | appointments card | R |
| `medex_recalls` | recall card | R |
| `insurance_data`, `insurance_companies`, `addresses` | insurance card | R |
| `registry` | enable checks for vitals, track_anything, etc. | R |
| `layout_group_properties` | dynamic LBF cards | R |
| `form_track_anything_results` (+ track_anything_*) | track-anything fragment | R |
| `users`, `users_facility`, `facility` | care-team & provider lookups | R |
| `users_settings` | per-card collapse state | R + W |
| `globals` | hidden-card list, all OE feature flags | R |
| `list_options` | enum values throughout | R |
| `patient_reminders` | reminders fragment | R |

---

## 13. External / module integrations

- **eRx (NewCrop):** gated by `erx_enable`. Cross-origin iframe; `eRx.php`
  is the entry point.
- **Patient portal:** `portal_onsite_two_enable` + REST API flags.
  `PortalCard` reads `patient_data.allow_patient_portal` and the
  `patient_access_onsite` credentials row.
- **CDR (Clinical Decision Rules):** `enable_cdr`, `enable_cdr_crw`,
  `enable_cdr_prw`, `enable_allergy_check`. Implemented in
  `library/clinical_rules.php`.
- **SMART on FHIR:** `SmartLaunchController` registers patient context so
  embedded SMART apps can launch against the active patient.
- **ESign:** encounter-locking detection used by the SPA shell's
  `isEncounterLocked()` synchronous AJAX helper.
- **Telemetry / Product registration:** super-admin-only registration
  modal; suppressed in test mode and when `OPENEMR_DISABLE_TELEMETRY` is
  set.
- **Therapy groups:** alternate identity bar template + tab set when a
  group (not a patient) is in context.
- **Track Anything:** custom-form module, gated on the `track_anything`
  registry row.
- **List-Based Forms (LBF):** dynamically-discovered cards driven by
  `layout_group_properties` rows whose `grp_form_id LIKE 'LBF%'`.
- **Fax/SMS module (`oe-module-faxsms`):** services-other dropdown shows
  badge counts when this module is installed.
- **Background services runner:** every polling cycle fires
  `/apis/{site}/api/background_service/$run` (skippable via
  `OPENEMR__NO_BACKGROUND_TASKS`).

---

## 14. Total surface area, tallied

- **PHP files in the dashboard render path:** ~15 (page + 9 fragments +
  helpers).
- **Twig templates:** ~20.
- **JS view-model files:** 11 in `interface/main/tabs/js/`.
- **Service classes referenced:** ~20 (`OpenEMR\Services\*`,
  `OpenEMR\Patient\Cards\*`, `OpenEMR\Menu\*`, `OpenEMR\Telemetry\*`,
  `OpenEMR\Reminder\*`, `OpenEMR\FHIR\SMART\*`).
- **DB tables touched in a single render:** ≥ 25.
- **Inline AJAX call sites in `demographics.php`:** ~19 (CSRF-injected).
- **ACL `aclCheckCore` calls in `demographics.php`:** ~40 (including
  per-card `write`/`addonly` variants).
- **Event listeners modules can hang off:** ≥ 18 (3 lifecycle, 2 section,
  ≥ 13 per-card).
- **OE feature flags consulted:** ≥ 25.

This is the surface a "feature-parity" port has to either replicate or
explicitly drop.
