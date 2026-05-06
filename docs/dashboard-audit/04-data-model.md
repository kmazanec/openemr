# Patient Dashboard — Data Model & Business-Logic Audit

> **Scope.** Every domain entity the dashboard reads or writes, where it
> persists, who owns it in PHP, the invariants the dashboard relies on,
> and how well it's covered by the existing REST/FHIR API. The point of
> this artifact is to surface **API gaps** that will affect the port — the
> new UI consumes REST/FHIR, so anything without API coverage is a
> hard-stop the port has to either build, work around, or drop.

API verification: REST routes are split into
`apis/routes/_rest_routes_fhir_r4_us_core_3_1_0.inc.php` (FHIR R4 / US
Core 3.1.0) and `apis/routes/_rest_routes_standard.inc.php` (the OpenEMR
"standard" REST API). I grep'd both to confirm the coverage statements
below. FHIR controllers live in `src/RestControllers/FHIR/`.

---

## 1. Patient

- **Tables:** `patient_data` (incl. `pid`, `uuid`, `fname`, `lname`,
  `DOB`, `sex`, `pubpid`, `status`, `squad`, `completed_ad`,
  `ad_reviewed`, `advance_directive_user_authenticator`, contact fields,
  portal flags).
- **Owner:** `OpenEMR\Services\PatientService`; legacy helper
  `getPatientData()` (`library/patient.inc.php`); UI in
  `demographics.php`, `demographics_full.php`, `demographics_save.php`.
- **Invariants:**
  - Every dashboard read is scoped to `$pid` from the session.
  - **Squad gate:** if `patient_data.squad` is set and the user is not in
    that ACL squad, the dashboard refuses to render
    (`demographics.php:1066`).
  - `status` is the soft-delete flag (active vs. inactive).
- **API coverage:** ✅ `GET/POST/PUT /fhir/Patient`, plus the standard
  `/api/patient` family.
- **Port risk:** Low. The new UI can read the patient from FHIR
  directly. **Gap:** demographic *updates* via FHIR are limited; full
  parity edits still flow through `demographics_save.php`.

---

## 2. Allergy / Intolerance

- **Tables:** `lists` filtered to `type='allergy'` (key columns:
  `id`, `uuid`, `pid`, `title`, `begdate`, `enddate`, `activity`,
  `comments`, `reaction`, `verification`, `outcome`).
- **Owner:** `OpenEMR\Services\AllergyIntoleranceService`; UI in
  `add_edit_issue.php` (issue-type editor) and the dashboard allergy card.
- **Invariants:**
  - "Active" = `enddate IS NULL` or in the future; "resolved" otherwise.
  - `activity = 0` is a separate soft-delete distinct from `enddate`.
  - Reaction / verification values come from `list_options`
    (`reaction_title`, `verification_title`).
  - ACL: `aclCheckIssue('allergy')`, plus the patient squad gate.
- **API coverage:** ✅ Full CRUD on `/fhir/AllergyIntolerance`.
- **Port risk:** **Low** — the W2 spec calls out Allergies and FHIR has
  it covered.

---

## 3. Problem List (Condition)

- **Tables:** `lists` filtered to `type='medical_problem'` (key columns
  add: `diagnosis`, `occurrence`, `classification`, `referredby`,
  `extrainfo`); `issue_encounter` (`pid`, `list_id`, `encounter`,
  `resolved`) for issue↔encounter junction (1:N).
- **Owner:** `PatientIssuesService` (umbrella for all issue types);
  `ConditionService` is the FHIR projection. UI: `add_edit_issue.php`,
  dashboard problems card.
- **Invariants:**
  - Same active/resolved/`activity` model as allergies.
  - `diagnosis` is the coded value (ICD-10 / SNOMED, sometimes legacy).
  - `issue_encounter` rows are inserted when an issue is "associated"
    with an encounter; rows are not cascaded on `lists` delete.
  - ACL: `aclCheckIssue('medical_problem')`, patient squad gate.
- **API coverage:** ✅ Full CRUD on `/fhir/Condition`.
- **Port risk:** **Low** — W2 explicitly requires the Problem List card.

---

## 4. Medication (issue-type) and Prescription (Rx)

The legacy dashboard surfaces medications in **two** distinct ways:

### 4a. Medication issues

- **Tables:** `lists` filtered to `type='medication'`; `lists_medication`
  one-to-one on `list_id` (route, dosage, frequency, RxNorm code).
- **Owner:** `PatientIssuesService`. UI:
  `add_edit_issue_medication_fragment.php`.
