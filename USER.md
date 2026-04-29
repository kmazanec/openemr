# Users: Clinical Co-Pilot

This document defines who the Clinical Co-Pilot is built for, what they need from it, and why a conversational agent — integrated into the workflow they already know — is the right shape for the problem.

Every capability in `ARCHITECTURE.md` traces back to a use case in this document. If a feature does not serve a user defined here, it does not belong in the build.

---

## Primary User: Dr. Patel

Dr. Patel is a family medicine physician at Riverside Family Health, a 12-physician group within a regional health system. She has been practicing for nine years.

Her day looks like this:

- **20-patient scheduled day**, typically running from 8:00 AM to 5:30 PM with a 60-minute lunch that gets eaten at her desk while she finishes notes
- **Mixed patient panel** — about two-thirds are her own established patients she's known for years, and about one-third are partner coverage: patients of her colleagues she's never met, scheduled with her because the partner is out, on vacation, or rounding at the hospital
- **Pragmatic with the EHR** — she is not anti-tech, but OpenEMR is something she works around rather than with. She knows it well enough to find what she needs eventually, but "eventually" is not what she has between rooms
- **Cognitively fragmented before each visit** — the 30 seconds before she opens an exam room door are spent finishing the previous patient's note, walking down the hall, and glancing at her schedule. She is not arriving fresh. She is context-switching constantly
- **Mixed device usage** — she works at the workstation in the hallway between rooms, sometimes on a tablet she carries with her, occasionally on her phone if she's stepping out to take a call

She is, in short, a competent professional who is overloaded. The agent's job is not to teach her medicine. It is to give her back the cognitive space the EHR currently consumes.

## The Central Moment: The 90-Second Window

The defining moment for this product is the 90 seconds between exam rooms.

**The 30 seconds before:** Dr. Patel is finishing notes from the previous patient, walking down the hallway, and glancing at her schedule to see who's next. Her attention is split three ways. By the time she reaches the next door, she has maybe 90 seconds before she walks in.

**The 90 seconds:** She needs to know who this person is, why they're here today, what's changed since their last visit, what they're currently taking, and what she needs to be careful of. For her own established patients, she can usually conjure most of this from memory and confirm with a quick scan. For partner-coverage patients, she's starting from zero. Either way, she has 90 seconds.

**The moment after:** She walks into the room and starts the visit. Sometimes she has a quick follow-up question prompted by what she just saw — "wait, when did she start that lisinopril?" — and she needs to be able to ask it without losing context, without typing more than a tap.

Today, the EHR forces her to navigate four or five screens to assemble this picture. The agent collapses that into one glance.

## Why an Agent, Not a Better Dashboard

A static dashboard, no matter how well-designed, fails this user. Here is why:

**The information that matters is not the same for every patient.** A 67-year-old with diabetes, hypertension, and a recent abnormal A1c needs a different briefing than a 34-year-old here for an annual physical. A dashboard prioritizes the same fields for every patient and forces the physician's eyes to do the prioritization. An agent reads the patient's actual record and surfaces what matters for *this* patient — without the physician having to scan past what doesn't.

**The physician's attention is fragmented.** Walking down a hallway with a tablet, she cannot scan a dense screen of fields. She needs the cognitive equivalent of a colleague handing her a verbal briefing: "this is Mrs. Patel, here for follow-up on her A1c, she started lisinopril six weeks ago, no recent issues, allergic to penicillin." A dashboard makes her assemble that herself. The agent assembles it for her.

**The follow-up question is unpredictable.** After the briefing, she might ask "when was that lisinopril started?" or "what was her last A1c?" or "has she been to the ED recently?" There is no way to design a dashboard that anticipates every drill-down. A conversational interface lets her drill in any direction without leaving the briefing context.

**The agent is not a chat window.** It is integrated into the patient view she's already looking at. She doesn't open a separate app, doesn't switch tabs, doesn't type a prompt to get started. The default briefing is *there* the moment she opens the patient. The conversation is the drill-down mechanism, not the entry point. The chat-only UX would be slower than a dashboard, not faster.

