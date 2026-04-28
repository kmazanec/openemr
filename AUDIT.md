# OpenEMR Pre-Integration Audit

**Audience:** the team adding an embedded AI agent to this OpenEMR fork.
**Date:** 2026-04-28
**Scope:** the codebase at `/Users/keith/dev/gauntlet/openemr` (master @ `5fb061695`).

---

## Executive Summary

OpenEMR is a 282-table, ~25-year-old PHP application with a modern Symfony/PSR-11 core grafted onto a procedural legacy. For an AI-agent project the good news is there is a clean insertion seam: a Symfony `Kernel`, an `EventDispatcher`, a documented module system, an OAuth2/OIDC + SMART-on-FHIR stack, and a working at-rest encryption layer (`CryptoGen`, AES-256-CBC + HMAC-SHA384). The bad news is everything *outside* that seam — the data model, the audit story, and the request lifecycle — is hostile to anything that wants to take a patient chart and send it to an LLM.

**The five most consequential findings, in priority order:**

1. **No BAA path is currently safe by default.** OpenEMR has audit-event types for reads but they are *configuration flags* (`audit_events_http-request`, `audit_events_query`) that can be — and in fresh installs often are — disabled. FHIR read controllers do not unconditionally audit. Sending PHI to any LLM requires (a) a signed BAA with the provider (Anthropic enterprise and Google Vertex offer one; OpenAI does not by default), and (b) code changes to make read-side audit logging mandatory and tamper-evident before the first byte leaves the process.

2. **The data model will silently mislead the agent.** `patient_data` stores `sex`, `race`, `ethnicity`, `language`, `gender_identity`, `sexual_orientation` as unbounded `varchar`/`text` with no FK to `list_options` despite comments claiming otherwise. Dates use the legacy `0000-00-00` sentinel alongside `NULL`. There are **no foreign key constraints anywhere** in the schema (InnoDB tables, but FKs simply not declared), and `pubpid` (the MRN) is not unique. Clinical content is fragmented across ~39 `form_*` tables, each with its own schema. An agent that assumes referential integrity, type safety, or MRN uniqueness will be wrong on real data.

3. **Latency budget is tight and synchronous.** `max_execution_time = 60s`, `memory_limit = 256M`. There is no message queue (Symfony Messenger is not used), no query cache, and no Redis wrapper despite `ext-redis` being available. `PatientService` already issues a two-query pattern to avoid Cartesian products from 1:N joins, and audit/log tables (`audit_master`, `api_log`) lack indexes on `pid` and `created_time`. A safe agent budget is **5–10s P50 / 30s P99**, with anything heavier deferred to the existing `BackgroundServiceRunner` lease pattern.

4. **The integration surface is unusually clean for a legacy EHR.** `OpenEMR\Core\Kernel` builds a Symfony `ContainerBuilder`, `RegisterListenersPass` auto-wires subscribers, REST routes are closures in `apis/routes/_rest_routes_standard.inc.php` with OpenAPI attributes, and the `interface/modules/custom_modules/` pattern (see `oe-module-weno`) gives a copy-pasteable module template. The agent should ship as a custom module that registers an event subscriber **and** a REST controller — not as patches into `/library` or `/interface`.

5. **AuthN is solid; AuthZ is coarse.** Password hashing is versioned (`AuthHash`), MFA (TOTP/U2F) is implemented, OAuth2/OIDC + SMART scopes are present, and timing-attack mitigation is explicit. But the ACL (`AclMain`) is role/section based with no per-patient or per-encounter scoping, document `sensitivity` is not enforced at the FHIR layer, and there is no break-glass audit beyond `BreakglassChecker.php`. Any agent endpoint must add its own scope check on every call — do not assume a bearer token grants minimum-necessary access.

**Recommendation:** treat the agent as a *new bounded context* — its own custom module, its own REST controller, its own audit event class, its own consent gate, its own de-identification step — that *consumes* OpenEMR through narrow, typed adapters. Do not let agent code reach into `$GLOBALS`, raw `sqlStatement` calls, or form tables directly.

---

## 1. Security Audit

### 1.1 Authentication

