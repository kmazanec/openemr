# Patient Dashboard — UI / UX Flow Audit

> **Scope.** Every interaction a clinician can trigger from the dashboard,
> grouped by region. Each flow lists trigger → target → behavior → state
> change. Anything fragile or surprising is flagged as a **porting hazard**.

The dashboard is a Knockout-bound iframe shell (`main.php`) hosting the
patient summary page (`demographics.php`) inside a tab named `pat`. Most
interactions fall into one of three buckets:

1. **Tab/frame navigation** — handled by `tabs_view_model.js` and
   `frame_proxies.js`; iframe targets are addressed by hardcoded names
   (`pat`, `enc`, `rev`, `pop`, `fin`, `cal`, `msg`, `gdg`, `gfn`, `por`,
   `msc`, `fax`, `sms`).
2. **Modal dialogs (`dlgopen`)** — every "edit" / "add" button and almost
   every popup. `dlgopen` is OpenEMR's wrapper around jQuery-UI dialog +
   Bootstrap modal.
3. **Async fragment reload** — `placeHtml()` re-fetches a fragment when its
   underlying data is mutated.

---

## 1. Header / identity bar (`patient_data_template.php`)

| Trigger | Source | Behavior |
|---|---|---|
| Click patient name | line 100, `data-bind="click:refreshPatient"` | Calls `loadCurrentPatient()` (`tabs_view_model.js:283`) which `navigateTab(demographics.php, 'pat')`. Refreshes the dashboard for the active patient. |
| Click ✕ next to patient name | 105, `data-bind="click:clearPatient"` | `clearPatient()` (`tabs_view_model.js:408`) — closes the `pat`, `enc`, `rev`, `pop` tabs, opens the finder; then POSTs `library/ajax/unset_session_ajax.php?func=unset_pid` to clear the session pid. |
| Click DOB chip / age badge | 112+ | Read-only Knockout binding; no action. |
| Toggle attendant slide | `main.php:535-538` (`#patient_caret`) | Slides `#attendantData` open/closed and toggles the caret class. |

Notification dropdowns in the same bar (bound from `user_data_view_model.js`):

| Trigger | KO binding | Behavior |
|---|---|---|
| Messages icon | `viewMessages` (line 79) | `navigateTab('/interface/main/messages/messages.php', 'msg')`. |
| Portal Mail | `viewPortalMail` (93) | Opens portal inbox in `por` tab. |
| Portal Audits | `viewPortalAudits` (86) | Opens audits view in `msc` tab. |
| Portal Payments | `viewPortalPayments` (107) | Same URL as audits — see bug catalog. |
| Fax / SMS counter | `viewFaxCount` (154) | Opens the `oe-module-faxsms` UI in the appropriate tab. |

Counters (`portal()`, `portalAlerts()`, `messages()`, `smsAlerts()`,
`faxAlerts()`) are populated by the 60 s `goRepeaterServices()` poll in
`main.php:193-288`.

---

## 2. Top nav (`main.php`)

| Region | Behavior |
|---|---|
| Logo | If `display_main_menu_logo` is on, renders an external link (defaults to `https://www.open-emr.org`). |
| Main menu (Patient/Fees/Modules/Admin/Reports/Misc) | Dropdowns populated from `MainMenuRole::getMenu()` and rendered via Twig. Each leaf calls `loadFrame(...)`/`navigateTab(...)`. |
| Global search box (`#anySearchBox`) | Pressing Enter triggers `#search_globals.mousedown()` (line 549), which fires the Knockout `viewPtFinder(...)` binding → patient-finder tab. Mode comes from `search_any_type` global; an alert fires when the field is empty in `comprehensive` mode. |
| User dropdown | Logout, password change, settings — each `dlgopen`s its own modal. |

---

## 3. Tab strip (`tabs_view_model.js`)

