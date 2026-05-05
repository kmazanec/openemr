# Consolidated Interview Notes — Clinical Co-Pilot

**Purpose:** Input for user-journey mapping. Captures pre-visit, in-visit, and post-visit context across nurse and physician roles to inform product scoping.

**Sources:**
- Nurse interview (N) — `nurse-interview.md` — conducted: 2026-05-01
- Physician interview (D) — `doctor-interview.md` — conducted: 2026-04-29
- Question bank — `doctor-interview-questions.md`

Verbatim fragments cited with source line numbers in brackets, regrouped under question-bank headings. Hospital and individual identifiers redacted.

---

## TL;DR

- **Workload:** Physician sees ~19 patients/day in 20-minute slots; ~20% new. Documentation backlog compounds — same-day or efficiency collapses by week's end.
- **Panel-first workflow:** Right-side summary panel is the entry point. Panel content order matters; physician wants ranked-by-risk diagnoses, recent visits, meds, self/PCP notes, with specialist notes excluded by default.
- **Trust thresholds:** Hard evidence (labs, imaging) outranks patient self-report; chart errors are noticed but don't break trust if relationship is established. Wall-of-text output is the failure mode physician fears most after silent inaccuracy.
- **Drug interactions:** Check at *order time*, not appointment time. Existing alerts pop on prescribe/renew. Risk model spans absolute / relative contraindications and adverse effects, with patient benefit weighed against existing profile.
- **Liability:** Falls on physician regardless of tool involvement. Tool must be defensible to the CTO/CMO of medicine. Software-as-a-Medical-Device classification is on the table.
- **Adoption:** Champion-driven (chiefs + internal IT) → known early adopters → fast-follow within months. EMR target = Epic, currently rolled out to <10% of patients at the participating site.

---

## Workflow & Time Pressure

**Volume / cadence (D)**
- 19 patients [D:1]
- 20 minutes per session [D:2]
- 20% of patients are new [D:4]
- would use more often with new patient [D:39]
- initially perceived family care to be a routine check with patients, maybe 1-2 times a year [D:45]
- chronic illnesses more frequently sick / so many compounded illnesses [D:47–48]

**Pre-visit prep (N)**
- Patient has emergency give them a rundown [N:3]

**Documentation timing (D)**
- some things typed, though better automated [D:66]
- primarily on phone for Abridge [D:68]
- right after visit 3-5 minutes, patients understand delay [D:70]
- compounding delays if you don't do it for a day -> multiple days -> end of week have to annotate [D:72]
- tired, frustrated, scrambled brain efficiency [D:73]
- bedside manner maximized due to being able to be away from computer/note taking [D:60]

**Follow-up timing (D)**
- when to follow up [D:62]
- How much time passes post consultation? Usually handled same day unless a missed concern is noticed/flagged [D:64]

---

## The Chart & Current Tools

**Right-panel summary contents (D)** [D:7–23]
- Notes summary on a right panel
- 5 sentence summary
- current diagnoses
- demographics
- preconditions
- shows important / chronic / comorbidity-based diagnosis, ranked by risk factor
- symptoms
- recent visits
- medication
- notes from self / past encounters
- notes from other primary care providers, seemingly grouped by care type
- specialist notes excluded
- pertinent info
- references at bottom

**Chart elements nurse references (N)**
- Labs pre-visit summary [N:19]
- Current diagnoses [N:21]
- Specialist notes — Referred directly / Saw specialist and report / referral to specialist — "request report" [N:23–26]
- Limit surfaced results to those related to current visit, e.g. ER visit for broken arm not directly relevant to specialist heart disease visit [N:28–29]
- Related to chief complaint [N:42]
- Previous values [N:44]
- Risk factors [N:51]
- What are the underlying conditions [N:53]
- Which conditions were newly added since last visit? [N:54]

---

## Information Quality & Completeness

**Medication list accuracy (N)**
- Reconsolidation of the medications [N:9]
- medication may no longer be active [N:10]
- Adherence to medications varying between patients [N:56]

