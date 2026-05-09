# W2 End-to-End QA Report

**Date:** 2026-05-09
**Scope:** AgentForge Clinical Co-Pilot Week 2 brief + Patient Dashboard surprise challenge
**Method:** Chrome DevTools MCP-driven browser QA + static-artifact audits (eval suite, security, pipeline/supervisor/observability)
**Test patient(s):** Phil Belford (pid=1), Margaret L. Chen (pid=104, archetype p01-chen)

---

## Executive summary

The Co-Pilot's **core W2 features all work end-to-end against the real model** in the live environment:

- ✅ Document ingestion (lab PDF + intake form) — vision extraction, schema validation, bbox/page/quote/confidence per field, idempotency, patient-mismatch refusal.
- ✅ Hybrid RAG with rerank — guideline citations resolve to a section-snippet popover with publisher link.
- ✅ Supervisor + 2 workers — closed handoff enum, real-time clinician-facing narration via SSE, kickoffExtraction → documentEvidenceRetriever → evidenceRetriever → synthesize loop.
- ✅ Citation contract — three `source_type` values rendered correctly; chart chips tooltip-only, guideline chips open snippet popover, extracted_document chips open bbox-overlay drawer.
- ✅ Tier-3 promotion UI — inline Accept/Reject per extracted fact in the "From documents" section; **Tier-3 chart-write path is opt-in only.**
- ✅ Inline trend chart — Hemoglobin A1c rendered as inline SVG when fresh-lab-with-history rule fires.
- ✅ Eval suite — 95 cases across 3 LangSmith datasets, 5 boolean rubrics implemented as pure functions, GitLab CI gate with 5%-tolerance comparator at `.gitlab-ci.yml:242-287`.
- ✅ Patient dashboard — React port renders header (name/DOB/sex/MRN/Active), all 5 required cards, +1 Encounters and +1 Lab Results (stretch), sub-nav, tab strip — under SMART EHR Launch.
- ✅ Cross-tab session survival — stale `token_main` redirects to login (not destroy); concurrent tab kept its session.
- ✅ PHI redaction in agent's structured Pino log (parsed-schema-level: `name=[REDACTED]`, `dob=[REDACTED]`).

The build will plausibly survive the W2 hard gate (regression-injection drill) and the brief's 5-rubric pass requirement.

There are, however, **9 bugs / risks worth fixing before final submission**, ranked below.

---

## 🔴 Critical / hard-gate-risking

### C1. CI gate is GitLab-only; the GitHub fork has no PR-blocking gate
- The `test:agent-evals-gate` job lives at `.gitlab-ci.yml:242-287`; there is **no `.github/workflows/*.yml`** that runs the agent test suite or eval gate.
- If graders inspect the **GitHub repo**, they see no PR-blocking CI — which directly contradicts the W2 brief's "PR-blocking Git Hook" hard requirement.
- **Fix:** mirror the gate steps into `.github/workflows/test.yml` (or document explicitly that GitLab is the canonical CI host).
- COMMENT: NOT A BUG, gitlab only required

### C2. React patient dashboard `/dashboard/` is unreachable from the OpenEMR menu and broken without `main_v2.php`
- The legacy menu still routes the "Dashboard" tab to `interface/patient_file/summary/demographics.php` (the old PHP dashboard). To see the React port, a user must know to type `/dashboard/` in the URL bar.
- Visiting `/dashboard/patient/1` directly fails with `fetchLaunchForPid: api_csrf_token_js not set on window` — the SPA depends on globals seeded only by `main_v2.php`.
- The path that *does* work is `/interface/main/tabs/main_v2.php?token_main=…`, but that's an internal entry point.
- **Fix:** add an `OE_LAUNCH_AUTONOMOUS` boot path that fetches its own CSRF tokens, or redirect `/dashboard/*` → `main_v2.php?…` on the server side.
- COMMENT: NOT A BUG, not meant to work at /dashboard standalone

### C3. OAuth client missing scopes — Lab Results and Vitals/Immunizations are 401-broken
- The active SMART access token carries only 6 scopes: `Patient/AllergyIntolerance/Condition/MedicationRequest/CareTeam/Encounter`. **Missing: `DiagnosticReport.read`, `Observation.read`, `Immunization.read`** that PATIENT_DASHBOARD_MIGRATION.md L429 promises.
- Result: `GET /apis/default/fhir/DiagnosticReport?...` returns **401 Unauthorized** every time, and the Lab Results card in the React dashboard renders **"Couldn't load Lab Results"** with a Retry button on every patient.
- This is the runbook scenario the migration doc warned about ("Re-register a fresh client … via POST /oauth2/{site}/registration"). It hasn't been re-run since the scope list grew.
- **Fix:** re-register the OAuth client with the full scope list and update `dashboard/.env.production`'s `VITE_OIDC_CLIENT_ID`.
- COMMENT: I will fix this manually

