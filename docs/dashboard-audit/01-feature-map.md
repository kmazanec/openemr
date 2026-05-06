# Patient Dashboard — Feature Map

> **Scope.** "The dashboard" in OpenEMR is the patient summary screen — the
> view a clinician lands on after picking a patient. The outer SPA shell is
> `interface/main/tabs/main.php` (top nav, tab strip, identity bar, hidden
> iframes). The actual dashboard *content* is rendered by
> `interface/patient_file/summary/demographics.php` (~2070 lines), which
> mounts inside one of the SPA tabs. All file:line references below are
> relative to the repo root.

This document maps the user-visible features. Dependencies, UX flows, and
data models are split into companion files (`02-*` … `04-*`).

---

## 0. Outer shell — `interface/main/tabs/main.php`

The shell is the chrome around every tab; it is loaded once per session and
never reloads. It owns:

| Region | Source | Notes |
|---|---|---|
| Page title / favicon | `main.php:102` | Pulls `$openemr_name`. |
| Top navbar (logo + main menu + search + user) | `main.php:481-516`, `templates/interface/main/tabs/menu_template.html.twig` | Knockout-bound; menu data injected via `menu_json.html.twig`. |
| Patient identity bar (the "attendant" strip) | `main.php:517`, `interface/main/tabs/templates/patient_data_template.php` | Bound to `app_view_model.attendant_template_type` — switches between patient / therapy-group / user. |
| Tab strip + per-tab controls | `main.php:518-521`, `tabs_template.html.twig`, `interface/main/tabs/js/tabs_view_model.js` | Each tab is a sandboxed `<iframe>`. Patient context is held by the shell, not the iframe. |
| Reminders & background-service ping | `main.php:193-288` | `goRepeaterServices()` polls every 60 s — pulls portal counts, fax/SMS counts, reminder text; also kicks `/apis/{site}/api/background_service/$run` every cycle (skippable via `OPENEMR__NO_BACKGROUND_TASKS`). |
| Encounter-locked check | `main.php:290-315` | Synchronous AJAX (`async:false`) when ESign locking is enabled — porting hazard. |
| Product registration / telemetry modal | `main.php:522-525, 564-567` | Super-admin-only, suppressed in test mode. |
| Logout iframe + version footer | `main.php:464, 527-529` | The hidden `logoutinnerframe` iframe is required for the logout flow to work. |

Anti-features worth knowing about:

- `prevent_browser_refresh` global gates a `beforeunload` handler; `main.php`
  itself nukes its own session token (`token_main_php`) when the value is
  `>1`, so refreshing the URL bar deliberately bounces the user back to the
  login screen.
- `window.opener = null; window.name = "main";` (`main.php:120-121`) is
  load-bearing for the `top.…` calls scattered through every fragment.

---

## 1. Patient identity bar (header)

Two headers, depending on context:

1. **SPA attendant strip** (`patient_data_template.php`) — the always-visible
   identity bar at the top of the shell. Knockout-bound to
   `application_data.user.patient`. Shows name, DOB, age, sex, MRN,
   primary insurance carrier, status badges. Click on the patient name
   slides `#attendantData` open/closed (`main.php:535-538`).
2. **Dashboard page header** — `interface/patient_file/summary/dashboard_header.php`
   (only 33 lines). Renders the patient/dashboard banner via the Twig
   template `patient/dashboard_header.html.twig` after a
   `patients/demo` ACL check. No actions.

Patient-context invariant: if `pid` is missing or the patient has a `squad`
the user can't ACL into, demographics.php redirects (`demographics.php:1066`).

---

## 2. Three-column "issues" row

These are the three flexbox cards at the top of the dashboard body
(`demographics.php:1112-1206`, `1208-1243`).

| Card | File:Line | Source service | Edit target | Hidden-card key |
|---|---|---|---|---|
| **Allergies** | 1112-1133 | `AllergyIntoleranceService::getAll()` | `stats_full.php?active=all&category=allergy` | `card_allergies` |
| **Medical Problems** | 1137-1157 | `PatientIssuesService` (type `medical_problem`) | `stats_full.php?active=all&category=medical_problem` | `card_medicalproblems` |
| **Medications** (issue-list) | 1159-1179 | `PatientIssuesService` (type `medication`) | `stats_full.php?active=all&category=medication` | `card_medication` |
| **Prescriptions** | 1208-1243 | Smarty controller (`controller.php?prescription&list&id={pid}`) buffered into Twig | eRx mode → `/interface/eRx.php?page=compose`; non-eRx → inline iframe via `editScripts()` | `card_prescriptions` |

Notable:

- The "Current Medications" pill list shown alongside Prescriptions is a
  separate card (`demographics.php:1182-1206`), gated by `erx_enable` AND the
  `display_current_medications_below` global.
