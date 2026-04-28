# Architecture: Clinical Co-Pilot

## Summary

Clinical Co-Pilot is a read-only AI agent embedded in OpenEMR for the 90-second pre-visit workflow described in `USER.md`. Its primary user is a family medicine physician who needs a fast, source-cited briefing before entering the exam room: appointment context, patient identity, active diagnoses, current medications, recent labs, allergies, and recent encounters. The agent supports follow-up questions within that patient context, but it is not a general medical chatbot and it does not take clinical actions.

The system is split into two bounded parts. OpenEMR owns the clinical boundary: user session, site context, patient context, authorization, chart reads, data normalization, PHI minimization, and disclosure audit. A private Node/TypeScript LangGraph service owns the agent runtime: graph orchestration, LLM calls, claim ledger generation, verification, response formatting, persistence of agent state, observability, and cost tracking. The browser talks only to OpenEMR; the agent service is not public.

The model-facing data contract is a minimized, typed `ChartSnapshot`, not raw SQL rows and not broad FHIR bundles. OpenEMR builds the snapshot through agent-specific adapters that read from OpenEMR services, FHIR resources, or legacy tables as needed, then normalize dates, identifiers, code labels, missing data, and source references. This keeps OpenEMR's legacy schema and PHI-heavy records away from the LLM surface.

Every response passes through verification before display. The graph produces a structured claim ledger where each factual claim has a source reference. Deterministic verification checks structured facts such as medication names, dosages, allergies, lab values, dates, and source availability. LLM verification may be used only for bounded semantic checks against cited text. Unsupported claims are stripped. Missing safety-critical data, especially allergies and active medications, fails closed and is shown as an explicit gap rather than being silently omitted.

The MVP deployment uses Railway: OpenEMR, a private LangGraph service, managed MySQL for OpenEMR, managed Postgres for agent state, and object storage for documents. This deployment is appropriate for demo data and the project timeline. Real PHI would require signed BAAs, hardened TLS/HSTS, retention policy, centralized audit operations, stronger patient/encounter authorization, and production incident response.

This document describes the architecture as the implementation reference. The user workflow is defined in `USER.md`, the presearch rationale is captured in `docs/PRESEARCH.md`, and the OpenEMR constraints behind these decisions are documented in `AUDIT.md`.

---

## Architectural Principles

- **OpenEMR is the clinical system of record.** The agent reads from OpenEMR and cites OpenEMR records; it does not maintain independent clinical truth.
- **The agent is read-only.** It does not diagnose, prescribe, place orders, write notes, send messages, or update the chart in this version.
- **The browser has one trust boundary.** Users authenticate to OpenEMR, and all browser traffic stays on the OpenEMR origin.
- **The LLM receives minimized clinical context.** It never receives raw database rows, broad patient API payloads, OpenEMR session cookies, or full chart exports.
- **Claims must be source-backed.** A clinical fact that cannot be traced to a source record does not reach the clinician as fact.
- **Safety-critical gaps are visible.** Missing allergy, medication, interaction, or dosage-relevant data fails closed.
- **Audit is explicit.** Agent disclosures are logged by an agent-specific event, independent of optional OpenEMR query or API logging settings.
- **Evals are part of the architecture.** Correctness, authorization, prompt-injection resistance, and failure behavior are tested continuously.

---

## Component Overview

```mermaid
flowchart LR
    Browser["OpenEMR Browser"] --> AgentModule["OpenEMR Agent Module"]
    AgentModule --> AuthPolicy["Auth And Policy Gate"]
    AuthPolicy --> DisclosureAudit["Agent Disclosure Audit"]
    DisclosureAudit --> ChartAdapters["ChartSnapshot Adapters"]
    ChartAdapters --> PhiMinimizer["PHI Minimizer"]
    PhiMinimizer --> AgentService["Private LangGraph Service"]
    AgentService --> Verifier["Claim Verification"]
    Verifier --> AgentModule
    AgentModule --> Browser
    AgentService --> AgentPostgres["Agent Postgres"]
    AgentService --> LangSmith["LangSmith Metadata"]
```

| Component | Runtime | Responsibility |
|---|---|---|
| Browser UI | OpenEMR page/module frontend | Displays briefings, citations, suggested follow-ups, streaming status, and failure messages |
| OpenEMR agent module | PHP custom module | Entry points, route registration, frontend injection, request proxy, policy gate, snapshot construction, disclosure audit |
| Chart adapters | PHP service classes | Typed reads from OpenEMR data sources with normalization and source references |
| PHI minimizer | PHP service class | Drops identifiers and fields not needed for the requested task |
| LangGraph service | Node/TypeScript private service | Agent graph, LLM calls, claim ledger, verification, response formatting, state persistence |
| Agent Postgres | Railway managed Postgres | Conversation state, claim ledgers, source references, verification outcomes, token/cost metadata |
| LangSmith | External observability | LLM and graph metadata only; no PHI prompt/completion bodies |
| OpenEMR MySQL | Railway managed MySQL | OpenEMR source of record |