The right framing: the agent is a way to distill a large, dense, multi-source patient record into the small, glanceable, prioritized summary a physician can actually consume in the time they have. The conversational layer exists to handle the drill-down questions that no dashboard can anticipate. Together, they replace the four-screen scavenger hunt with a one-glance answer plus a follow-up tap.

## Use Cases

UC1 is the entry point: the default briefing, generated without any input from her. UC2-UC4 are the three shapes of follow-up the agent auto-suggests as one-tap drill-downs from that briefing — each pulling from a different data category (labs, medications, outside care). UC5 is the same briefing engine applied to her morning schedule view.

### UC1: Default Pre-Visit Briefing

> Dr. Patel taps Mrs. Patel's name in her schedule. Without typing anything, she sees: *"Maya Patel, 67, here for diabetes follow-up. **Since last visit (4 months ago):** A1c rose to 8.2 from 7.4; started lisinopril 6 weeks ago for new-onset hypertension. **Current meds:** metformin 1000mg BID, lisinopril 10mg daily. **Allergies:** penicillin. **Reason today:** routine diabetes follow-up."* She reads it in 8 seconds and walks in.

**The user's problem:** She needs the picture immediately, without typing or speaking, often while walking with a tablet.

**Why an agent:** The briefing is generated from the actual record, prioritized for what's notable about *this* patient. A static dashboard would show the same fields in the same order for every patient and force her to do the prioritization in her head. The agent does it for her.

**Why integrated, not chat-only:** She is not "starting a conversation." She is opening a patient. The briefing appears as part of opening the patient view. The agent's first response requires zero input from her.

**What the briefing always includes:**

- Today's reason for visit (chief complaint or scheduled reason)
- Demographics (name, age, sex)
- Active diagnoses
- Current medications with dosages
- Allergies (always surfaced, never omitted)
- **Deltas since last visit** — new/stopped medications, new diagnoses, new abnormal labs, recent encounters with other providers. This is part of the briefing, not a follow-up.
- Date and reason of last 1-3 encounters

Below the briefing, the agent generates 3-5 contextual one-tap follow-ups drawn from what's actually in the record. UC2-UC4 describe the three most common shapes those follow-ups take.

### UC2: Lab or Vitals Trend Drill-Down

> Dr. Patel reads the briefing and sees the A1c jumped from 7.4 to 8.2. The agent has already generated a suggested follow-up: **"Why is the A1c up?"** She taps it. The agent walks back through the trend: prior A1c values over the last two years, any documented context (medication adherence notes, recent illness, weight changes), and any related labs (fasting glucose, lipid panel) that bear on the question.

**The user's problem:** A number changed. She wants the story behind it without scrolling through lab history and old encounter notes.

**Why an agent:** The follow-up is generated *because* the A1c moved. For a patient whose A1c is stable, the agent would not surface this question — it would surface a different one. The drill-down then synthesizes lab history, encounter notes, and medication history into one answer. A "lab trend" widget cannot read the surrounding notes.

**Why integrated, not chat-only:** The suggestion is a tap, not a typed prompt. She is reacting to something the briefing already showed her; she does not have to formulate a question.

### UC3: Medication Change Drill-Down

> The briefing flags that lisinopril was started 6 weeks ago. The agent suggests **"When was lisinopril started, and why?"** as a one-tap follow-up. She taps. The agent returns: the prescribing date, the prescribing provider (one of her partners, since this is a partner-coverage patient), the documented indication (new-onset hypertension flagged at the last visit), the starting dose and any dose adjustments, and any related notes from that encounter.

**The user's problem:** A new medication shows up on the list. Before she walks in, she needs to know who started it, when, why, and whether anything has changed since.

**Why an agent:** Medication histories are scattered across prescription records, encounter notes, and provider documentation. The agent reads across those to assemble the rationale. A med list shows what is prescribed; it does not explain why.

**Why integrated, not chat-only:** Medication reconciliation is the most clinically dangerous part of any visit. The drill-down lives in the same view as the briefing, with citations back to the actual prescribing record.

### UC4: Recent Outside Care Drill-Down