- The Prescriptions card is a Smarty/Twig bridge: `chdir()` + `ob_start()` to
  call `controller.php` and capture its HTML, which is then injected into
  Twig (`demographics.php:1229-1238`). This is the single ugliest piece of
  legacy plumbing on the dashboard — see bug catalog.

---

## 3. Primary section (left column)

Driven by `SectionEvent('primary')`. Always-on cards plus any cards added by
modules through the event dispatcher.

| Card | File:Line | Source | Edit / actions |
|---|---|---|---|
| **Demographics** | 1336 | `DemographicsViewCard` | "Edit" → `demographics_full.php`; opens `demographics_save.php` on submit |
| **Billing** | 1338-1340 | `BillingViewCard` | Hidden when `hide_billing_widget` is set; click on insurance name to expand details |
| **Insurance** | 1342-1344 | `InsuranceViewCard` (read of `insurance_data` joined to `insurance_companies`) | "Edit" → `insurance_edit.php` |
| **Care Team** | 1248-1272 | `CareTeamViewCard` | Read-only on dashboard; assignment happens elsewhere |
| **Treatment Intervention Preferences** | 1276-1297 | `TreatmentPreferenceViewCard` | "Add" toggles inline edit (`js-card-toggle-edit`) |
| **Care Experience Preferences** | 1302-1325 | `CareExperiencePreferenceViewCard` | "Add" toggles inline edit |

Each card supports `prependedInjection` / `appendedInjection` from the
`CardRenderEvent` dispatch (`demographics.php:1381` etc.) — modules can
graft additional HTML into any card.

---

## 4. Center column — clinical fragments

These cards are *server-rendered shells* that load their content via async
JS fragments. The shell sets up the title + edit button; the fragment fills
the body. JS entry point is `placeHtml()` (`demographics.php:526`).

| Card | Fragment | Edit target | Hidden-card key |
|---|---|---|---|
| **Patient Notes (Messages)** | `pnotes_fragment.php` | `pnotes_full.php?form_active=1` | (none — guarded by `patients/notes` ACL) |
| **Patient Reminders** | `patient_reminders_fragment.php` | `../reminder/patient_reminders.php?mode=simple&patient_id={pid}` | `card_patientreminders` |
| **Disclosures** | `disc_fragment.php` | `disclosure_full.php` | `card_disclosure` |
| **Amendments** | (inline render — no fragment) | `list_amendments.php?id={pid}` | `card_amendments` |
| **Labs** | `labdata_fragment.php` | `labdata.php` | `card_lab` |
| **Vitals** | `vitals_fragment.php` | `../encounter/trend_form.php?formname=vitals&context=dashboard` | `card_vitals` |

Per-card collapse state is per-user, persisted in `users_settings` via
`getUserSetting($id)` and toggled by clicking the card chevron. The IDs are
the same hidden-card keys with a `_ps_expand` suffix
(e.g. `pnotes_ps_expand`, `vitals_ps_expand`).

---

## 5. Dynamic LBF (List-Based Form) cards

`demographics.php:1531-1570` queries `layout_group_properties` for any
group with `grp_form_id LIKE 'LBF%'` and `grp_repeats > 0`. For every
matching layout it renders a card whose body is filled by
`lbf_fragment.php?formname=…`. Card title is the layout's `grp_title`,
ACL is the layout's `grp_aco_spec` (pipe-delimited
`section|subsection`), trend button links to
`../encounter/trend_form.php?formname={form_id}`.

Porting note: this is the most "open-ended" surface on the dashboard — the
card list is data-driven, not hard-coded.

---

## 6. Secondary section (right column)

Driven by `SectionEvent('secondary')`. Modules can inject cards just like
the primary section.

| Card | File:Line | Source | Notes |
|---|---|---|---|
| **Patient Portal** | 1576-1623 | `PortalCard` | Auto-hidden when no portal mode is enabled. |
| **eRx partial** | 1625-1631 | `patient/partials/erx.html.twig` | Static link block; gated on `erx_enable`. |
| **Patient Photo / ID Card** | 1633-1654 | `pic_array()` + `get_document_by_catg()` over `documents` | Click to swap photo; lightbox on full image. |
| **Advance Directives** | 1656-1717 | Documents under "Advance Directive" category tree | Edit opens `advdirconfigure()`. Gated by `advance_directives_warning`. |
| **Clinical Reminders** | 1719-1739 (+ `clinical_reminders_fragment.php`) | `clinical_summary_widget()` from CDR | Gated by `enable_cdr` + `enable_cdr_crw`, ACL `patients/alert`. |
| **Appointments** | 1741-2014 | `fetchNextXAppts`, `fetchXPastAppts`, `fetchRecurrences` | See §7. |
| **Recall** | 1889-1913 | `medex_recalls` rows | Only renders when at least one recall exists. |
| **Track Anything** | 2018-2036 (+ `track_anything_fragment.php`) | `form_track_anything_results` | Only renders if `track_anything` is registered. |

---

## 7. Appointments block