- **Password storage:** versioned hashing via `src/Common/Auth/AuthHash.php`, verified through `AuthUtils::passwordVerify()` at `src/Common/Auth/AuthUtils.php:247`. Supports algorithm migration (bcrypt→argon2 etc.) without forcing resets.
- **Timing attack mitigation:** `AuthUtils::preventTimingAttack()` (lines 89–113) runs a dummy hash on unknown usernames so login latency does not leak user existence.
- **MFA:** TOTP and U2F via `src/Common/Auth/MfaUtils.php`, persisted to `login_mfa_registrations`.
- **Session lifecycle:** `src/Common/Session/SessionTracker.php:33-37` enforces DB-backed expiration; default cleanup at 7 days.
- **OAuth2/OIDC:** `src/Common/Auth/OpenIDConnect/` and `oauth2/authorize.php`, with Google Sign-In support.

### 1.2 Authorization

- **ACL:** `src/Common/Acl/AclMain.php` (the `AclMain::aclCheckCore()` static API) on top of the gacl library. Sections include `patients` (`demo`, `med`, `docs`, `rx`), `encounters` (`auth`, `coding`, `notes`), `admin`, `accounting`, etc.
- **Default-deny architecturally**, but enforcement is per-controller — there is no middleware that fails closed if a controller forgets to call `aclCheckCore`. This is the largest authorization risk surface for new code.
- **SMART/FHIR scopes:** parsed in `src/RestControllers/SMART/ScopePermissionParser.php:85-100` (handles ONC `Condition`/`Observation` category restrictions). Bearer tokens validated at `src/RestControllers/Authorization/BearerTokenAuthorizationStrategy.php:29+`.
- **Gap:** `PatientRestController` (lines ~63–95, ~137–150) whitelists search fields but does not appear to enforce per-resource SMART scopes on every code path. Verify before any agent endpoint reuses this layer.

### 1.3 Data exposure vectors

- **SQL:** consistent use of parameterized queries through `sqlStatement($sql, $bind)` and `QueryUtils`. Spot-checked `PatientService.php:277,516` and `AuthUtils.php:164` — no raw concat.
- **XSS:** legacy templates use `attr()`, `text()`, `xlt()` escapers (e.g. `interface/login/login.php:98,106,118`); Twig auto-escapes by default.
- **CSRF:** legacy form endpoints under `/interface/forms/*` need explicit CSRF token verification — confirm before reusing.
- **Multi-tenancy:** site selection done by URL regex in `SiteSetupListener.php:41-53`. No evidence that REST sessions assert site membership beyond `OE_SITE_DIR`. Cross-site queries are possible if site routing is misconfigured.

### 1.4 PHI handling

- **At rest:** `src/Common/Crypto/CryptoGen.php` — AES-256-CBC with HMAC-SHA384, dual key set (DB key + drive key, drive key encrypted by DB key), key versioning via `KeyVersion::CURRENT`. Strong.
- **In transit:** no HSTS in `apis/.htaccess`, no forced HTTPS redirect in shipped configs. Operationally enforced, not application-enforced.
- **Logging:** `EventAuditLogger.php` and `SystemLogger.php` (PSR-3 + Monolog). Logs may contain `pid` and patient names; **PHI redaction is not built in**.

### 1.5 Existing security tooling

- Custom PHPStan rules in `tests/PHPStan/Rules/` already forbid `global`, `eval`, certain curl functions, direct session writes, and direct globals access. Use these — extend them for agent code (e.g. forbid `new AnthropicClient()` outside a single adapter).
- A `/security-review` skill exists for branch-level review.

### 1.6 Top-5 risks for an LLM-integration project

1. **Read-side audit is opt-in.** Fix at the source — make agent reads emit a dedicated `AGENT_PHI_DISCLOSURE` audit event unconditionally.
2. **Full PHI in API responses.** `PatientRestController` returns SSN, driver's license, full contact info. Build a response DTO that excludes these by default for agent consumers.
3. **No per-resource scope check on FHIR reads.** Add a decorator/listener that fails closed.
4. **OAuth refresh tokens** — no explicit rotation evidence. If the agent uses a service account, rotate manually and audit.
5. **Multi-tenant boundary** is URL-derived, not session-asserted. Add a middleware that asserts `session.site_id == request.site_id`.

---

## 2. Performance Audit

### 2.1 Database

- **282 tables** in `sql/database.sql:6`. 521 indexes total, but coverage is uneven.
- **`patient_data`** (`sql/database.sql:8334-8472`): 80+ columns, indexed on `pid`, `uuid`, `(lname, fname)`, `DOB`. **No index on `providerID` or `ref_providerID`** — provider-scoped queries scan.
- **`forms`** (`2460-2478`): compound `(pid, encounter)` index exists; individual lookups by `pid` alone are fine.
- **`audit_master` / `audit_details`** (`149-180`): no index on `pid` or `created_time`. Unbounded growth, table-scan for any patient-scoped audit query.
- **`api_log`** (`92-105`): no index on patient_id, method, or created_time.