---

## OpenEMR Integration

The OpenEMR side ships as a custom module under `interface/modules/custom_modules/`. The module should explicitly register its listeners and routes rather than relying on broad container auto-discovery. This keeps the agent isolated from core legacy code and reduces merge friction with upstream OpenEMR.

The module owns four integration surfaces:

- **UI entry points:** Add patient-chart and schedule access through OpenEMR menu, patient menu, or script/header events where supported.
- **Agent HTTP route:** Register module routes through OpenEMR REST extension events where possible, rather than editing `apis/routes/_rest_routes_standard.inc.php` directly.
- **Policy and snapshot services:** Validate requests, create typed `ChartSnapshot` payloads, minimize PHI, and emit disclosure audit.
- **Proxy/streaming bridge:** Forward authorized requests to the private LangGraph service and stream responses back to the browser.

The preferred MVP UI is patient-context launch plus a module-hosted panel. The product target remains a native-feeling embedded panel in patient and schedule workflows, because the default briefing should appear from context rather than from a manually typed prompt.

---

## Runtime Request Flow

### Default Briefing

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant OpenEMR
    participant Agent
    participant Postgres

    User->>Browser: Opens patient or schedule context
    Browser->>OpenEMR: Request default briefing
    OpenEMR->>OpenEMR: Validate session, site, patient, scope
    OpenEMR->>OpenEMR: Emit AGENT_PHI_DISCLOSURE
    OpenEMR->>OpenEMR: Build and minimize ChartSnapshot
    OpenEMR->>Agent: Send request envelope
    Agent->>Postgres: Load or create conversation state
    Agent->>Agent: Synthesize claim ledger
    Agent->>Agent: Verify claims and safety rules
    Agent->>Postgres: Persist response metadata
    Agent-->>OpenEMR: Stream cited briefing
    OpenEMR-->>Browser: Stream response on OpenEMR origin
```

### Follow-Up Question

Follow-up questions reuse the current patient-bound conversation. The browser sends the question and conversation ID to OpenEMR. OpenEMR validates that the conversation belongs to the acting user, current site, and current patient before forwarding anything to the agent. If the follow-up requires additional chart categories, OpenEMR builds a new minimized snapshot for those categories and emits a new disclosure audit event.

Conversations are scoped to one patient context for MVP. This reduces cross-patient leakage risk and keeps citations, verification, and audit review simple.

---

## Data Contracts

### Request Envelope

OpenEMR sends the agent service a request envelope:

```json
{
  "conversationId": "opaque-browser-session-scoped-id",
  "requestId": "server-generated-request-id",
  "siteId": "default",
  "actor": {
    "userId": "openemr-user-id",
    "role": "physician"
  },
  "patient": {
    "pid": 123,
    "uuid": "patient-uuid"
  },
  "task": "default_briefing",
  "chartSnapshot": {}
}
```

The envelope contains no OpenEMR session cookie, no browser-held OAuth token, and no LLM provider secret.

### ChartSnapshot

`ChartSnapshot` is the model-facing clinical context. It is intentionally smaller than a chart export:

- appointment context for the current visit;
- display-safe demographics;
- active diagnoses relevant to the briefing;
- current medications and recent medication changes;
- allergies and intolerance records;
- recent lab observations with dates, units, reference ranges, and abnormal flags;
- recent encounters with date, type, and source-backed summary fields;
- source references for every clinical fact.

Excluded by default:

- SSN;
- driver's license;
- full street address;
- phone and email unless directly needed;
- non-unique MRN/`pubpid` except as display text;
- billing-only data;
- unrelated family/contact fields;
- full historical chart content outside the requested window.

### Source Reference

Every adapter item carries source metadata:

```json
{
  "source": {
    "system": "openemr",
    "recordType": "MedicationRequest",
    "recordId": "source-record-id",
    "field": "dosageInstruction",
    "recordedAt": "2026-04-20"
  }
}
```

The UI uses these references to render citations and to link back to OpenEMR records where practical.

---

## Tool And Adapter Layer

The LangGraph service exposes a small tool surface to the graph. Tools operate on snapshots or call back to OpenEMR agent endpoints; they do not query MySQL directly.

| Tool | Source Adapter | Purpose | Failure Behavior |
|---|---|---|---|
| `get_patient_context` | Patient and condition adapters | Display-safe identity, active diagnoses, allergies | Fails closed if allergy data cannot be verified |
| `get_recent_labs` | Observation/lab adapter | Labs in the relevant lookback window | Fails open with explicit gap unless needed for a safety rule |
| `get_medications` | Medication adapter | Active meds, doses, routes, start/stop/change evidence | Fails closed |
| `get_recent_encounters` | Encounter/forms adapter | Recent visit dates, reasons, source-backed summaries | Fails open with explicit gap |
| `get_todays_schedule` | Appointment/schedule adapter | Acting clinician's schedule and patient launch context | Fails closed on scope ambiguity |

Adapters are responsible for OpenEMR-specific normalization:

- treating `pid` and UUID as identity and `pubpid` as display-only;
- handling `0000-00-00` and empty dates as unknown dates;
- resolving list option/code labels where possible;
- preserving source IDs for citation;
- returning explicit missingness instead of empty strings;
- refusing ambiguous patient context.

FHIR remains useful inside this layer because it provides a portable resource shape. It is not the model-facing boundary.

---

## LangGraph Agent Runtime

The MVP graph is intentionally small and deterministic:

```mermaid
flowchart TD
    Start["Request Envelope"] --> LoadState["Load Conversation State"]
    LoadState --> PlanContext["Resolve Task And Context"]
    PlanContext --> Retrieve["Retrieve Snapshot Facts"]
    Retrieve --> Synthesize["Synthesize Draft And Claim Ledger"]
    Synthesize --> Verify["Verify Claims And Rules"]
    Verify --> Format["Format Cited Response"]
    Format --> Persist["Persist Metadata"]
    Persist --> Done["Stream Response"]