- **Invariants:** same lifecycle pattern as allergies/problems.
- **API coverage:** Read via `/fhir/MedicationStatement` (FHIR R4 maps
  the medication issue list to `MedicationStatement`).

### 4b. Prescriptions (`prescriptions` table)

- **Tables:** `prescriptions` (the actual ordered Rx — drug, dosage,
  unit, route, form, interval, refills, prescriber).
- **Owner:** Smarty controller (`controller.php?prescription&list&id=…`)
  — yes, the dashboard renders this through `chdir()` + `ob_start()`.
- **Invariants:** active vs. ended is determined by `active` column;
  refills decrement on dispense.
- **API coverage:** Read via `/fhir/MedicationRequest`. The route file
  exposes only `GET /fhir/MedicationRequest` and `GET /fhir/MedicationRequest/:uuid`
  — write/PUT/DELETE are not currently routed.
- **Port risk:** **Medium.** Reading meds for a parity card is fine
  (FHIR has it). Write parity (new prescriptions, refills, deactivation)
  is **not** in the FHIR route table — the legacy `eRx` flow or the
  Smarty `controller.php?prescription&...` path is still authoritative.
  The W2 ask is read-only ("clinical cards"), so this is acceptable for
  the port.

---

## 5. Care Team

- **Tables:** Derived. There is no dedicated `care_team` table.
  `FhirCareTeamRestController` projects from `users`, `users_facility`,
  encounter-provider associations, etc.
- **Owner:** `FhirCareTeamRestController` + the corresponding service.
- **API coverage:** ✅ Read via `/fhir/CareTeam` and `/fhir/CareTeam/:uuid`.
  No write routes.
- **Port risk:** **Low** for read; the W2 spec only requires the read
  (display the team).

---

## 6. Encounter

- **Tables:** `form_encounter` (`encounter`, `uuid`, `date`, `pid`,
  `provider_id`, `supervisor_id`, `facility_id`, `reason`,
  `pc_catid`, `last_level_billed`, `last_stmt_date`, `stmt_count`,
  `sensitivity`, `billing_note`); `forms` (the per-encounter form
  registry — `form_name`, `formdir`, `deleted`, `authorized`).
- **Owner:** `EncounterService`, `FhirEncounterService`; "current
  encounter" is held in `$_SESSION['encounter']`.
- **Invariants:**
  - Once `forms.authorized = 1` for a form (or the encounter is
    e-signed), the encounter is treated as locked and forms become
    read-only. The SPA shell's `isEncounterLocked()` synchronous AJAX
    drives this.
  - `forms.deleted = 1` is the soft-delete; `form_encounter` itself is
    not soft-deleted.
- **API coverage:** ✅ `/fhir/Encounter` GET; create is partially
  exposed.
- **Port risk:** Medium for write parity (create/lock semantics are not
  fully in FHIR), low for read parity.

---

## 7. Vitals

- **Tables:** `form_vitals` (`bps`, `bpd`, `weight`, `height`, `temperature`,
  `pulse`, `respiration`, `BMI`, `BMI_status`, `note`, `activity`,
  `authorized`); `forms` row links it into the encounter.
- **Owner:** Vitals are projected onto FHIR `Observation` by
  `ObservationService`. The dashboard reads via `vitals_fragment.php`.
- **Invariants:** BMI computed from height/weight; `forms.deleted = 1`
  hides a vitals reading.
- **API coverage:** ✅ Read via `/fhir/Observation?category=vital-signs`.
  Write via FHIR is **not** supported — dashboard creates/edits go
  through the encounter form.
- **Port risk:** **Low** for read (W2 lists vitals as an optional
  "additional section"). Writing not in scope for W2.

---

## 8. Labs (Diagnostic Report)

- **Tables:** `procedure_order`, `procedure_report`, `procedure_order_code`,
  `procedure_result`. Joins are non-trivial — see `labdata_fragment.php`.
- **Owner:** `ObservationLabService`, `FhirDiagnosticReportRestController`.
  Dashboard reads via `labdata_fragment.php`.
- **Invariants:** Order has its own status flow
  (`pending → routed → complete`). Report has its own
  (`received → reviewed`). Activity flag soft-deletes orders.
- **API coverage:** ✅ Read via `/fhir/DiagnosticReport` and the lab
  observations endpoints.
- **Port risk:** Low for read. Write (placing an order) is **not**
  exposed via the FHIR routes we ship.

---

## 9. Patient Notes (`pnotes`)

