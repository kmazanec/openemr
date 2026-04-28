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

### UC1: Default Pre-Visit Briefing

> Dr. Patel taps Mrs. Patel's name in her schedule. Without typing anything, she sees: *"Maya Patel, 67, here for diabetes follow-up. A1c last week was 8.2, up from 7.4 in March. Started lisinopril 6 weeks ago for new-onset hypertension. Allergic to penicillin. Last visit 4 months ago for routine follow-up."* She reads it in 8 seconds and walks in.

**The user's problem:** She needs the picture immediately, without typing or speaking, often while walking with a tablet.

**Why an agent:** The briefing is generated from the actual record, prioritized for what's notable about *this* patient. A static dashboard would show the same fields in the same order for every patient and force her to do the prioritization in her head. The agent does it for her.

**Why integrated, not chat-only:** She is not "starting a conversation." She is opening a patient. The briefing appears as part of opening the patient view. The agent's first response requires zero input from her.

### UC2: What Changed Since Last Visit

> *"What's changed for Maya since her last visit?"* — or, more often, she taps a suggested follow-up labeled "What's changed since last visit?" The agent surfaces deltas: new diagnoses, new or stopped medications, new lab results, recent encounters with other providers.

**The user's problem:** Especially for partner-coverage patients and patients she hasn't seen in months, she needs to orient on what's new — not the entire history, just what's changed.

**Why an agent:** "What changed" is a temporal query that depends on the date of the last visit, which varies per patient. The agent computes the delta against the right reference point. A dashboard "recent changes" widget can't know what counts as recent for *this* relationship.

**Why integrated, not chat-only:** She often arrives at this question from the default briefing, prompted by something she saw. The follow-up tap keeps the conversation context — she doesn't have to re-state the patient or the timeframe.

### UC3: Medication Reconciliation Check

> *"What is she currently taking, and is anything new since last visit?"* The agent returns the active medication list with dosages, flagging additions, dose changes, and discontinuations since her last visit. Allergies are surfaced unconditionally.

**The user's problem:** Med lists are the most error-prone part of any patient record, and the most clinically dangerous to get wrong. She needs a clean, current view that flags what's new and surfaces allergy interactions.

**Why an agent:** The verification layer enforces source attribution on every medication claim and runs hard clinical rule checks (allergy conflicts, known interactions). A dashboard can show the med list, but it can't enforce the verification policy that makes it trustworthy in a clinical context.

**Why integrated, not chat-only:** Med reconciliation is a moment of high cognitive load. The physician needs the answer in the same view as the rest of the briefing, not in a separate chat panel.

### UC4: Multi-Turn Drill-Down

> After the default briefing, Dr. Patel taps "Why is the A1c up?" — a suggested follow-up the agent generated based on what's actually in the record. The agent walks back through the recent labs, recent encounters, and any documented context that bears on the question.

**The user's problem:** The default briefing is a starting point. Real questions emerge from what she sees in it. She needs to ask follow-ups without retyping the patient context, often while walking, often without typing at all.

**Why an agent:** Follow-up questions are unpredictable in shape and number. There is no way to design a static UI that anticipates every drill-down. Conversational state — knowing the patient she's asking about, the context of the prior question — is what makes the drill-down fast.

**Why integrated, not chat-only:** Suggested follow-ups generated from the patient's actual record let her drill down with a tap rather than a typed question. She can fall back to free-text when she needs to, but the default interaction is one-tap, not type-a-prompt.

### UC5: Schedule-Aware Morning Prep

> At 7:50 AM, before her first patient, Dr. Patel opens her schedule. The agent has pre-computed briefings for each patient on today's list and flags any with notable items: new abnormal labs, recent ED visits, new medications since last visit. She glances down the list and mentally flags the three patients who need extra attention today.

**The user's problem:** At the start of the day, she wants to know which patients need prep before she sees them — not all 20, just the ones with something notable.

**Why an agent:** "Notable" is patient-specific and clinically judged — it depends on the patient's baseline, their recent history, and what's changed. A simple "patients with new labs" filter is too coarse; a clinician's read of the actual record is what's needed.

**Why integrated, not chat-only:** This use case lives in the schedule view, not a chat panel. The agent's output appears as flags and brief annotations on the existing schedule, not as a separate conversation.

## Default Briefing Structure

Every default briefing follows the same fixed structure. Within each section, content is prioritized — the most clinically relevant items surface first.

1. **Today's appointment context** — chief complaint or reason for visit
2. **Demographics** — name, age, sex
3. **Active diagnoses** — ongoing conditions relevant to current care
4. **Current medications** — with dosages, flagging recent changes
5. **Recent labs** — last 90 days, abnormal values flagged
6. **Allergies** — always surfaced, never omitted
7. **Recent encounters** — last 1-3 visits with date and reason

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