### C4. `set_pid()` shim doesn't update the PHP server-side session — every cross-patient briefing is rejected by PolicyGate
- When the React `top.set_pid(104)` shim is called (Margaret Chen), the SPA's in-memory state and the URL update — but **no `library/ajax/set_pt.php` POST is fired**. The legacy AJAX is what writes `$_SESSION['pid']` server-side.
- Subsequent `agent.php?action=briefing&pid=104` hits PHP's `PolicyGate::PatientMismatch` because `session->patientPid` (1) ≠ `request->requestedPatientPid` (104). Returns 403 `{"error":"patientmismatch"}`.
- The legacy patient-finder click path *does* call set_pt.php, so the bug only surfaces when navigation happens through the cross-frame shim or programmatically.
- **Fix:** in `dashboard/src/lib/shims.ts`, call `set_pt.php` from the `set_pid` shim before navigating; or have PolicyGate accept the SMART launch token's bound patient as authoritative.
- ✅ **RESOLVED (2026-05-09).** Both halves landed:
  - **Client-side (`dashboard/src/lib/shims.ts`):** `top.set_pid`, `left_nav.setPatient`, and the `RTop.location` setter (when the URL carries `set_pid=`) now fire-and-forget a `GET library/ajax/set_pt.php?set_pid=…&csrf_token_form=…` against the SPA's `window.csrf_token_js` + `webroot_url` globals before navigating. Same contract `dynamic_finder.php` already uses. Errors are swallowed because the server-side fallback below is the durable trust point.
  - **Server-side (`agent.php`):** mirrors the panel.php convention — when `?pid=` is `ctype_digit` and the actor passes `AclMain::aclCheckCore('patients','med')`, we call `setpid($requestedPid)` before constructing `SessionContext`, so a stale browser-side commit can't lock out the gate. PolicyGate stays the policy point; the ACL check is the trust point. Same pattern `panel.php` / `demographics_full.php` / `pnotes_full.php` use.
  - **Tests:** new `commitSessionPid` + buildTopShims/buildLeftNavShims/buildRTopShims unit tests in `dashboard/src/lib/shims.test.ts` pin the GET shape and the no-csrf / no-fetch no-op behaviour.

### C5. Idempotency cache poisons a doc against the wrong patient indefinitely
- `extraction_artifacts` is keyed only on `(document_hash, extractor_version)`. When a lab PDF is uploaded against the wrong patient first, the pipeline writes a `failed/patient_mismatch` artifact. Re-uploading the same doc against the correct patient hits the cache and returns the cached **failed** verdict — extraction never re-runs.
- I observed this live: Chen's lipid panel uploaded to Belford → refused (correct) → re-uploaded after `set_pid(104)` → instant "patientmismatch" with no new pipeline run.
- **Fix:** when `cached.status === 'failed'` and the failure was `patient_mismatch`, do *not* short-circuit — re-run the pipeline (the new pid may match), or include `pid` in the idempotency key.
- ✅ **RESOLVED (2026-05-09)**, with a corrected diagnosis. The premise above was wrong: a `patient_mismatch` from `patientMatch.ts` flips `state.status='failed'`, and `pipeline/index.ts:82`'s `routeOrCleanup` short-circuits straight to `cleanup` — `persist` never runs, so **no `failed/patient_mismatch` row is ever written**. The "instant patientmismatch on re-upload" the QA observed was the C4 session-pid drift, not a DB cache hit; once the panel rerendered with `pid=104` but `$_SESSION['pid']`=1, agent.php's `PolicyGate::PatientMismatch` 403'd before the supervisor even started.
- Real cache concern (and what the fix addresses): `(document_hash, extractor_version)` ignored `pid`, so the same bytes uploaded under two patients where `patientMatch` *succeeds* on both would silently alias to the first patient's artifact at the persist short-circuit. Fix: include `pid` in the idempotency key.
  - **Migration `1778358276015_extraction_artifacts_pid_in_idempotency_key.sql`** adds `UNIQUE (document_hash, extractor_version, pid)` then drops the prior 2-column UNIQUE. Non-destructive (`ADD CONSTRAINT` guarded by a `pg_constraint` lookup, `DROP CONSTRAINT IF EXISTS`); Down block restores the prior shape.
  - **`ExtractionArtifactStore.findArtifactByDocumentHash`** now takes `pid: number` as a third arg; the `WHERE` clause and both `persist.ts` call sites (pre-lock + under-lock re-check) thread `state.pid` through.
  - C4's session-pid drift is what actually unblocks the live H6 scenario; this C5 fix closes the silent cross-patient aliasing in the success path that would otherwise have surfaced as "the briefing references the wrong patient's lab values." 1138 agent vitests + 254 dashboard vitests pass; eslint + tsc clean on both.

---

## 🟠 High