> The briefing notes a recent imported document on file. The agent suggests **"Has she had any care at other facilities recently?"** Dr. Patel taps. The agent surfaces external encounters parsed from imported CCDA documents: a 3-week-old ED visit at the regional hospital for chest pain (ruled out cardiac, discharged with a follow-up recommendation), and a cardiology consult two weeks later. Citations link back to the imported documents in OpenEMR.

**The user's problem:** Especially for partner-coverage patients, she has no idea what has happened to this patient outside this practice. An ED visit she does not know about is exactly the kind of context that changes how she runs the visit.

**Why an agent:** OpenEMR's `external_encounters` table and CCDA import pipeline capture this data when other facilities send documents — but the data is buried under the documents tab, separated from the active chart view, and easy to miss. The agent reads it and surfaces what is recent and relevant, with citations to the source CCDA.

**Why integrated, not chat-only:** This is exactly the kind of question Dr. Patel would not think to type but would tap when offered. The agent generates the suggestion *because* there is recent imported data; for a patient with none, it surfaces a different follow-up instead.

### UC5: Schedule-Aware Morning Prep

> At 7:50 AM, before her first patient, Dr. Patel opens her schedule. The agent has pre-computed briefings for each patient on today's list and flags any with notable items: new abnormal labs, recent ED visits, new medications since last visit. She glances down the list and mentally flags the three patients who need extra attention today.

**The user's problem:** At the start of the day, she wants to know which patients need prep before she sees them — not all 20, just the ones with something notable.

**Why an agent:** "Notable" is patient-specific and clinically judged — it depends on the patient's baseline, their recent history, and what's changed. A simple "patients with new labs" filter is too coarse; a clinician's read of the actual record is what's needed.

**Why integrated, not chat-only:** This use case lives in the schedule view, not a chat panel. The agent's output appears as flags and brief annotations on the existing schedule, not as a separate conversation.

## Default Briefing Structure

Every default briefing follows the same fixed structure. Within each section, content is prioritized — the most clinically relevant items surface first.

1. **Today's appointment context** — chief complaint or reason for visit
2. **Demographics** — name, age, sex
3. **Deltas since last visit** — new or stopped medications, new diagnoses, new abnormal labs, encounters with other providers. Always surfaced as part of the briefing, not gated behind a follow-up tap.
4. **Active diagnoses** — ongoing conditions relevant to current care
5. **Current medications** — with dosages, flagging recent changes
6. **Recent labs** — last 90 days, abnormal values flagged
7. **Allergies** — always surfaced, never omitted
8. **Recent encounters** — last 1-3 visits with date and reason

The fixed structure is deliberate: Dr. Patel scans briefings the same way every time, which lowers cognitive load. The prioritization within each section is also deliberate: what's clinically notable surfaces above what's routine.

## Interaction Model

**Default state:** The briefing appears the moment Dr. Patel opens a patient. No question is required. No typing.

**Suggested follow-ups:** The agent generates 3-5 contextual follow-up questions per briefing, drawn from what's actually in the patient's record. She can drill down with a single tap.

**Free-text chat:** Available for questions the suggested follow-ups don't cover. Used as a fallback, not the primary entry point.

**Continuous conversation:** No formal modes. The same interface serves pre-visit, mid-visit, and follow-up needs. The conversation maintains context across turns within a single patient.

## Integration Principle

The Clinical Co-Pilot is an OpenEMR feature that happens to be AI-powered. It is not an AI tool that lives inside OpenEMR. The distinction matters.

**Locked integration constraints:**

- The agent surfaces contextually wherever the physician is viewing a patient — both the patient summary page and the schedule view
- It inherits OpenEMR's authentication, RBAC, and navigation — there is no separate login, no parallel access model
- Citations link to the actual OpenEMR records the physician already knows how to navigate, never to synthetic agent-generated views
- The interface is responsive across desktop, tablet, and phone, with parity between touch and keyboard/mouse input
- Visual design follows OpenEMR's existing patterns — colors, typography, component styles — so the agent feels native, not bolted on
- Read-only access to the EHR for this version