| Action | Function | Notes |
|---|---|---|
| Click a tab | `tabClicked(data, evt)` | Sets `tab.visible(true)` on the target, false on others. No persistence. |
| Refresh tab | `tabRefresh(data)` (91) | Self-navigates the iframe to its current URL. |
| Refresh by name | `tabRefreshByName(name)` (110) | Used by edit-modal `onClosed` callbacks. |
| Close tab | `tabClose(data)` (119) | Removes from observable array; activates next tab. |
| Close by name | `tabCloseByName(name)` (129) | Used by `clearPatient()`. |
| Navigate | `navigateTab(url, name, afterLoad)` (141) | Either reuses the named iframe or instantiates a new one. |
| Track click | `tabs_view_model.js:396` | POSTs to `library/ajax/track_events.php` for usage telemetry. |

---

## 4. Hotkeys (`shortcuts.js`)

| Combo | Effect |
|---|---|
| `Alt+1` | Open `main_info.php` in the `cal` (calendar) tab. |
| `Alt+2` | Open the patient finder in the `fin` tab. |
| `Alt+R` | Wired but currently a no-op (commented "not working just yet" in source). |
| `Alt+Shift+W` | `clearPatient()` — close all patient tabs and unset the session pid. |

There are no per-card hotkeys.

---

## 5. Per-card actions (`demographics.php`)

Every card on the dashboard has the same 3-piece action surface:

1. **Caret / chevron** — Bootstrap collapse via `data-toggle="collapse"`.
   The `data-target` is the card body's id. Collapse state is persisted
   through `library/ajax/user_settings.php` (POSTs `id` ↔ `value` pairs;
   tied to `getUserSetting()` reads at render time). Triggered from
   `demographics.php:451,459,903`.
2. **Edit button** — usually `load_location(url)` or `dlgopen(url, ...)`,
   sometimes a JS callback like `editScripts(url)` or `advdirconfigure()`.
3. **Add button** — same shape as Edit, often pointing at the same
   target with a `mode=add` query param.

The "edit/add" target tables are documented in `01-feature-map.md`.

---

## 6. Modal dialogs triggered from `demographics.php`

`dlgopen` calls live in inline `<script>` blocks. Each opens a hidden
iframe inside a Bootstrap modal.

| Trigger / class | URL or named modal | Dimensions | Purpose |
|---|---|---|---|
| `referentialCdsClick(codetype, codevalue)` (387-394) | `../education.php?codetype=…&codevalue=…` | 1024 × 750, force `_blank` | CDS-Hooks education link from a coded element. |
| `oldEvt(apptdate, eventid)` (397-403) | `../../main/calendar/add_edit_event.php?…` | 800 × 500 | Open existing appointment. |
| `advdirconfigure()` (406-407) | `advancedirectives.php` | 400 × 500 | Configure advance-directive document. |
| `deleteme()` (416-427) — currently dead code, marked `@todo don't think this is used any longer` | `../deleter.php?…` | 500 × 450 | Patient delete; on-close calls `imdeleted()` which would call `top.clearPatient()`. |
| `newEvt()` (435-441) | `add_edit_event.php?…` | 800 × 500 | New appointment. |
| `editScripts(url)` (470-474) | `controller.php?prescription&list&id=…` (Smarty) | `modal-xl` × 400 | Inline Rx editor (non-eRx mode). |
| `.medium_modal` (638-688) | clinical reminder href | 800 × 200 | CDR reminder open; `onClosed: 'refreshme'`. |
| `.cdr-rule-btn-info-launch` (690-735) | named modal `cdrEditSource` | 800 × 200 | Show source rule for a CDR action. |
| `.large_modal` (737-753) | various | 1000 × 600 | Generic large iframe popup. |
| `.rx_modal` / `editAmendments` (755-767) | amendment edit form | 800 × 300 | Amendment editor. |
| `.image_modal` (769-779) | photo viewer | 400 × 300 | Patient image lightbox. |
| `.deleter` (781-797) | various deleter URLs | 600 × 360 | Generic deleter; CSRF passed via FormData. |
| `.iframe1` (799-814) | various | 350 × 300 | Encounter mini-popup. |
| `.small_modal` (816-830) | various | 550 × 550 | Generic small popup. |
| `#reminder_popup_link` (auto-fires on load, 832-852) | `../reminder/active_reminder_popup.php` | 500 × 250 | CDR alert popup, opened automatically when the (hidden) anchor's `href` is set (line 1062). Suppressed when CDR is disabled. |
| `#birthday_popup` (auto-fires on load, 855-870) | `birthday_alert/birthday_pop.php?pid=…&user_id=…` | 300 × 170 | Birthday popup if today (anchor at 1063). |