### H1. CSP is `Content-Security-Policy-Report-Only`, not enforcing
- `dashboard/.htaccess:77` emits Report-Only with no `report-uri`. An XSS that lands in the React bundle would not be blocked, only theoretically reported (and there's no sink).
- The migration doc claims "Strict CSP" but the rollout flag was never flipped to enforced (T6.5 marker still pending per the file's comments).
- **Fix:** flip to `Content-Security-Policy` (no `-Report-Only`) and add a `report-uri` for any future violations.

### H2. PolicyGate exposes raw enum-cased deny reasons to user-visible UI
- `AgentProxyController::respondError($status, strtolower((string) $reasonName))` produces strings like `patientmismatch`, `sitemismatch`, `scopenotpermitted` that the panel renders verbatim as "Service error: patientmismatch". Clinicians shouldn't see internal enum names.
- **Fix:** map deny reasons to clinician-facing strings ("This patient is not loaded in the current chart") in the controller before responding.

### H3. PHI redaction list misses `extractedName` / `extractedDob` / `chartDisplayName` / `chartDateOfBirth`
- The `patientMatch.ts` warning log emits these four fields in plain text. Only Pino-side leaf names like `name`, `dob`, `firstName` are redacted (`agent/src/observability/logger.ts:4-23`).
- Concrete leak observed: `{"extractedName":"CHEN, MARGARET","extractedDob":"1967-08-14","chartDisplayName":"Belford, Phil","chartDateOfBirth":"1972-02-09"}` written to the local Pino dev log.
- W2 brief explicitly says **"Logs must not contain raw PHI."**
- **Fix:** add `extractedName`, `extractedDob`, `chartDisplayName`, `chartDateOfBirth`, `displayName`, `chartName`, `extractedDateOfBirth` to `PHI_LEAFS`.

### H4. Tier-3 promotions only check read-level ACL — clinician with read-only chart access could trigger writes
- `AgentEndpointAuth::authorize` calls `AclMain::aclCheckCore('patients', 'demo')` which is a read bit (`SqlAgentActorResolver.php:49`). The same gate covers Tier-3 promotion endpoints that mutate `lists`, `family_history`, `procedure_report`, demographics.
- A user with read-only chart access could click "Accept" on an extracted fact and the write would succeed.
- **Fix:** add `mayWritePatients` (e.g. `AclMain::aclCheckCore('patients', 'med')`) and call it on every Tier-3 dispatch in `PromoteController`.

### H5. Supervisor narration goes to the user with no PHI scrub
- `briefingRunner.ts:419-421` forwards the supervisor's `narration` field straight to a `supervisorNarration` SSE event. The system prompt nudges toward generic phrasing but nothing structurally prevents the LLM emitting "Looking up Maya Patel's prior A1c…".
- The 200-char cap is the only structural bound.
- **Fix:** run the narration through `phiTraceScanner` (or a stricter regex pass) before forwarding to the SSE channel.
- COMMENT: NOT A CONCERN FOR NOW

### H6. The PolicyGate / set_pid mismatch and the idempotency-cache poisoning combine to make the document upload UX confusing
- Real user flow that breaks: open Co-Pilot for patient A, upload doc that's actually for patient B, get "Service error: patientmismatch", switch to patient B, re-upload — still "patientmismatch" because of cached failure. The user has no way to recover except re-uploading with a tweak that changes the hash.
- **Fix:** either C4 + C5 above, or surface a "this document was rejected against another patient — view that artifact" hint with a clear "force re-extract" affordance.
- ✅ **RESOLVED via C4 + C5 (2026-05-09).** The dead-end was driven by C4 alone (the "cached failure" diagnosis was a misread — see C5's resolution note). With agent.php now session-syncing on every authorized request and the shim layer also POSTing `set_pt.php`, the second upload after a patient switch reaches the supervisor with the correct `$_SESSION['pid']`, runs the pipeline, and either persists or refuses based on the actual demographics — no silent state to clear.

---

## 🟡 Medium / soft

### M1. FHIR `clinical-status=active` filter on AllergyIntolerance returns 0 even when allergies exist
- Verified live against Belford: chart row for penicillin (clinicalStatus.coding.code = "active") IS returned without filter, but `?clinical-status=active` returns total: 0. Same for `verification-status=unconfirmed`.
- This is upstream OpenEMR FHIR behavior, but the React dashboard inherits it. Result: **the Allergies card renders "(No known active allergies.)" for patients who actually have allergies on record.**
- The Co-Pilot agent (which uses custom-DAO endpoints, not FHIR) correctly cites "Recorded allergy: penicillin" — proving the divergence between the two surfaces.
- **Fix (dashboard side):** drop the `clinical-status=active` query parameter and filter client-side, OR document the limitation prominently.

### M2. `LANGSMITH_HIDE_INPUTS / OUTPUTS` defaults to `false` outside production
- `agent/src/server/index.ts:737-739` keys the default off `NODE_ENV === 'production'`. Anything running with `NODE_ENV=development|staging|test` (Railway preview environments, local PHI handling) leaks chart payloads to LangSmith.
- The W2 brief's `no_phi_in_logs` rubric assumes hide-by-default.
- **Fix:** default to `true` always; force operators to opt out explicitly.

### M3. Tier-3 idempotent promotions skip the disclosure event
- `PromoteController.php:213-222`: when `idempotentHit` is true, no `AgentDisclosedEvent` fires. HIPAA's accounting-of-disclosures arguably wants every read/promote call logged regardless of write outcome.
- **Fix:** emit the disclosure even on idempotent hits, with a `replay=true` flag on the event.

### M4. Cost analysis report is missing p50/p95 latency
- `docs/COST_ANALYSIS.md` covers the 100/1K/10K/100K cost tiers cleanly but **never reports p50/p95 latency or identifies a latency bottleneck** — both explicitly required by the W2 brief.
- **Fix:** add a §"Latency" section with p50/p95 per stage (vision, RAG, synthesis, end-to-end) and the dominant bottleneck.

### M5. `KickoffExtractionArgsSchema` enum mismatch — referral_letter doc_type would fail
- `agent/src/graph/types.ts:818` allows only `lab_pdf | intake_form` for kickoff args, while the rest of the system supports `referral_letter` (state types, schemas, vision dispatch). A supervisor handoff with `doc_type='referral_letter'` would throw.
- **Fix:** add `referral_letter` to `KickoffExtractionArgsSchema`'s union.

### M6. Allergy fail-closed asymmetry across multiple low-confidence allergy claims
- `verifier.ts:996-1013` returns immediately on the first low-confidence allergy claim. With 2+ intake forms attached, only the first triggers the category-wide hard stop; later ones still individually reject but the global "Medication summary withheld" cue may not fire.
- **Fix:** walk all allergy claims and aggregate the "any low-confidence" signal.

### M7. Chart-side `[source]` chips are non-interactive `<span>` elements
- Chart citations render as `<span class="copilot-source copilot-source--chart">` with only a `title` attribute (and the title says "Belford, Phil" rather than describing the cited record).
- Users hovering see a generic patient name; clicking does nothing. This is a UX downgrade vs. the legacy dashboard's deep-links to record pages.
- The W2 architecture says chart chips are tooltip-only "where a URL exists, deep-link otherwise" — but the *Recommendations* section's lab-1145 chip *is* rendered as a deep-link `<a>` tag, proving the codebase can do it. Inconsistent.
- **Fix:** either consistently render chart chips as buttons that open a side panel with the row content, or consistently deep-link.
- COMMENT: This should work like legacy, chart citatons show a little popup, not a full drawer, and the popup contains a link to the chart source.

### M8. "1 additional statement could not be verified" is a dead surface
- The badge appears at the end of the briefing summarizing rejected claims. Clicking does nothing — there's no drill-in to see what was rejected and why. For a clinician who wants to know what the agent attempted to say, that's a missed observability surface.
- **Fix:** make the badge expandable with the rejected claim text and reason (`source-record-not-in-snapshot`, `low-confidence-extraction`, etc.).

### M9. Source viewer drawer doesn't refocus when a new chip is clicked while one is already open
- After clicking an ADA guideline chip (drawer opens), clicking an extracted_document chip while the ADA drawer is still open did NOT swap content — I had to close + click again. The W2 architecture says "Clicking another extracted-document chip swaps the document/page/bbox in place".
- **Fix:** the click handler should always replace drawer content with whatever chip the user is currently activating.

### M10. Suggested follow-up button reuses the same prescription content even after a fresh document is processed
- After uploading the intake form, the suggested follow-up still says "Why was Metformin hydrochloride 500 MG Oral Tablet prescribed?" — based on the prior turn's chart context, not the new document. Cosmetic but indicates the suggested-follow-ups generator runs once and isn't refreshed per turn.

---

## 🟢 Verified-working (highlights)

| Feature | Evidence |
|---|---|
| Vision extraction | Lab PDF returned 5 analytes (Cholesterol Total 232 H, HDL 48 L, LDL 158 H, TG 178 H, non-HDL 184 H) with bbox+page+quote+confidence per field |
| Schema strictness | Zod schemas at `agent/src/pipeline/schemas/{labPdf,intakeForm}.ts`; `extra='ignore'`, missing-required = hard error |
| Patient mismatch refusal | Chen's lipid panel uploaded to Belford → confident mismatch → `failed/patient_mismatch` artifact (no Tier-1/Tier-2 chart write) |
| Supervisor narration | Real-time SSE updates: "Pulling a full chart snapshot…" → "Looking up USPSTF hypertension screening…" → "Processing the lipid panel PDF…" → "Reading the document…" → "Document evidence available, drafting briefing…" |
| Closed handoff enum | `agent/src/graph/types.ts:432-439`; iteration cap = 10; cap-hit forces synthesize |
| Citation contract | Three `source_type` values rendered; chart chips tooltip-only (with deep-link in some surfaces); guideline chips open section-snippet popover with publisher link; extracted_document chips open bbox-overlay drawer |
| Bbox overlay | PDF.js canvas + percentage-positioned overlay div (page=2, left:5.3%, top:6.6%, width:82.4%, height:3.2%) — verified against the live intake form |
| Tier-3 inline accept/reject | 8 buttons under "From documents" — Lisinopril, Atorvastatin, Aspirin, Metformin, Essential Hypertension, plus 3 family-history facts |
| Two-table audit | `agent_request_log` has 153 rows: snapshot=126, chart_documents=17, **tier3_promotion=10**, no raw URLs/PHI in stored `categories` JSON |
| Disclosure-audit pattern | `AgentDisclosedEvent` fires on snapshot + chart_documents + tier3_promotion |
| Inline trend chart | `<svg viewBox="0 0 480 160" role="img" aria-label="Hemoglobin A1c trend">` with reference-range band, multi-point path, hand-rolled SVG (no external lib) |
| Cross-tab survival | `main_v2.php?token_main=stale` → redirected to login (NOT `authCloseSession`); existing panel.php tab kept session |
| OpenEMR FHIR endpoints | Patient/Allergy/Condition/MedicationRequest/CareTeam/Encounter all 200 against Belford and Chen via the fhirclient session |
| Patient header | Active badge, DOB, age, sex, MRN — all present on dashboard |
| Sub-nav links | Dashboard / History / Assessments / Report / Documents / Transactions / Issues / Ledger / External Data |
| 50-case eval suite | Actually 95 cases across 3 LangSmith datasets; all 5 boolean rubrics implemented as pure functions; CI gate has 5%-tolerance comparator |
| PHI scanner | `agent/src/observability/phiTraceScanner.ts:80-126` with SSN/MRN/phone regex + 13 PHI keys + canary support |
| Pino redaction (parsed-schema) | Vision-call extraction object's `name`, `dob`, ordering-provider name all show `[REDACTED]` in the dev-only diagnostic log |
| Document-bytes path-traversal defense | `DocumentBytesController.php:272-294` — file:// only, realpath-canonicalized against documents-root, category-tree restricted |
| MIME sniff + size cap + filename sanitize | `document_upload.php:101-110` finfo_buffer + 10MB cap + sanitizeFilename |

---

## Suggested UX improvements

1. **Top nav menu link to the React dashboard.** Add a "New Dashboard" entry under Patient menu so users can find it without typing the URL.
2. **Allergies card should match the legacy dashboard.** When the FHIR filter returns 0 but the chart has allergies, fall back to a non-filtered query and filter client-side. The current empty-state silently hides clinically-critical data.
3. **Lab Results retry button is a dead end.** Re-clicking just re-fires the same 401 — show "Lab Results scope not granted to this OAuth client; ask admin to re-register" instead of a generic Retry.
4. **Chart-source chips:** make them all consistent — either always tooltip, or always deep-linked. Currently inconsistent across sections.
5. **"X claims could not be verified" badge:** make it expandable to reveal what was rejected and why. Today a clinician has no way to see what the model wanted to say but couldn't ground.
6. **Source viewer drawer:** swap content on every click rather than requiring close-and-reopen.
7. **Suggested follow-ups:** regenerate per turn, especially after a new document is attached.
8. **Service-error UX:** map internal error codes (`patientmismatch`, `scopenotpermitted`, `sitemismatch`) to clinician-friendly strings.
9. **Document upload affordance:** the W2 brief expects an attach surface; today's "Choose File" + "Attach a document" pair feels redundant. Pick one (the icon + drag-drop is sufficient).
10. **Idempotency cache rejection:** when a re-upload returns "patient mismatch" but the user has clearly switched patients, the UI should offer "this document was rejected for [other patient] — open that artifact" rather than blocking silently.

---

## Security posture

Detailed audit produced in parallel; consolidated highlights:

| Severity | Item | Verified by |
|---|---|---|
| 🟠 | CSP not enforced (Report-Only) | `dashboard/.htaccess:77` |
| 🟠 | Tier-3 read-vs-write ACL gap | `AgentEndpointAuth.php` + `PromoteController.php` |
| 🟡 | LangSmith hide-by-default keyed off NODE_ENV | `agent/src/server/index.ts:737-739` |
| 🟡 | Pino PHI list misses 4+ patientMatch fields | this report H3 |
| 🟢 | Prompt-injection delimiter `<CHART_DATA>` enforced in synthesize.prompt.ts:103 | static audit |
| 🟢 | Vision system prompt names `<DOCUMENT_PAGE_N>` delimiter, requires bbox+page+quote+confidence | `agent/src/pipeline/nodes/vision.ts:72-90` |
| 🟢 | Verifier substring-matches OCR quote at `locator.field` (no model paraphrase passes) | `verify/verifier.ts:802-859` |
| 🟢 | Snapshot endpoints behind ACL re-check + JWT verification | 19 controllers route through `AgentEndpointAuth::authorize` |
| 🟢 | JWT issuer pinning called on both minter (`agent.php:82`) and verifier (`snapshot.php:124`) | `AgentEndpointBootstrap::resolveIssuer` |
| 🟢 | Document upload MIME content-sniffed via finfo, 10MB cap, filename sanitized | `document_upload.php` + `FilesystemLocalDocumentStore::sanitizeFilename` |
| 🟢 | Document bytes endpoint path-traversal defense | `DocumentBytesController.php:272-294` |
| 🟢 | Cross-tab session destruction patched | `main.php:97-113`, `main_v2.php:118-143` |
| 🟢 | No `dangerouslySetInnerHTML` in `dashboard/src/` | grep |
| 🟢 | No SQL/shell-injection sinks in module | grep |
| 🟢 | No tracked secrets; only `.env.example` files | static audit |
| 🟢 | `agent_request_log` stores no raw URL/PHI (jti + categories JSON only) | `DbalAgentRequestLogRecorder.php:35-47` |

---

## Observability evidence

- 153 rows in `agent_request_log` distributed across snapshot/chart_documents/tier3_promotion
- Per-supervisor-iteration trace events emit decision + reason + narration + tokens + cost (`agent/src/graph/nodes/supervisor.ts:589-606`)
- Per-retriever invocation traces for retrieveChart, documentEvidenceRetriever, evidenceRetriever
- Pipeline traces: vision tokens/cost/extractor_version/confidence histogram, patientMatch score, schemaValidate warnings
- Tier-3 promotion events with acting_user + artifact_id + fact_path + accepted|rejected
- Cost helper `observability/traceMetadata.ts` with priced per-million-token tables and cache write/read multipliers
- $1.00 per-document hard cap enforced at `agent/src/pipeline/nodes/rasterize.ts:45,316-321`

---

## Addendum — Reviewer focus areas (2026-05-09 follow-up pass)

The reviewer asked us to drill into five subsystems beyond the initial pass: clinical guideline matching tightness, bbox alignment, hybrid retrieval merge + rerank, PHI-safe logging comprehensiveness, and CI threshold verifiability. I drove an adversarial USPSTF query live, visually verified bbox alignment on the intake form, and ran two static-audit subagents in parallel.

### Adversarial guideline probe (live)

Probe: "What does USPSTF say about screening for sleep apnea in this patient?" — a topic that exists in the corpus (USPSTF OSA recommendation, 2022, Grade I) but which "in this patient" framing could lure a model into over-claiming.

Result: 🟢 the agent retrieved the correct USPSTF OSA guideline, cited it via three different chunks (`recommendation-summary`, `importance`, `practice-considerations`), kept the **Grade I (insufficient evidence)** designation accurate, drew the correct distinction between routine screening (insufficient evidence) and symptom-driven evaluation (clinically appropriate), and tied the recommendation to Chen's actual risk profile (T2DM, HTN, HLD, paternal MI). Did not false-positive that USPSTF recommends OSA screening.

The verifier rejected 4 unverified statements, surfaced as a "4 additional statements could not be verified" badge — proving rejection-tightness on a real adversarial probe.

### Bbox alignment (live + static)

Live screenshot at `.qa-screenshots/bbox-lisinopril-overlay.png` — the amber overlay aligns precisely with the **"Lisinopril 10 mg PO daily (AM) 2018 …"** row of the intake form's MEDICATIONS table (page 2). Cross-axis alignment confirmed.

Static confirms the coordinate-system contract is internally consistent end-to-end:
- Vision is instructed to emit `[x, y, w, h]` integer **0..1000-grid**, top-left origin (`pipeline/nodes/vision.ts:80-86`).
- Schemas enforce that grid (`labPdf.ts:36-41`, `intakeForm.ts:21-26`).
- Both renderers (React `dashboard/src/lib/bbox.ts:18`, legacy `documentViewer.js:71`) divide by 1000 and emit CSS percent. `BBOX_GRID = 1000`, `BBOX_PAD = 2` grid units (~0.2%).
- Verifier's bbox equality is strict element-wise (`verifier.ts:836`), but **safe** because the SourceReference's bbox is read directly off the stored `ExtractionArtifact` — extraction-time bbox = citation-time bbox = stored bbox. No drift surface.
- Rasterizer DPI = 150 (`pipeline/rasterizer.ts:71`); independent of the 0..1000 grid, so re-rendering at any DPI doesn't break overlays.

### Hybrid retrieval + rerank verifiability

🟢 The 4-lane fan-out (original + paraphrase + step-back + terminology-shift), the parallel Pinecone fan-out, RRF (k=60, rank-based) with chunk-id dedupe, the 100-doc candidate cap, the **single Cohere rerank against the original user query**, and the `degradedRerank` / `degradedRewrite` flags are all wired exactly as the architecture spec describes. No behavioral divergence found.

🟠 Two trace-side gaps that hurt post-hoc verifiability:
- **Per-variant chunk-id lists are NOT in the trace.** `evidence_pinecone_chunk_ids` is a single flat (RRF-fused, deduped) list. You cannot tell from a trace which lane recovered the load-bearing chunk; investigating "did the terminology-shift rewrite actually help?" requires a re-run.
- **Embedding cost and rerank cost are NOT recorded.** Only `latency_ms` is logged. The cost analysis in `docs/COST_ANALYSIS.md` has to estimate these from token counts rather than reading them off the trace.

🟡 One small design nit: the verifier's guideline index key is `${chunkId}::${section}`, but `chunkId` already encodes `${source}::${basename}` and each chunk file has a single `section` value — so `::section` adds zero discriminating power and one extra fail mode (a `section` typo would reject a valid citation as `REJECT_CONTENT` even though `chunkId` resolves uniquely).

### Guideline matching tightness — quote substring contract

🟢 The verifier's quote check is exact-substring + a `containsNormalized` fallback that lowercases, collapses whitespace, and strips `[,;:()'"–—]` only. **Word tokens are preserved** — "Adults 18 years or older" will NOT falsely match "Adults 18 years and older". The match is bidirectional: the snippet body must contain the cited quote OR the claim text must contain the snippet quote (with the same normalized fallback). Tight in both directions.

🟢 Source-id resolution scoped to **this turn's** `evidenceRetrieverOutput` only. `priorTurnContext` is not consulted in the verifier's guideline path (grep-confirmed). A stale citation from a prior turn cannot satisfy a current-turn claim.

### PHI-safe logging — comprehensive scan

The single-pass redaction list at `agent/src/observability/logger.ts:4-23` covers most leaf names but has gaps. The subagent found one new live-path concern beyond the four already in H3:

🟠 **`supervisor.ts:595-596` writes LLM-emitted `decision.reason` and `decision.args` to LangSmith metadata via `setRunMetadata`.** This bypasses Pino redaction (which only intercepts logger calls, not LangSmith metadata) AND bypasses `LANGSMITH_HIDE_INPUTS/OUTPUTS` (which only suppresses the `inputs` and `outputs` fields, not `metadata`). The supervisor's `reason` is unbounded LLM-emitted free text — a model that blends a patient name into the rationale lands it in LangSmith metadata indefinitely. **Real exposure.**

🟡 Other field gaps to add to `PHI_LEAFS`:
- `extractedName`, `extractedDob`, `chartDisplayName`, `chartDateOfBirth` (already in H3 — confirmed)
- `displayName` (PatientAdapter projects to this)
- `parsedSchema` (vision.ts:436 dev-only dump — currently relies on per-leaf redaction inside the object)
- `narration` (SSE narration field, same trust posture as `reason`)
- `reason` (LLM-emitted; high risk)
- `question`, `text` (conversation user-turn text)
- `documentText` (DOCX pipeline-state field)
- `rawValue` (loadPriorContext citation values)
- `bodyPreview` (promote/document_reference error response previews)

🟢 PHP module is clean — every controller logs only `pid`, `siteId`, classified `reason` codes, exception strings.

🟢 `errors[].details.mismatch_reason` only emits classified tokens (`name`, `dob`, `name+dob`, `extracted_demographics_incomplete`, `snapshot_fetch_failed`). No PHI leak.

🟢 `AGENT_DEBUG_VISION_INPUTS` env flag is a comment — no code path reads it. Vision payload always streams via signed URL and the redactor catches `signedUrl` + `extraction`.

🟢 `conversation_messages.payload` is never dumped to logs.

### CI threshold verifiability

🟢 Tolerance is hard-coded constant `REGRESSION_RATE_TOLERANCE = 0.05` at `agent/scripts/eval-gate.ts:60`. No env override. Test pins boundary behavior at 4/5/6%.

🟢 Pass-threshold logic is per-cell boolean: a cell is flipped only when `baselineScore === true && liveScore === false`. Live boolean comes from `scoreToBoolean` at line 252 (`1/true → true`, `0/false → false`, else null/skipped).

🟢 `cap-hit::factually_consistent` baseline-`false` correctly handled — `false → false` is not flipped, `false → true` is not flipped (treated as improvement).

🟢 Vendor outages: per-suite cases drop from numerator AND denominator when the suite's vendor is degraded (`resolveSkippedCases`, `eval-gate.ts:224-245`). Network errors during `collectLiveCells` propagate and exit non-zero. Fail-closed at infrastructure level.

🟠 **The "5%-regression" rule pools cells across all four datasets and all five rubrics.** Denominator is `totalScoredCells` over everything. Per the W2 brief: *"if any category regresses by more than 5%"* — `category` is plausibly per-rubric. Current implementation: a single rubric (e.g. `factually_consistent`) could regress 100% on conversational-graph and stay under 5% globally if that dataset is small relative to others. Verify the brief's intended granularity; if per-rubric, the gate is too lenient.

🟠 **Cases REMOVED since baseline silently disappear if their baseline cell was `false`.** The gate punishes baseline-`true` cells that go missing but not baseline-`false` cells. Comment at `eval-gate.ts:158-161` explains the intent ("we don't punish baseline-`false` cells for going missing — they were already failing"). A `eval-suite.test.ts` is referenced as the case-set pin, but that's a Vitest test, not the gate.

🟠 **Cases ADDED since baseline trigger drift** — `unknownLiveCells` causes a fail-closed even at 0% regression. New cases require a deliberate `npm run rebaseline`. Strict by default — not a bug, just a thing to know.

🟠 **The drill is documented but never executed.** RUNBOOK.md:726 still shows `_pending_`. The drill weakening is `arraysEqual(ref.locator.bbox, snippet.bbox)` at `verifier.ts:781-782` — removing it lets fabricated bboxes through, which would flip `factually_consistent` (claim no longer rejected even though bbox is wrong) and `citation_present`. **Per the project memory item, drills should weaken business logic (prompts), not the deterministic gate** — this drill weakens code, not prompt. The memory rule and the runbook diverge.

🟡 The eval-gate's markdown report is rendered (`renderMarkdownReport`, eval-gate.ts:292-341), posted to GitLab as an MR comment, and printed to stdout — but **not archived as a CI artifact** (no `artifacts:` declaration in `.gitlab-ci.yml:242-287`). Recoverable only from the job log or MR comment.

---

## Updated bug + risk roll-up (additions to the original list)

### 🔴 Critical / hard-gate-risking (additions)

- **C6. Supervisor reason/args → LangSmith metadata is an open PHI channel.** Bypasses Pino redaction AND `LANGSMITH_HIDE_INPUTS/OUTPUTS`. The W2 brief's `no_phi_in_logs` rubric assumes traces are PHI-clean. **Fix:** filter `setRunMetadata` payload at `supervisor.ts:589-606` to drop or hash `decision.reason`, `decision.args`, and `narration`; or apply a pre-emit scrub via `phiTraceScanner` to the metadata object.

### 🟠 High (additions)

- **H6. PendingUploads carry across follow-up turns, re-running vision on every question.** Observed live: after the intake-form briefing, asking an unrelated sleep-apnea question caused the supervisor to re-extract the same intake form before answering. Each re-run is one Anthropic vision call ($0.005/page × 3 pages = $0.015 per turn waste) and ~25s latency. **Fix:** the panel's pendingUploads queue should clear after the first kickoffExtraction succeeds; `briefingRunner` should mirror that. Confirm with a regression case that turn N+1 doesn't re-rasterize a doc seen in turn N.
- **H7. Eval-gate "5%-regression" pools across rubrics and datasets.** A per-rubric or per-dataset breach can hide under the global denominator. **Fix:** also enforce 5% per `(dataset, rubric)` slice; both pooled-and-per-slice should be checked, fail if either trips.
- **H8. Drill never run + drill design weakens code instead of prompts.** Two issues. (a) RUNBOOK.md execution log says `_pending_` — graders running the drill will be the first to see it work. (b) The current drill weakens deterministic code (verifier bbox check), but the project memory says drills should target business logic (prompts) — that gate is what eval is supposed to protect against, not deterministic code. **Fix:** run the drill end-to-end before submission and capture the pipeline URL in RUNBOOK; add a second prompt-weakening drill that flips `safe_refusal` or `citation_present` on the synthesizer prompt.

### 🟡 Medium (additions)

- **M11. evidenceRetriever trace is missing per-variant chunk-id lists.** Can't post-hoc audit which rewrite lane contributed which chunk. **Fix:** stash `[{kind, chunkIds}]` per variant on the trace alongside the fused union.
- **M12. evidenceRetriever trace is missing embedding/rerank dollar costs.** **Fix:** record `embedding_cost_usd`, `rerank_cost_usd`, `total_cost_usd` on every trace.
- **M13. Verifier guideline key `${chunkId}::${section}` is over-specified.** ChunkId already uniquely identifies the chunk; section adds no discrimination power but adds one fail mode if `section` differs by typo or normalization. **Fix:** key on `chunkId` alone, keep `section` as metadata for the renderer's popover anchor.
- **M14. PDF rotation is not handled or audited.** Pages are assumed upright; Poppler's default rotation handling is what bridges the gap. A document with a manual rotation matrix would render-and-overlay consistently but with zero auditing surface. **Fix:** read `getPage().userUnit` or rotation flag, log it on the rasterize trace, propagate as a state field.
- **M15. CI gate's removed-baseline-`false`-case slip.** `eval-suite.test.ts` is the case-set pin but it's not the gate. **Fix:** make the gate also fail when the live case set is a strict subset of the baseline (regardless of cell values), forcing a rebaseline-style step on case removal.
- **M16. Eval-gate markdown report not archived as a CI artifact.** Recoverable only from the job log or MR comment. **Fix:** add `artifacts: { paths: [eval-gate-report.md], expire_in: '90 days' }` to the `test:agent-evals-gate` job.
- **M17. Vision dev-diagnostic dump (`parsedSchema`) leaks non-leaf clinical fields.** The redactor catches `name/dob/address/email/phone/notes` inside the schema, but lab values, allergy substances, diagnoses, and family-history relations are not redacted — they survive in the dev-only Pino log. Per-leaf-only redaction is too narrow for a clinical-content dump. **Fix:** in dev mode, log a count summary (`{ allergies: 3, medications: 4, family_history: 3 }`) instead of the parsed schema.

---

## What we did not exercise

- **Regression-injection drill execution** — RUNBOOK §"Drill execution log" is still `_pending_`. The procedure is documented but never actually run end-to-end.
- **Vitals + Immunizations cards** — pre-wired scopes are documented but the cards themselves are unbuilt (per migration doc) and would 401 today regardless given C3.
- **Real-model nightly experiment runtime cost** — confirmed the wiring exists; did not run a full experiment (~$2.50/PR per architecture).
- **OAuth client re-registration runbook** — documented but not exercised in this session.
- **Demographics delta inline accept** — the architecture supports it but no demographics deltas surfaced in the test extractions.

---

## Submission readiness

**For W2 main brief grading:** the build will pass the **document ingestion, citation, RAG, supervisor + 2 workers, eval gate, observability, and HIPAA-minded** rubrics on substance. The two areas that might cost real points:
- C1 (CI gate is GitLab — graders on GitHub will see no PR-blocking gate). Easy mitigation: add a `.github/workflows/test.yml` that runs `npm test && npm run typecheck && npm run lint` for `agent/` and `dashboard/`, plus the eval-gate step.
- M4 (cost report missing p50/p95 latency). Needs a one-section addition to `docs/COST_ANALYSIS.md`.

**For the dashboard surprise grading:** the build delivers all the "by the end of the week you should have" requirements (OAuth/OIDC login via SMART EHR Launch, patient header, 5 clinical cards, +1 Encounters and +1 Lab Results) and the defense doc is comprehensive. The two issues that might cost real points:
- C2 (`/dashboard/` not reachable from the menu, breaks if accessed standalone). The grader has to be told to navigate to `main_v2.php` to see it.
- C3 (Lab Results card always 401s). One config fix away from working — re-register the OAuth client.

The build is **strong** overall. None of the bugs above are show-stoppers; all have surgical fixes.