- **Tables:** `pnotes` (`id`, `date`, `pid`, `user`, `title`, `body`,
  `assigned_to`, `message_status`, `related_to`, `due_date`).
- **Owner:** Legacy `library/pnotes.inc.php` (`getPnotesByDate`,
  `disappearPnote`); UI in `pnotes_fragment.php`, `pnotes_full.php`.
- **Invariants:**
  - `message_status` is the lifecycle ('New', 'Active', 'Done', etc.).
  - "Mark completed" toggles status to 'Done' but the row is **not**
    deleted. The dashboard re-fetches the fragment via `placeHtml` after
    the round-trip.
  - Threading via `related_to` (parent pnote id).
- **API coverage:** ❌ **No REST or FHIR coverage** — `pnotes` is
  not in either route file. The dashboard is the only sanctioned client.
- **Port risk:** **HIGH.** If we want pnotes parity in the new dashboard
  we have to either (a) add a custom REST endpoint for them, (b) map
  them onto FHIR `Communication` ourselves, or (c) drop pnotes from the
  port (they aren't in the W2 required-cards list).

---

## 10. Clinical Notes (`form_clinical_notes`)

- **Tables:** `form_clinical_notes` (`form_id`, `uuid`, `date`, `pid`,
  `encounter`, `user`, `code`, `codetext`, `description`, `authorized`,
  `activity`, `clinical_notes_type`); `forms` junction.
- **Owner:** `ClinicalNotesService` (the only service whose name matches —
  there is no `PnotesService`).
- **API coverage:** ✅ Projected onto FHIR `DocumentReference` for read.
  Writes go through the encounter form.
- **Port risk:** Low for read; not in W2 scope.

---

## 11. Documents (incl. patient photo, ID card, advance directive)

- **Tables:** `documents` (`id`, `uuid`, `type`, `mimetype`, `url`,
  `owner`, `name`, `hash`, `date_expires`, `drive_uuid`),
  `categories`, `categories_to_documents`, `documents_relationships`.
- **Owner:** `DocumentService`, `FhirDocumentReferenceRestController`.
  Dashboard helpers: `pic_array()`, `get_document_by_catg()`.
- **Invariants:**
  - Documents are linked to a patient through `documents.foreign_id` /
    list-id chains (varies by source).
  - The patient photo + ID card are looked up by **category name** read
    from the `patient_photo_category_name` and `patient_id_category_name`
    globals — porting requires the same category-tree assumption.
  - Advance directives are documents under the "Advance Directive"
    category tree.
- **API coverage:** ✅ Full CRUD via `/fhir/DocumentReference`.
- **Port risk:** Low for read. Categories aren't in FHIR though, so
  "show me the photo specifically" still requires either a custom
  endpoint or convention.

---

## 12. Appointments

- **Tables:** `openemr_postcalendar_events` (the legacy "postcalendar"
  schema) — `pc_eid`, `pc_pid`, `pc_aid` (provider), `pc_eventDate`,
  `pc_startTime`, `pc_endTime`, `pc_recurrtype`, `pc_recurrspec`,
  `pc_apptstatus`, `pc_catid`. Plus
  `openemr_postcalendar_categories` for the category metadata.
- **Owner:** `AppointmentService` + helpers
  `fetchNextXAppts/fetchXPastAppts/fetchRecurrences` from
  `library/appointments.inc.php`. Dashboard renders the appointments
  card directly.
- **Invariants:**
  - "Past" vs. "Upcoming" is computed against the current date —
    there's no status flag.
  - Recurrence expansion is done in PHP (`fetchRecurrences`).
  - Therapy-group support: `pc_pid` is replaced by group id semantics
    when `enable_group_therapy` is on.
- **API coverage:** ✅ Read via `/fhir/Appointment`. Create/update are
  not fully wired in the FHIR routes — the legacy calendar form is
  authoritative for write.
- **Port risk:** Low for read (W2 allows Appointments as the optional
  card). Write parity is out of W2 scope.

---

## 13. Insurance / Coverage

- **Tables:** `insurance_data` (per-patient policy rows: type
  primary/secondary/tertiary, provider FK, plan_name, policy_number,
  group_number, subscriber_*); `insurance_companies`;
  `addresses` (insurance company address, `foreign_id` →
  `insurance_companies.id`).
- **Owner:** Legacy helpers (`getInsuranceProviders` etc. in
  `library/patient.inc.php`); UI: `insurance_edit.php`. There is no
  `InsuranceService` class — the FHIR projection lives in
  `FhirCoverageService` directly.
- **Invariants:**
  - At most one of each `type` per patient (`primary`/`secondary`/`tertiary`).
  - Subscriber may differ from patient (self/spouse/parent/etc., enum
    from list_options).
- **API coverage:** ✅ Read via `/fhir/Coverage` (GET only). No write
  routes.
- **Port risk:** Low for read parity. Insurance write is **not** in W2
  scope.

---

## 14. Disclosures (HIPAA accounting)

- **Tables:** `extended_log` (general audit-log table) filtered by event
  IDs that are listed in `list_options` under `list_id='disclosure_type'`.
- **Owner:** `disc_fragment.php` queries `extended_log` directly; full
  view in `disclosure_full.php`; create in `record_disclosure.php`.
  No service class.
- **Invariants:**
  - Append-only. There is no update workflow.
  - The "type" lives inside the `event` column as a coded string.
  - ACL: `aclCheckCore('patients', 'disclosure', '', 'write'|'addonly')`.
- **API coverage:** ❌ Neither REST nor FHIR has disclosure routes.
- **Port risk:** **HIGH** for parity. Drop from W2 scope unless we add a
  custom endpoint.

---

## 15. Amendments

- **Tables:** `amendments` (lifecycle status), `amendments_history`
  (audit trail).
- **Owner:** `add_edit_amendments.php`, `list_amendments.php`,
  `print_amendments.php`. No service class.
- **Invariants:** Amendment status flows pending → accepted/rejected;
  `amendments_history` rows are append-only.
- **API coverage:** ❌ Not routed.
- **Port risk:** **HIGH** for parity. Out of W2 scope.

---

## 16. Advance Directives

- **Two surfaces:**
  - Flags on `patient_data` (`completed_ad`, `ad_reviewed`,
    `advance_directive_user_authenticator`).
  - Documents under the "Advance Directive" category tree
    (`documents` + `categories`).
- **Owner:** `interface/patient_file/advancedirectives.php` + the
  documents subsystem.
- **API coverage:**
  - Document side: ✅ `/fhir/DocumentReference`.
  - Flag side: ❌ The boolean review flags on `patient_data` are not
    exposed by the FHIR Patient projection.
- **Port risk:** Medium. The "do you have an advance directive on file"
  flag would need either a custom endpoint or to be inferred from the
  presence of an Advance-Directive category document.

---

## 17. Reminders & CDR alerts

- **Tables:** `patient_reminders` (clinical decision rule reminders);
  `rule_action_item` (the rule definitions). Clinical alert summaries
  are computed live by `clinical_summary_widget()` and
  `active_alert_summary()` from `library/clinical_rules.php`.
- **Owner:** Legacy `clinical_rules.php`; UI in
  `clinical_reminders_fragment.php`, `patient_reminders_fragment.php`,
  the auto-fired reminder popup.
- **API coverage:** ❌ No REST or FHIR routes.
- **Port risk:** **Medium.** If we want reminders in the new UI we'd
  need a custom endpoint. The W2 ask doesn't include reminders, so
  drop for now.

---

## 18. Recall (calendar recall)

- **Tables:** `medex_recalls` (date, reason, status).
- **Owner:** Calendar/MedEx subsystem; dashboard reads inline within the
  appointments block.
- **API coverage:** ❌ Not routed.
- **Port risk:** Medium; out of W2 scope.

---

## 19. Practitioner / Provider / Facility

- **Tables:** `users` (practitioners + staff), `users_facility`,
  `facility`, `users_secure`.
- **Owner:** `UserService`, `FacilityService`,
  `FhirPractitioner*RestController`, `FhirOrganizationRestController`.
- **API coverage:** ✅ `/fhir/Practitioner`, `/fhir/PractitionerRole`,
  `/fhir/Organization`, `/fhir/Location` all present (the FHIR route
  file references all four controllers).
- **Port risk:** Low.

---

## 20. Lookup tables (`list_options`)

- **Tables:** `list_options` (single table for every controlled
  vocabulary in OpenEMR; partitioned by `list_id`).
- **API coverage:** ✅ Read via `/fhir/ValueSet` (read-only).
- **Port risk:** Low. The new UI can fetch the same enums it always
  used; modifications stay in OpenEMR's admin UI.

---

## 21. LBF (List-Based Forms) custom layouts

- **Tables:** `layout_group_properties`, `layout_options`, plus the
  per-form data tables (`form_<id>` or shared into `lbf_data`).
- **Owner:** Legacy LBF subsystem; dashboard auto-discovers cards from
  `layout_group_properties`.
- **API coverage:** ❌ Custom layouts are not in FHIR or the standard
  REST API.
- **Port risk:** **HIGH** if any clinic depends on dashboard LBF cards.
  Out of W2 scope.

---

## 22. Track Anything

- **Tables:** `form_track_anything_results`, `form_track_anything`,
  `form_track_anything_more` (custom-form module).
- **API coverage:** ❌ None.
- **Port risk:** Out of W2 scope.

---

## 23. Cross-cutting business rules

These rules apply to multiple entities and are easy to miss when
porting card-by-card:

- **Patient context invariant.** Every read is scoped to `$pid`. The
  FHIR endpoints accept `patient` query params (or the SMART launch
  context); the new UI must always pass it.
- **Encounter context invariant.** Vitals, labs, and clinical notes
  must be created against an encounter. There is no "free-floating
  observation" path.
- **ACL gating per card.** Every card has an `aclCheckCore` (or
  `aclCheckIssue`) call. The new UI's auth scope (OAuth2 scopes — see
  W2 spec) needs to map to those ACLs, or the API layer needs to
  reject reads the user can't see.