```

### Node Responsibilities

| Node | Responsibility |
|---|---|
| `LoadState` | Load conversation history and patient-bound context from Postgres |
| `PlanContext` | Classify default briefing vs. follow-up and determine needed chart categories |
| `Retrieve` | Read from the provided snapshot or request additional minimized context through OpenEMR |
| `Synthesize` | Produce draft response and structured claim ledger |
| `Verify` | Check source support, hard clinical rules, malformed output, and prompt-injection residue |
| `Format` | Produce clinician-facing answer with citations and explicit gaps |
| `Persist` | Store state, metadata, claim ledger, token usage, cost, and verification result |

The retrieval and verification responsibilities are separated so verification cannot be skipped by a successful-looking draft answer.

---

## Verification Architecture

Verification is a gate between model output and user display.

### Claim Ledger

Each factual claim has:

- claim ID;
- claim text;
- category, such as medication, lab, allergy, diagnosis, encounter, appointment;
- source references;
- safety-critical flag;
- verification status;
- reason when rejected.

Claims without source references are rejected.

### Deterministic Checks

Structured facts are verified without an LLM where possible:

- medication name, status, dose, route, and timing;
- lab value, unit, reference range, abnormal flag, and date;
- allergy substance and reaction;
- encounter date and type;
- appointment date and reason;
- patient identity and current context.

### LLM-Bounded Checks

The verifier may use an LLM to compare a natural-language claim against cited note text. The verifier must receive only the cited source excerpt, not the full chart, and must return a structured pass/fail decision with a reason.

### Safety Rules

- Allergies must always be represented if available.
- Current medications must be verified before medication summaries are shown.
- Interaction and dosage-sensitive warnings are hard stops when present.
- Unsupported or malformed claims are stripped.
- Missing safety-critical data is shown as a failure to verify, not hidden as an omission.

---

## Security And Authorization

### Trust Boundaries

```mermaid
flowchart LR
    User["Authenticated Clinician"] --> Browser["Browser"]
    Browser -->|"OpenEMR Session Cookie"| OpenEMR["OpenEMR"]
    OpenEMR -->|"Private Request Envelope"| Agent["Agent Service"]
    Agent -->|"Provider API Key"| LLM["LLM Provider"]
    Agent -->|"State Metadata"| Postgres["Agent Postgres"]