### 2.2 Query patterns

- `PatientService::search()` (`src/Services/PatientService.php:392-515`) issues two queries (UUIDs first, then full records) to avoid Cartesian products from 1:N joins on `patient_history`/`contact_address`/`addresses`. Doubles latency vs. a single join but is correct. Pagination cap `MAX_LIMIT = 200` in `QueryPagination.php:22`.
- `EncounterService::search()` (`src/Services/EncounterService.php:80-200`) has 3 LEFT JOINs (form_encounter→patient_data→users→facility) without obvious pagination enforcement.

### 2.3 Caching

- `symfony/cache` is in `composer.json:116` but **`CacheItemPoolInterface` is not used anywhere in `/src/Services`**. No production caching layer exists.
- `ext-redis` is available in dev images but no wrappers reference it.

### 2.4 Bootstrap weight

- Every request loads `interface/globals.php` → vendor autoload → Kernel → OEGlobalsBag → session factory → error handlers. This is non-trivial overhead (~hundreds of ms).
- `max_execution_time = 60`, `memory_limit = 256M` (`docker/development-easy-redis/php.ini`).

### 2.5 Existing external-call precedent

- `ProductRegistrationService` blocks on `https://reg.open-emr.org/api/registration` (no visible timeout).
- `Cda/CdaValidateDocuments` curls `localhost:6662` with `CURLOPT_CONNECTTIMEOUT=10` but no full timeout.
- eRx SOAP integration exists. **The codebase already tolerates ~10–30s synchronous external calls** — there is no cultural expectation of <1s responses.

### 2.6 Background work

- `src/Services/Background/BackgroundServiceRunner.php` — lease-based, table-driven (`background_services`), no message queue, no Symfony Messenger, no worker pool. Either inline-in-request or spawned subprocess.

### 2.7 Latency constraints for the agent