**Deferred to architecture phase:**

- Specific visual treatment (sidebar panel vs. inline section vs. modal vs. tab) — to be decided after detailed exploration of OpenEMR's UI patterns
- Specific citation interaction (jump to record vs. expand inline vs. open in modal) — depends on how OpenEMR currently exposes individual records

## Secondary User: The Nurse

Nurses at Riverside Family Health are panel-assigned — each nurse supports a specific group of physicians and has access to that group's patients. Their primary need for the agent is the same as the physician's, but earlier in the workflow.

**Their moment:** The nurse rooms the patient, takes vitals, and asks initial questions before the physician walks in. They need to know who the patient is, why they're here, and what to ask about.

**Their use case:** The same default briefing the physician uses. The information needs are largely the same — patient context, recent changes, what's relevant today. The nurse simply uses it 5-10 minutes before the physician does, with more time and slightly different emphasis on what they act on (vitals trends, intake questions) versus what they review for awareness.

**Architectural implication:** The agent serves nurses with the same briefing, the same tools, and the same verification policy. The only difference is RBAC scope. We chose deliberately not to build role-specific briefing variants in this version — the data needs are too similar to justify the architectural cost. If usage data later shows that nurses need different prioritization, we can add it without restructuring.

**Access scope:** Nurse RBAC is inherited from OpenEMR's existing access model. We do not maintain a parallel scheme. If OpenEMR allows a nurse to see a patient, the agent allows it. If not, the agent does not.

## Not a User: Administrators

Administrators are an RBAC tier in the system but are not a user of the agent. They manage OpenEMR — accounts, permissions, configuration — but they do not have a clinical workflow the agent serves. Including them as a user would be scope creep without a real need behind it.

This is called out explicitly because it is the kind of decision that gets made by default if not made deliberately.

## Non-Goals

What the Clinical Co-Pilot does **not** do:

1. **Not a clinical decision-maker.** The agent surfaces facts and known constraints from the patient's record. It does not diagnose, recommend treatment, or prescribe. Flagging a known allergy or interaction is fact retrieval; making a treatment recommendation is not the agent's role.

2. **Not a general medical reference.** The agent answers questions grounded in the patient's record. It does not provide general medical knowledge unrelated to the patient — questions like "what is the typical dosing range for metformin?" belong in a clinical reference tool, not here.

3. **Not a write-back tool (this version).** Read-only access to the EHR. The agent does not modify records, place orders, send messages, or document encounters. Write capabilities are the planned next-version expansion (see Future Scope below).

4. **Not patient-facing.** The agent serves clinicians only. Patients never interact with it directly.

5. **Not a replacement for the EHR.** The agent surfaces and explains what is in OpenEMR. The physician still uses OpenEMR for everything else: ordering, documentation, full chart review, billing.

6. **Does not take clinical actions on the physician's behalf.** Every clinically meaningful output is read by the physician before being acted on. Pre-computation of read-only briefings is permitted because it produces material for review, not action — the agent prepares; the physician decides.

## Future Scope: Design Implications for Write-Back

Write-back is explicitly out of scope for this version, but it is the natural next step for the product. The agent's most valuable next capability is helping the physician document decisions made during or after the visit — drafting visit notes for review and signature, adding follow-up tasks, recording declined recommendations, generating patient summaries.

The current architecture is built so that this expansion does not require restructuring:

- The tool layer is cleanly separated, so write tools can be added alongside read tools
- The verification layer concept extends naturally to write actions — the same source-attribution logic that verifies claims can verify proposed writes before they reach the database
- Audit logging already imagines write actions and is structured to capture them when added

We are not building write capabilities now. We are building the foundation that makes them possible without rework.

## Source of Truth

This document is the source of truth for who we are building for and what they need. Every capability in `ARCHITECTURE.md` traces back to a use case here. If a feature is proposed and does not serve a user defined in this document, it does not belong in the build — regardless of whether it is technically interesting, demo-friendly, or framework-native.

When in doubt, return to Dr. Patel and the 90 seconds. That is the test.