**Conflicting info, patient vs. chart (D)**
- When inaccurate claim chart, look into it further [D:25–26]
- errors don't dissuade since personal relationship established [D:27]
- When evaluating differing claims from patient standpoint — patient dependent → memory impairment [D:50–51]
- labs, imaging, hard evidence takes priority over self-diagnosis [D:53]
- hypochondriac tendencies, especially as more conditions stack and outcomes are misattributed [D:54]

**Lab values (N)**
- Doctors ought to be able to make "in-range" determinations given 8–11 years of schooling [N:37]
- Lab value and know they're not in range [N:39]
- Determined that OpenEMR does not have configurable range settings — may be an enhancement [N:40]

---

## Trust & AI Outputs

**Existing AI tool: Abridge (D)**
- abridge for documentation [D:56]
- identify voice based attribution [D:57]
- isolate patient [D:58]
- abridge services — store note data [D:75]
- generates entire conversation [D:76]
- abridge summarizes — specific to the schema of the internal note-taking system [D:78]
  - subjective — history point of view patient [D:79]
  - objective — markers and ranges vitals [D:80]
- summarizes entire conversation [D:83]

**Failure tolerance (D)**
- not dangerous but annoying if there's a wall of text [D:29]

---

## Drug Interactions & Clinical Rules

**When to check (N)**
- At order time is when Drug to Drug interaction should be checked [N:16]
- too early at appointment time [N:17]

**Interaction alerts (D)**
- allergy or drug interaction [D:34]
- pops up when prescription being ordered or renewed [D:35]
- potential risk, though usually possible — communicated directly to patient [D:36]

**Risk framework (N)**
- Benefit to the patient [N:58]
  - Risk assessment for existing profile [N:59]
  - Absolute contraindications [N:60]
  - Relative contraindications [N:61]
  - Adverse effects [N:62]

**Specific risks (N)**
- Serotonin risks [N:65]
- SSRI overload [N:66]
- Label of dosage needs to come back 1:1 [N:35]

**Pharmacy ecosystem (N)**
- Are there any other pharmacists double checking prescription risks [N:68]
- Patient could get meds from mom and pop shop and not have their history centralized [N:70]
- Mail order for long term meds [N:71]
- Centralized hubs for medical information not always a guarantee — patient EHR may be fragmented across hospital/clinic systems [N:73]
- Federal-level guidelines govern medication and dosing standards [N:75]

---

## Roles & Collaboration

**Pre-visit handoff — nurse side (N)**
- A nurse comes in or medical assistant [N:6]
- Get the vitals [N:8]
- nurse taking vitals [N:12]
- Doctor needs to verify the vitals [N:14]
- No calls unless test results / didn't see something in a chart [N:48–49]

**Pre-visit handoff — physician side (D)**
- Physician consumes nurse-collected vitals plus the right-panel summary before entering the room [D:6–23]
- Notes from other primary care providers grouped by care type, surfaced in panel [D:19–20]
- Specialist notes excluded by default — referral/report flow handled separately [D:21]

**Documentation handoff (D)**
- emr access control — write access, read access may be limited [D:81] *(see Liability for governance implications)*

---

## Liability & Comfort

- Liability falls back to the physician [N:31]
- If incorrect action taken, liability falls on doctor [D:31–32]
- Software as a Medical Device [N:33]
- Needs to be defensible enough to present to CTO/CMO of medicine [N:46]
- emr access control — write access, read access may be limited [D:81]

---

## Adoption & Change

**Current Epic usage (D)**
- 6 months ago Epic rolled out to certain providers [D:41]
- use Epic with less than 10% of patients [D:42]
- fine as is for ux in terms of screen estate [D:43]

**Hospital adoption path (D)** [D:85–103]
- Adoption into hospital system, e.g. [redacted hospital]
- Champions
  - executive suite physicians, chiefs, administrative physicians
  - internal IT
- known early adopters
- early adopters then fast follow
- within a series of months
- EMR — Epic
- provider approval
- testing
- ai healthcare — cost