Calendar `dlgopen` calls use **relative paths** (`../../main/calendar/…`)
which means the dashboard *must* be loaded from
`interface/patient_file/summary/` for the modals to resolve. Porting hazard.

---

## 7. Inline editors

There are essentially none. The dashboard reaches modals or full-page
forms for every non-trivial edit. Two exceptions:

- **Treatment Intervention Preferences** and **Care Experience
  Preferences** — the "Add" button toggles the inline editor in place via
  the `js-card-toggle-edit` class. The actual editor markup is rendered
  by the card's Twig template; submit is via fetch.
- **Patient note "Completed"** — `pnotes_fragment.php` posts back to
  itself with `?docUpdateId=<id>` and re-renders the fragment.

---

## 8. Fragment lifecycle

```
demographics.php → placeHtml(url, divId, embedded?, sessionRestore?)
                    ↓
                fetch(url) → response.text() → div.innerHTML = …
                    ↓
                inline <script> blocks executed
```

Fragments that can mutate dashboard state (e.g. notes "Completed", LBF
edits) re-call `placeHtml()` after a successful update to refresh just
that card. There is no global cache invalidation or push.

**Hazards:**

- Each fragment re-includes `globals.php`, re-runs auth & ACL, re-mints
  CSRF — that's a lot of work per dashboard load.
- Inline `<script>` in fragments rebinds handlers each fetch — porting to
  a SPA framework should consolidate this into a single component.
- Fragment URLs are document-relative (`pnotes_fragment.php` etc.), which
  again couples them to the parent path.

---

## 9. Auto-fired flows on dashboard render

In addition to fragment loads, the dashboard auto-fires several actions
when the page mounts:

- **Reminder popup** — `#reminder_popup_link` is rendered (hidden) at
  line 1062; if CDR is enabled and the reminder href is non-empty,
  `dlgopen` opens it shortly after `DOMContentLoaded`.
- **Birthday popup** — same pattern at 1063.
- **`top.restoreSession()`** — fired in many inline callbacks before any
  navigation to keep the parent's session alive.
- **`top.set_pid(…)`** — sets the patient pid into the parent's KO model,
  so the identity strip updates without a full reload.
- **SMART context registration** — `SmartLaunchController` registers the
  current patient against any registered SMART app launch sessions
  (line 95).
- **Background-services tick** — every 60 s, the SPA shell (not the
  dashboard) pings `goRepeaterServices()` and the REST background-service
  endpoint.

---

## 10. Cross-frame messaging (`frame_proxies.js`)

The dashboard expects a global `left_nav` object — historically the
left-nav frame, today the SPA shell — and wires up these methods:

- `left_nav.setPatient(name, pid, pubpid, frname, dob)` — switches the
  patient. Updates the KO patient observables, sets `top.document.title`,
  and `navigateTab(history/encounters.php, 'enc', …)`.
- `left_nav.setEncounter(date, eid, frname)` — switches encounter, used by
  encounter-list rows.
- `left_nav.setPatientEncounter(EncounterIdArray, EncounterDateArray, CalendarCategoryArray)` — populates the encounter dropdown.
- `left_nav.clearEncounter()`, `left_nav.removeOptionSelected(eid)`,
  `left_nav.syncRadios()` — encounter list maintenance.