- **Budget:** target P50 5–8s, hard ceiling 30s. Bootstrap eats 1–3s before the agent runs.
- **Cache hot data** in Redis (you'll need to wire it): patient demographics, provider lookup, list_options. 1h TTLs are safe; invalidate on the relevant audit event.
- **Never query inline:** `audit_master`, `api_log`, "all forms for a patient" wildcard joins, cross-patient aggregations.
- **Defer to `BackgroundServiceRunner`** (or introduce Symfony Messenger as part of this project) any LLM call expected to exceed ~5s. Do not let the LLM call sit on the request thread for the full 60s window.

---

## 3. Architecture Audit

### 3.1 Layering (verified)

| Layer | Path | Style |
|---|---|---|
| Modern PSR-4 | `/src` (`OpenEMR\` namespace) | Symfony DI, PSR-3, PSR-11, attributes |
| Legacy procedural | `/library` | Includes, globals, ADODB |
| UI controllers | `/interface` | Mixed — bootstraps Kernel via `globals.php` |
| Templates | `/templates` | Twig (modern), Smarty (legacy) |
| Modules | `/interface/modules/custom_modules` and `/interface/modules/zend_modules` | Custom (Symfony events) and Laminas MVC |

### 3.2 Bootstrap & DI

- `OpenEMR\Core\Kernel` (`src/Core/Kernel.php`) builds a Symfony `ContainerBuilder` and registers a compiler pass `RegisterListenersPass` that auto-wires `EventSubscriberInterface` implementations.
- `interface/globals.php:1-80` is the universal entry — loads autoload, builds Kernel, exposes `OEGlobalsBag::getInstance()`.
- `OpenEMR\BC\ServiceContainer` (line 77) is the BC service-locator with an `override()` hook for modules.

### 3.3 Event system

- Symfony EventDispatcher. Dispatch sites include `src/RestControllers/ApiApplication.php:73-80` (registers ~10 lifecycle subscribers per request), `src/Core/Header.php` (script/style filter events), `src/Core/ModulesApplication.php` (`MODULES_LOADED`).
- Domain events live in `src/Events/*`: `PatientDocumentEvent`, `MenuEvent`, `CalendarFilterEvent`, `ScriptFilterEvent`, etc.
- Subscriber registration: in module bootstrap (`$eventDispatcher->addSubscriber(...)`) or via the container's auto-discovery.

### 3.4 Module system

Two patterns coexist; **use the custom_modules pattern**:

- **Custom (preferred):** `interface/modules/custom_modules/oe-module-weno/openemr.bootstrap.php:14-28` is the template. PSR-4 namespace, `ModuleManagerListener` for install/enable/disable lifecycle, event subscribers wired in bootstrap.
- **Laminas (legacy):** `interface/modules/zend_modules/module/FHIR/Module.php` — full Laminas MVC. Avoid for new work; bridges back to Symfony at line 42.

### 3.5 REST API

- Routes: `apis/routes/_rest_routes_standard.inc.php` — closure-per-route map, dispatched by `apis/dispatch.php`.
- Controllers: `src/RestControllers/*` use `#[OA\Get(...)]` PHP attributes for OpenAPI auto-generation. Spec: `swagger/openemr-api.yaml`.

### 3.6 Database access

- Modern: Doctrine DBAL via `src/Common/Database/ConnectionManager.php` and `QueryUtils`.
- Legacy: ADODB surface API (`sqlStatement`, `sqlQuery`).
- Migrations: `db/Migrations/` (Doctrine Migrations).

### 3.7 Configuration

- Layered: `.env` (Dotenv) → `sites/<site>/config.php` (`$GLOBALS['oer_config']`) → `OEGlobalsBag` (typed getters: `getString`, `getInt`, `getBoolean`).
- Use `OEGlobalsBag::getInstance()->getString('agent_endpoint')` etc. — never read `$GLOBALS` directly.

### 3.8 Existing AI hooks

- **None.** Greps for `ai`, `openai`, `anthropic`, `llm`, `gpt`, `agent`, `assistant` produce only false positives (e.g. "plaintext"). Clean slate.

### 3.9 Top 3 insertion points (ranked)

1. **Custom module + EventSubscriber** — `interface/modules/custom_modules/oe-module-ai-agent/`. Reacts to `PatientDocumentEvent`, `EncounterCreatedEvent`, etc. Cleanest because it requires no edits outside the module directory.
2. **REST controller in the same module** — `src/RestControllers/AgentRestController.php` registered via `_rest_routes_standard.inc.php`. Inherits the existing OAuth2 + bearer token pipeline. Required for any UI-initiated "ask the agent" flow.
3. **Frontend widget via `ScriptFilterEvent`** — inject the agent UI into the patient chart by listening for `ScriptFilterEvent` rather than editing template files. Keeps merges with upstream clean.

---

## 4. Data Quality Audit

### 4.1 Schema permissiveness

`patient_data` stores semantic enums as unbounded strings:

- `sex` `varchar(255)` (line 8360) — `M`, `male`, `Male`, `1` can all coexist.
- `race`, `ethnicity` `varchar(255)` (lines 8368-8369) — `interpreter_needed` (line 8372) is documented as FK to `list_options.option_id` *in a comment*, but **not enforced**.
- `language` `varchar(255)` (line 8338) — should be ISO 639, isn't.
- `gender_identity`, `sexual_orientation` (lines 8447-8448) — `text`, no validation.

### 4.2 Date handling

- `0000-00-00` is a load-bearing sentinel value. `src/BC/Utilities.php:16-30` (`isDateEmpty`) and `src/Services/Utils/DateFormatterUtils.php:40-46` both special-case it. Any agent date math must run input through one of these helpers, not native `DateTime`.
- Mixed types: `DOB date`, `date datetime`, `regdate datetime`, `contrastart date`, `deceased_date datetime` — all nullable, all on the same row.

### 4.3 Free-text overload

- ~30+ `text`/`mediumtext` columns in clinical tables. `form_soap` stores `subjective`/`objective`/`assessment`/`plan` as four `text` columns — narrative, no structure.
- `patient_data.occupation`, `industry`, `care_team_provider`, `care_team_facility` — all unstructured text.

### 4.4 Identity uniqueness

- `patient_data` UNIQUE on `pid` and `uuid` only.
- **`pubpid` (the MRN equivalent) is NOT unique.** Neither is `ss` (SSN).
- A `dupscore` column exists (line 8452) suggesting historical dedup attempts; it is not actively maintained.

### 4.5 Referential integrity

- All tables are InnoDB but **no foreign key constraints are declared**. `forms.pid → patient_data.pid`, `form_encounter.pid → patient_data.pid`, `codes.code_type → code_types.ct_id` — all comment-only references.
- A delete on `patient_data` will silently orphan encounters, forms, audit rows.

### 4.6 Code lists / terminology

- `code_types` has `ct_active` boolean only — no version, no effective date range. ICD-9 (deactivated) and ICD-10 coexist as rows.
- An agent that codes a diagnosis must filter by `ct_active = 1` *and* know the current version externally.

### 4.7 Forms ecosystem

- ~39 distinct `form_*` tables, each with its own schema. `form_vitals` has 45+ columns; `form_soap` has 9. There is no central data dictionary.
- "Read the chart" is not a single query — it is: scan `forms WHERE pid=?`, map each `form_name` to its specific table, join on `form_id`, repeat per form type.

### 4.8 Failure modes for the agent

1. **Wrong-patient load** via non-unique `pubpid`.
2. **Sex/gender enum collision** (`M` vs `Male` vs `1`) leads to wrong clinical defaults.
3. **`0000-00-00` interpreted as year-zero** — age math returns ~2026.
4. **Three-field gender fallback** (`gender_identity` → `sex_identified` → `sex`) all NULL despite one having been entered.
5. **Stale terminology** — agent emits ICD-9 because the row exists.
6. **Custom form modules** create new `form_*` tables the agent has never heard of.
7. **Orphan rows** post-delete because no FKs.
8. **Mixed date representations on the same row** confuse "encounter date" comparisons.
9. **List_options drift** — `race` typed as free text, never matched against the canonical list.
10. **Twig render fixtures stub `xlt()` and `setupHeader()`** — fixture-trained expectations differ from production output (`tests/Tests/Isolated/Common/Twig/fixtures/render/README.md:26-35`).

**Mitigation pattern:** every read into the agent should pass through a typed adapter (e.g. `PatientChartReader`) that normalizes dates, resolves list_options to canonical labels, fails closed on missing required fields, and asserts MRN-of-record.

---

## 5. Compliance & Regulatory Audit

### 5.1 Audit logging

- Tables: `audit_master` (`sql/database.sql:569-590`), `audit_details` (`592-603`).
- Event logger: `src/Common/Logging/EventAuditLogger.php:34-95` with DB sink and optional ATNA/syslog sink.
- API logger: `src/RestControllers/Subscriber/ApiResponseLoggerListener.php:39-80`.
- **Gap:** read auditing is gated on configuration flags (`audit_events_query`, `audit_events_http-request`, `audit_events_patient-record`). FHIR reads will not be audited if these are off. HIPAA §164.312(b) requires audit *controls*, and the OCR enforcement guidance treats undisabled-by-design as the floor.

### 5.2 Data retention

- `documents.date_expires` exists.
- **No purge jobs, no documented retention windows, no schedule.** HIPAA itself does not set a retention period for PHI (state law does — typically 6–10 years), but §164.316(b)(2) requires policies be retained 6 years and applies to audit logs by extension.

### 5.3 Breach notification

- IP auto-block + email on failed auth exists in `AuthUtils`.
- **No breach detection, no patient notification workflow, no HHS OCR reporting helper.** §164.404–410 obligations are entirely operational at the moment.

### 5.4 Encryption

- **At rest:** strong (`CryptoGen` — AES-256-CBC + HMAC-SHA384 + key versioning + dual key set).
- **In transit:** application does not enforce TLS. `apis/.htaccess` has no HSTS, no forced redirect. This is fine if reverse-proxy-terminated, but the agent's outbound LLM call must enforce TLS 1.2+ in code.
- **Key management:** keys auto-created in `sites/<site>/documents/logs_and_misc/methods/` if missing. No rotation schedule, no HSM hooks.

### 5.5 Access control granularity

- ACL sections per `AclMain.php:12-79` are role/section based.
- **No per-patient or per-encounter ACL.** Document `sensitivity` is not enforced at the FHIR controller layer.
- `BreakglassChecker.php` exists but emergency-access auditing is not robust.

### 5.6 De-identification

- **None.** No utilities for the 18 HIPAA Safe Harbor identifiers, no redaction, no k-anonymity. Must be built.

### 5.7 Patient consent

- Demographic fields exist: `hipaa_notice`, `hipaa_voice`, `hipaa_mail`, `hipaa_allowsms`, `hipaa_allowemail`.
- **These are metadata only — they are not enforced by code as access gates.** A "consent to share with AI" field does not exist and would need to be added.

### 5.8 BAA decision matrix for LLM providers

| Provider | BAA available? | Practical posture |
|---|---|---|
| **Anthropic (enterprise/API)** | Yes (commercial terms include HIPAA addendum) | **Preferred.** Confirm no-training, regional residency, and audit access. |
| **Google Cloud Vertex AI** | Yes (covered by Google Cloud BAA) | Acceptable. Manage keys in Cloud KMS; enable Cloud Audit Logs. |
| **AWS Bedrock** | Yes (under AWS BAA) | Acceptable. |
| **OpenAI direct API** | Not by default; case-by-case enterprise DPA + zero-retention | High legal friction. Avoid unless your counsel has the paper in hand. |
| **Self-hosted open weights** | N/A (you're the BA) | Lowest external risk; highest operational burden. |

### 5.9 ONC / 21st Century Cures

- README references ONC certification (`README.md:74`) but certification artifacts are not in `docs/`.
- Information Blocking Rule (45 CFR 171) applies. Routing PHI to an LLM without patient authorization can be construed as either disclosure (HIPAA) or, conversely, as information blocking if the LLM-mediated workflow withholds data the patient/provider is entitled to. Get this reviewed.

### 5.10 Compliance checklist for sending PHI to an LLM

**Must-do (non-negotiable before any PHI leaves the process):**

- [ ] Signed BAA with the provider (Anthropic enterprise, Vertex, or Bedrock).
- [ ] TLS 1.2+ enforced in the outbound HTTP client; certificate verification on; pinning preferred.
- [ ] **Mandatory** audit event for every agent disclosure — new event class, dispatched unconditionally before the network call, persisted before `await`. Do not rely on the existing optional flags.
- [ ] Data minimization adapter — agent input goes through a `PhiBudget` that drops SSN, driver's license, full address, MRN unless the prompt provably needs them.
- [ ] Patient consent gate — new consent field, checked at the controller boundary, recorded as its own audit event when set.
- [ ] No-training, no-retention assertion in the provider request (header/setting per provider).
- [ ] Multi-tenancy: agent endpoint asserts `session.site == request.site` before any DB read.

**Should-do:**

- [ ] De-identification module (Safe Harbor 18) for analytics/training pathways that do not need re-identification.
- [ ] Retention policy on `audit_master` and `api_log` (start with 6 years, configurable).
- [ ] Per-encounter / per-document ACL in the FHIR controllers the agent calls.
- [ ] Force-HTTPS / HSTS in shipped `apis/.htaccess`.
- [ ] Cover the agent code with the existing custom PHPStan rules (`tests/PHPStan/Rules/`) and add a rule forbidding direct LLM-client instantiation outside the adapter.

**Nice-to-have:**

- [ ] ATNA syslog sink already supported by `EventAuditLogger` — wire it for centralized audit.
- [ ] HSM/Cloud KMS for `CryptoGen` keys.
- [ ] Anomaly detection on `audit_master` for unusual agent disclosure patterns.

---

## Appendix A — Files referenced

Security: `src/Common/Auth/AuthUtils.php`, `src/Common/Auth/AuthHash.php`, `src/Common/Auth/MfaUtils.php`, `src/Common/Session/SessionTracker.php`, `src/Common/Acl/AclMain.php`, `src/Common/Crypto/CryptoGen.php`, `src/RestControllers/Authorization/BearerTokenAuthorizationStrategy.php`, `src/RestControllers/SMART/ScopePermissionParser.php`, `src/Common/Logging/EventAuditLogger.php`, `tests/PHPStan/Rules/`.

Performance: `sql/database.sql` (lines 8334-8472, 569-603, 92-105, 2460-2478), `src/Services/PatientService.php:392-515`, `src/Services/Background/BackgroundServiceRunner.php`, `docker/development-easy-redis/php.ini`, `composer.json`.

Architecture: `src/Core/Kernel.php`, `src/Core/OEGlobalsBag.php`, `interface/globals.php`, `src/RestControllers/ApiApplication.php`, `apis/routes/_rest_routes_standard.inc.php`, `apis/dispatch.php`, `interface/modules/custom_modules/oe-module-weno/`, `swagger/openemr-api.yaml`.

Data quality: `sql/database.sql` (8334-8472, 2396, 2418, 2022, 1124, 10596), `src/BC/Utilities.php:16-30`, `src/Services/Utils/DateFormatterUtils.php:40-46`, `tests/Tests/Isolated/Common/Twig/fixtures/render/README.md`.

Compliance: `sql/database.sql:569-603`, `src/Common/Logging/EventAuditLogger.php`, `src/RestControllers/Subscriber/ApiResponseLoggerListener.php`, `src/Common/Crypto/CryptoGen.php`, `src/Common/Acl/AclMain.php`, `apis/.htaccess`, `README.md:74`.