- **Squad ACL.** A patient can be flagged with a `squad`; users not in
  the matching squad ACL must not see anything (`demographics.php:1066`).
  This is enforced server-side in the legacy dashboard but you can read
  the squad column out of `patient_data` via FHIR custom mapping —
  *worth confirming the API enforces this, or risk leaking patient data*.
- **Soft-delete.** `lists.activity = 0`, `forms.deleted = 1`,
  `patient_data.status = 'inactive'` — every entity has its own
  soft-delete; do not show inactive rows by default.
- **Date conventions.** `lists.begdate`/`enddate` are dates with NULL
  meaning "open-ended"; FHIR maps these to `Period`.
- **`list_options` enum drift.** Many fields are stored as the
  `option_id` of a `list_options` row. New UI should fetch labels via
  `/fhir/ValueSet`, not hardcode them.

---

## 24. API gap summary (port risk)

| Entity | FHIR / REST coverage | W2 scope | Port risk |
|---|---|---|---|
| Patient | ✅ Full | required | LOW |
| Allergy | ✅ Full CRUD | required | LOW |
| Problem | ✅ Full CRUD | required | LOW |
| Medications (issue) | ✅ MedicationStatement read | required | LOW |
| Prescriptions (Rx) | ⚠️ MedicationRequest read only | required | MEDIUM (read-only OK) |
| Care Team | ✅ read | required | LOW |
| Encounter | ✅ read | optional | LOW |
| Vitals | ✅ read (Observation) | optional | LOW |
| Labs | ✅ read (DiagnosticReport) | optional | LOW |
| Appointments | ✅ read | optional | LOW |
| Immunizations | ✅ Full | optional | LOW |
| Documents | ✅ Full | n/a | LOW |
| Insurance | ⚠️ Coverage read only | n/a | MEDIUM if we want write |
| **Pnotes (messages)** | ❌ **none** | n/a | HIGH if we keep |
| **Disclosures** | ❌ **none** | n/a | HIGH if we keep |
| **Amendments** | ❌ **none** | n/a | HIGH if we keep |
| **Reminders** | ❌ **none** | n/a | MEDIUM if we keep |
| **Recall** | ❌ **none** | n/a | MEDIUM if we keep |
| **LBF custom forms** | ❌ **none** | n/a | HIGH if we keep |
| **Track Anything** | ❌ **none** | n/a | MEDIUM if we keep |

---

## 25. Recommendations for the W2 port (data side)

1. **Stay inside the green zone.** The W2 spec only asks for entities
   that already have full FHIR coverage. Stick to those for parity.
2. **Pick a "+1" with API coverage.** The optional-section choices that
   have full FHIR coverage are Encounters, Labs, Vitals, Immunizations,
   and Appointments. Picking one of those keeps the port pure-FHIR.
3. **Defer the HIGH-risk entities.** Pnotes, disclosures, amendments,
   LBF, and reminders all need custom endpoints. We do not have to
   ship them in W2.
4. **Confirm squad enforcement on the API layer** before declaring
   parity. Otherwise the new UI may show patients the legacy dashboard
   would have hidden.
5. **Treat list_options labels as data.** Don't bake enum strings
   ("Active", "Resolved", "Primary") into the client; fetch from
   `/fhir/ValueSet` so they stay in sync with the admin UI.