The most logic-heavy card on the page. `demographics.php:1741-2014`.

- **Upcoming.** `fetchNextXAppts($today, $pid, $count + extra, withProvider)`.
  Capped by `number_of_appts_to_show` global.
- **Recurrences.** `fetchRecurrences($pid)` — only when
  `appt_recurrences_widget` is enabled.
- **Past.** `fetchXPastAppts($pid, $count, $direction)` — capped by
  `num_past_appointments_to_show`; ordering depends on a per-user direction
  setting.
- **Color sets.** When `appt_display_sets_option` is on, appointments are
  grouped by date with rotating background colors driven by per-day color
  sets — the densest piece of presentation logic on the page (1768-1826).
- **Therapy-group support.** Each appointment row shows either
  `pc_aid` (provider) or the therapy group name when
  `enable_group_therapy` is on.
- **"Add" button.** Calls JS `newEvt()` (defined in the calendar module)
  which `dlgopen`s the new-appointment form.

Recall sub-card lives inside the appointments column (`demographics.php:1889-1913`).

---

## 8. Hidden-card administration

`demographics.php:97, 137` — `getHiddenDashboardCards()` reads
`patient_portal_settings` (or the user-level equivalent) and returns the
list of card keys to suppress. Every card's render block guards on
`!in_array('card_…', $hiddenCards)`. Keys observed:

```
card_allergies, card_medicalproblems, card_medication, card_prescriptions,
card_insurance, card_care_team, card_treatment_preferences,
card_care_experience, card_lab, card_vitals, card_disclosure,
card_amendments, card_patientreminders
```

(There is no key for the dynamic LBF, Track Anything, Portal, Photo,
Advance Directive, Clinical Reminders, Appointments, Recall, Demographics,
or Billing cards — those are gated by ACL/feature flag instead.)

---

## 9. Module/event extension points

Every section and most cards fire events that 3rd-party modules can listen
to. Porting parity requires either replicating these or accepting the
break.

| Event | Where | Purpose |
|---|---|---|
| `RenderEvent::EVENT_SECTION_LIST_RENDER_TOP` | 1072 | Pre-issues row content |
| `RenderEvent::EVENT_SECTION_LIST_RENDER_BEFORE` | 1350 | Before primary cards |
| `RenderEvent::EVENT_SECTION_LIST_RENDER_AFTER` | 1529 | After primary cards |
| `SectionEvent::EVENT_HANDLE` ('primary' / 'secondary') | 1335, 1589 | Lets modules add cards to either column |
| `CardRenderEvent::EVENT_HANDLE` (per card name) | 1381, 1401, 1423, 1444, 1474, 1504, 1556, 1626, 1637, 1700, 1726, 1904, 1993, 2026 | Lets modules wrap any individual card |
| `RenderEvent::EVENT_RENDER_POST_PAGELOAD` | 2071 | End of page |

---

## 10. Feature flags & user settings

The dashboard is heavily configurable. Key globals (all read via
`OEGlobalsBag`):

- **Section visibility:** `disable_prescriptions`, `erx_enable`,
  `display_current_medications_below`, `advance_directives_warning`,
  `amendments`, `hide_billing_widget`.
- **CDR / reminders:** `enable_cdr`, `enable_cdr_crw` (clinical reminders
  widget), `enable_cdr_prw` (patient reminders widget).
- **Calendar:** `disable_calendar`, `appt_recurrences_widget`,
  `appt_display_sets_option`, `number_of_appts_to_show`,
  `num_past_appointments_to_show`.
- **Notes:** `num_of_messages_displayed`.
- **Portal:** `portal_onsite_two_enable`, plus REST/FHIR portal flags.
- **Documents:** `patient_photo_category_name`, `patient_id_category_name`.
- **Group therapy:** `enable_group_therapy`.

Per-user settings (`users_settings` table, read via `getUserSetting`):
the `*_ps_expand` collapse flags for every card and the appointment
reverse-direction toggle.

---

## 11. Quick checklist for the port

For W2 the requirement is parity on:

- [ ] Patient identity header (name, DOB, sex, MRN, active status)
- [ ] Allergies card (FHIR `AllergyIntolerance`)
- [ ] Problem List card (FHIR `Condition`, `category=problem-list-item`)
- [ ] Medications card (FHIR `MedicationStatement`)
- [ ] Prescriptions card (FHIR `MedicationRequest`)
- [ ] Care Team card (FHIR `CareTeam`)
- [ ] **One of:** Encounters, Labs, Vitals, Immunizations, Appointments, Notes

Out of scope for parity but worth noting they exist on the legacy page:
Insurance, Billing, Disclosures, Amendments, Advance Directives, Recall,
Treatment/Care preferences, Track Anything, dynamic LBF cards, Patient
Photo/ID, eRx partial, Clinical Reminders. None of these have to ship in
the port — they are documented here so we don't accidentally drop
clinically important surface area without a deliberate call.