- `left_nav.setTherapyGroup(group_id, group_name)` — flips the SPA into
  group-therapy mode (different identity strip, different tab set).
- `left_nav.loadFrame(id, name, url)` / `loadFrame2(...)` — generic frame
  loaders used by the menu.
- `RTop.setLocation(url)` — encounter forms call this to redirect the
  `pat` tab.

**Hazards:** every cross-frame call assumes (a) `top` is the SPA shell and
(b) the named iframe exists. Any port that doesn't preserve those names
will break every "open in patient tab" flow from outside the dashboard.

---

## 11. Session-keep-alive plumbing

- `top.restoreSession()` is sprinkled before almost every navigation,
  modal open, and AJAX fetch. It pings the server to extend the session
  cookie. Implementation lives at `library/restoreSession.php`, included
  inline by `main.php:115`.
- The synchronous AJAX in `isEncounterLocked()` (`main.php:298`) blocks
  the UI while it polls — porting hazard.
- Tab navigation always passes `skip_timeout_reset=1` to AJAX endpoints
  that count as "user activity", so as not to count silent polls toward
  the idle-timeout window.

---

## 12. Print / export flows

The dashboard itself has no print button. Print/export happens on the
detail pages reached from card edit links:

- `demographics_print.php` — printable demographics.
- `pnotes_print.php` — printable notes.
- `print_amendments.php` — amendments.
- `disclosure_full.php` → has print/export.
- `report/` directory → continuity-of-care document export (CCDA).

---

## 13. Notable porting hazards (summary)

1. **Hardcoded iframe / tab names** — the entire SPA addressing scheme
   (`pat`, `enc`, etc.) leaks across every JS file and every fragment.
2. **`dlgopen` everywhere** — bespoke jQuery-UI/Bootstrap hybrid; ~15
   call sites in `demographics.php` alone.
3. **Bootstrap-4 collapse data-API** — moving to a modern framework means
   replacing the `data-toggle="collapse"` plumbing wholesale.
4. **Document-relative URLs** — `dlgopen('../../main/calendar/...')`,
   `placeHtml('vitals_fragment.php', ...)`, fragment self-POSTs all
   assume the dashboard runs from
   `interface/patient_file/summary/`.
5. **Synchronous AJAX in `isEncounterLocked`** — `async: false`. Any
   modern fetch wrapper will need a re-design here.
6. **Inline `<script>` in fragments** — handler rebinding model is
   incompatible with SPA component lifecycles.
7. **Knockout 3 patient observables** — every part of the page
   (notification counters, patient name, encounter list) is a KO observable.
   Replacing them touches every custom binding.
8. **"refreshme" string callbacks on `dlgopen`** — the modal contract is
   stringly-typed; `onClosed: 'refreshme'` resolves a window-scope global
   function.
9. **Session-keep-alive injected inline** — `top.restoreSession()` calls
   are scattered through nearly every action handler; need centralization.
10. **Auto-firing reminder/birthday popups via hidden anchors** — the
    "popup" pattern relies on an `<a>` element whose `href` is read by JS
    moments after DOM ready; brittle.
11. **The Smarty/Twig bridge for Rx** — `editScripts()` calls
    `controller.php?prescription&list&id=…`, which is a Smarty page
    invoked through `chdir()`/`ob_start()` from PHP. The new client must
    decide whether to keep the prescription editor as-is or rebuild it.

---

## 14. UX flow tally

- **~45 distinct end-user-triggered flows** on the dashboard.
- **~15 modal types** opened by `dlgopen`.
- **~10 named iframes** addressed by short codes.
- **4 hotkeys** (one of which is dead).
- **9 async fragments** (one per card kind that loads its body via
  `placeHtml`).
- **8 cross-frame methods** on `left_nav` that the dashboard or its
  modals can invoke.