```

The browser never receives agent service credentials, bearer tokens for the agent service, database credentials, or LLM API keys.

### OpenEMR Policy Gate

Before any chart data is sent to the agent service, OpenEMR verifies:

- authenticated OpenEMR session;
- request site matches active site;
- patient context uses `pid` or UUID;
- acting user has access to the requested patient and data categories;
- request is read-only;
- consent/disclosure policy is satisfied for the environment;
- requested task maps to a supported use case.

OpenEMR's existing session, OAuth/FHIR scopes, and GACL checks are used where appropriate, but the agent module does not assume they are sufficient by themselves. Agent endpoints repeat explicit site, patient, and data-category checks.

### Agent Service Boundary

The agent service accepts traffic only from OpenEMR over the private network. In production, the proxy hop should also use a shared internal secret or mTLS if private networking alone is not considered sufficient. The service rejects requests without a valid request envelope.

### Callback Tools

The preferred MVP is snapshot-first: OpenEMR gathers and minimizes context before invoking the agent. If the agent needs callback tools, those callbacks go only to agent-specific OpenEMR endpoints with short-lived, minimum-scope credentials and the same disclosure-audit behavior.

---

## Audit, PHI, And Compliance Controls

This project uses demo data, but the architecture treats chart content as PHI-equivalent.

### Disclosure Audit

OpenEMR emits `AGENT_PHI_DISCLOSURE` before model-bound chart content leaves OpenEMR. This event is independent of configurable query, HTTP, and API logging.

The event records:

- acting user ID;
- site;
- patient `pid` and UUID;
- conversation ID;
- request ID;
- request purpose;
- data categories disclosed;
- destination service;
- timestamp;
- result status when known.

It does not store raw prompt or completion text. Existing OpenEMR audit tables such as `log`, `log_comment_encrypt`, and optional `api_log` remain useful for platform visibility, but the agent's disclosure record is the authoritative audit event for LLM-bound PHI-equivalent data.

### Logging Policy

- No PHI in PSR-3 log messages.
- No raw prompt or completion bodies in general logs.
- LangSmith traces contain metadata, token counts, timings, tool names, claim counts, and status codes, not chart text.
- Debug capture of raw model input/output is off by default and must be retention-limited and access-restricted if enabled.

### Production Compliance Assumptions

Before real PHI is used, production must have:

- signed BAA with the model provider;
- no-training and no-retention provider terms/settings;
- TLS 1.2+ outbound model calls with certificate verification;
- retention policy for disclosure audit and agent state;
- breach response and incident procedures;
- centralized audit export or monitoring;
- patient consent policy if required by the deployment.

---

## Persistence Model

Agent state lives in a separate Postgres database managed outside OpenEMR's MySQL.

Persisted records:

- conversation metadata;
- patient/user references;
- message turns;
- claim ledgers;
- source reference IDs;
- verification outcomes;
- final response;
- token usage and cost;
- latency and error metadata.

Not persisted by default:

- raw broad FHIR bundles;
- raw SQL rows;
- full chart snapshots after response completion;
- unrestricted prompt/completion bodies.

The separation limits blast radius: a compromised agent service reaches agent conversation data, not OpenEMR's clinical database credentials.

---

## Failure Behavior

| Failure | User-Facing Behavior | System Behavior |
|---|---|---|
| Allergy data unavailable | "Allergies could not be verified" and no unsafe summary | Fail closed, log failure |
| Medication data unavailable | Medication summary unavailable | Fail closed, log failure |
| Lab data unavailable | Briefing continues with explicit lab gap | Fail open with partial result |
| Recent encounters unavailable | Briefing continues with explicit encounter gap | Fail open with partial result |
| Ambiguous patient context | Ask user to open/select patient context | Do not infer from name or MRN |
| Unauthorized patient request | No patient content returned | Deny, audit denied attempt |
| Agent service unavailable | Agent panel shows unavailable; OpenEMR remains usable | No chart data sent |
| Model malformed output | No draft response shown | Reject at verification gate |
| Prompt injection in note text | Injection ignored | Treat chart text as untrusted input |
| Rate limit | Return only already verified safe content or fail closed | Record provider failure |

---

## Observability And Cost

### Metrics

- total response latency;
- time to first streamed token;
- adapter/tool latency;
- graph-node latency;
- model input and output tokens;
- LLM cost per request;
- verification pass/fail rate;
- unverified claim count;
- prompt-injection/adversarial test failures;
- tool failure count;
- requests per clinician;
- requests per patient;
- default briefing vs. follow-up ratio.

### Cost Model

Cost projection is based on observed workflow usage rather than a flat user multiplier:

- patients per clinician per day;
- percentage of patients with a default briefing;
- follow-up questions per briefing;
- average snapshot size;
- verification retry/rejection rate;
- schedule precomputation volume;
- cache hit rate;
- retention storage growth;
- audit volume.

The required production analysis should model 100, 1K, 10K, and 100K users. At higher tiers, infrastructure and audit-state costs become meaningful alongside LLM tokens.

---

## Evaluation Architecture

The eval suite uses Vitest and synthetic OpenEMR records. It runs in CI and on a nightly schedule.

| Tier | Purpose |
|---|---|
| Happy path | Complete synthetic records produce accurate, cited briefings |
| Failure path | Missing meds, missing allergies, missing labs, tool errors, malformed output |
| Adversarial | Prompt injection, unauthorized patient IDs, cross-patient leakage, hidden-data extraction |
| Schema drift | Each adapter returns non-empty, well-shaped DTOs for known records |

Pass criteria:

- every factual claim matches source records;
- every factual claim has a source citation;
- no unsupported medication, allergy, lab, diagnosis, or encounter claim reaches the user;
- unauthorized patient data is never returned;
- prompt injection text inside chart notes is ignored;
- missing safety-critical data is explicit;
- response time stays within the target envelope.

Every production or development bug becomes a regression eval.

---

## Deployment Architecture

The MVP deployment uses Railway with separate `dev` and `prod` environments.

| Resource | Visibility | Purpose |
|---|---|---|
| OpenEMR service | Public | EHR UI, auth, agent module, browser-origin proxy |
| LangGraph agent service | Private | Agent graph and LLM orchestration |
| MySQL | Private | OpenEMR database |
| Postgres | Private | Agent state and metadata |
| Object storage | Private/public by OpenEMR config | OpenEMR documents |

Secrets are Railway environment variables. The repository contains examples/templates only, not real keys.

Rollback is via Railway deployment history tagged to commit SHA. CI deploys to `dev`; stable submission branches deploy to `prod`.

---

## Scale And Performance

MVP target:

- 5-15 concurrent clinical users;
- 5-8 second P50 response time;
- 30 second hard ceiling for degraded cases;
- streaming response to improve perceived latency;
- no large cross-patient or audit-table queries in request path.

Hospital-scale changes for 300 concurrent clinical users:

- move long-lived streaming outside PHP-FPM;
- add application cache for demographics, provider lookup, and list/code labels;
- precompute morning schedule briefings with background jobs;
- add operational indexes for audit/API logs used by reporting;
- strengthen patient-level, encounter-level, and document-sensitivity checks;
- add per-user and per-site rate limits;
- define retention and archival jobs for agent state;
- centralize disclosure audit export and anomaly detection;
- evaluate cheaper verification models only after evals prove no regression.

---

## Rejected Alternatives

### Direct Node-To-MySQL Reads

Rejected because it bypasses OpenEMR authorization and audit, exposes the agent to permissive legacy schema details, and forces data-quality normalization into the Node service.

### Raw FHIR Bundle Prompting

Rejected as the model-facing boundary because raw bundles are too broad, verbose, and PHI-heavy. FHIR remains useful inside adapters and for future portability.

### Standalone Public SPA

Rejected because it creates a second browser origin, CORS/token handling, and a less native clinical workflow.

### Third-Party SMART-On-FHIR App Flow For MVP

Rejected because this is an internal OpenEMR feature, not a cross-EHR marketplace app. SMART-style portability remains a future option through the adapter boundary.

### Self-Hosted Open-Weight LLM

Rejected for MVP because model hosting and GPU operations add too much delivery risk for the project timeline. It remains a possible future option for organizations that prefer infrastructure control over managed-model simplicity.

---

## Decision Summary

| Decision Area | Architecture Decision |
|---|---|
| User workflow | 90-second pre-visit briefing plus patient-bound follow-up questions |
| OpenEMR integration | Custom module with explicit listeners/routes |
| UI boundary | Browser talks only to OpenEMR origin |
| Agent runtime | Private Node/TypeScript LangGraph service |
| Model input | Minimized typed `ChartSnapshot` |
| Data access | OpenEMR adapters; no direct Node-to-MySQL reads |
| Verification | Source-backed claim ledger and verification gate |
| Authorization | OpenEMR session plus explicit site, patient, scope, and category checks |
| Audit | Mandatory `AGENT_PHI_DISCLOSURE` event |
| Persistence | Separate Postgres for agent state and metadata |
| Observability | LangSmith metadata plus service metrics |
| Evals | Vitest happy-path, failure, adversarial, and schema-drift cases |
| Deployment | Railway dev/prod environments |
| Production caveat | Real PHI requires BAA, retention, hardening, and operational controls |

---

## Open Decisions

- Exact UI placement for MVP: chart button, schedule annotation, inline panel, or module-hosted page launched from patient context.
- Exact `ChartSnapshot` DTO field names and retention window.
- Whether default briefings are generated synchronously on chart open or precomputed for the day's schedule.
- Whether schedule retrieval extends OpenEMR's FHIR Appointment search or uses an agent-specific schedule adapter.
- Whether agent callback tools are needed after the initial snapshot, or whether all MVP requests remain snapshot-first.
