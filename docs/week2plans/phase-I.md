# Phase I — Guideline corpus expansion

**Status.** Post-W2 fast-follower phase. Not on the W2 submission critical path. Can run in parallel with Phase H — different code surface (H is verifier robustness; I is corpus reach).

**Phase summary.** The W2 sprint shipped USPSTF as the only guideline source per the locked Q9 expansion sequence: `USPSTF → ADA → ACC/AHA HTN → AGS Beers → CDC vaccines, then stop and review evals`. Phase I is the eval-validated rollout of the additional sources.

The reindex script became source-agnostic in C.2 (`agent/scripts/reindex-corpus.ts` iterates `agent/data/corpus/*/`) and the `evidenceRetriever` `source_filter` enum from C.3 already accepts `'USPSTF' | 'ADA' | 'ACC-AHA' | 'AGS-Beers' | 'CDC'`. Adding a publisher is therefore a fetcher + extractor + commit-the-chunks pair, with no changes to the retriever, verifier, or graph. Each new source's chunk frontmatter declares its `license_tier` (`public_domain` for USPSTF/CDC; `fair_use_cds` for ADA/ACC-AHA/AGS-Beers); the renderer's section-snippet popover already discriminates on that field.

Corpus expansion is sequenced one publisher at a time, eval-validated between each, per the architecture's "no bulk ingest" rule. CDC ships first because it's the only remaining public-domain source — no license-tier carve-out and no production-readiness footnote required.

**Phase definition of done.**
- At least CDC indexed alongside USPSTF.
- Subsequent sources land sub-phase by sub-phase, eval-validated between each.
- `evidenceRetriever` returns hits from each new publication in nightly LangSmith experiment runs.
- Each new source's `license_tier` surfaces correctly in citation popovers.
- Each source's ingest is idempotent and re-runnable; selectors that fail on a page log a structured warning and skip rather than fabricate (carry-forward of C.2's "no model-authored chunks" rule).

**Owner.** Engineer (no UI changes; retrieval-side only).

**Refs.**
- `W2_ARCHITECTURE.md` §"evidenceRetriever" (publisher-at-a-time rule, license_tier metadata, no model-authored chunks).
- `WEEK2-PRESEARCH.md` Q9 (expansion sequence + per-source rationale, license posture, content density).
- `docs/week2plans/phase-C.md` §C.2 (USPSTF reference implementation: fetcher → extractor → reindex pattern).

---

## I.1 CDC clinical guidelines

**Goal.** Three CDC surfaces are fetched verbatim from the publisher, parsed deterministically into per-section chunk files, and indexed into Pinecone alongside USPSTF in namespace `guidelines-v1`. License is `public_domain` across all three. The supervisor can then issue `evidenceRetriever({source_filter: ['CDC'], …})` and get back CDC chunks; absent a filter, CDC and USPSTF compete on hybrid score in the same retrieval call.

The three CDC surfaces are:
1. **ACIP immunization schedules + notes** — adult and child/adolescent. The `*-notes.html` pages carry the per-vaccine clinical guidance keyed by `note-<vaccine>` anchors (covid-19, flu, hepa, hepb, hib, hpv, mmr, mening, mpox, pneumo, polio, rsv, tdap, varicella, zoster). The `*-age.html` schedule landing pages contribute "Purpose" and "How to use the schedule" overview chunks.
2. **CDC opioid prescribing — 2022 Clinical Practice Guideline at a glance** — `/overdose-prevention/hcp/clinical-guidance/index.html`. The 12 recommendations are grouped into four areas of consideration; the page also ships "Intended use" + "IS / IS NOT" sections.
3. **STI treatment guidelines — clinical guidance index + sub-pages** — `/std/treatment-guidelines/default.htm` plus `/sti/hcp/clinical-guidance/{availability-of-products,duty-to-warn-for-health-care-settings,expedited-partner-therapy,qcs,taking-a-sexual-history}.html`. One chunk per sub-page (one `<main>` body each).

**Blocked by:** Nothing.
**Unblocks:** I.2 (ADA) — confirms the source-agnostic ingest pattern with a second publisher; I.5 eval-validation gate.

**Refs.**
- `W2_ARCHITECTURE.md` §"evidenceRetriever" (corpus curation rules).
- `agent/scripts/fetch-uspstf-corpus.ts`, `agent/scripts/extract-uspstf-corpus.ts` — the C.2 reference implementation. CDC mirrors the structure but carries its own discovery/selector logic.
- `agent/scripts/reindex-corpus.ts` — already source-agnostic; CDC plugs in by dropping a `agent/data/corpus/cdc/index.json` next to the chunk files.

**Files touched.**
- `agent/scripts/fetch-cdc-corpus.ts` (new) — multi-target fetcher: each target is a typed `{slug, url, surface}` record.
- `agent/scripts/extract-cdc-corpus.ts` (new) — surface-specific extractors (`acip-notes`, `acip-schedule`, `opioid-landing`, `sti-clinical-guidance`); emits chunks under `agent/data/corpus/cdc/`.
- `agent/data/corpus/cdc/{fetch-manifest.json,index.json}` (new — generated, committed).
- `agent/data/corpus/cdc/<slug>--<section>.md` (new — generated, committed; chunk text verbatim from the publisher).
- `agent/package.json` — `corpus:fetch:cdc`, `corpus:extract:cdc` script aliases.
- `agent/tests/scripts/extract-cdc-corpus.test.ts` (new) — fixture-driven extractor tests.
- `agent/tests/scripts/fixtures/cdc-*.html` (new) — saved fixture HTML for each surface.
- `agent/README.md` — corpus section gains a CDC line item (mirrors USPSTF's posture line).

**Checklist.**
- [x] Implement `agent/scripts/fetch-cdc-corpus.ts`:
  - Hardcode the typed target list (the three surfaces above) in a top-of-file constant. CDC's URL space is heterogeneous — discovery-by-index (USPSTF's pattern) doesn't apply across opioid + ACIP + STI; an explicit list is honest about scope.
  - Polite crawl: 2 second inter-request delay (CDC's `robots.txt` declares no `Crawl-delay`; 2 s is conservative). Single-threaded. Descriptive `User-Agent` matching the USPSTF fetcher's shape.
  - For each target: GET → write to `agent/.corpus-cache/cdc/<slug>.html` → record `{slug, url, surface, fetched_at, content_sha256}`.
  - Persist `agent/data/corpus/cdc/fetch-manifest.json` with `{source: 'cdc', fetcher_version, first_run_at, last_run_at, entries[]}`. Re-runs skip when the cached file's sha256 still matches the manifest entry — same recovery story as USPSTF (manual cache wipe to force a re-fetch).
  (10 targets fetched in ~20 s on the first run; second run reports 0 fetched / 10 skipped.)
- [x] Implement `agent/scripts/extract-cdc-corpus.ts`:
  - Surface-specific extractors:
    - `extractAcipNotes($, slug)` → one chunk per `note-<vaccine>` anchor, body taken verbatim from the `<h3>`-rooted vaccine block up to the next `cdc-textblock` boundary. Section slug is `note-<vaccine>` normalized to kebab-case.
    - `extractAcipSchedule($, slug)` → two chunks per page: `purpose` and `how-to-use`, each rooted at the corresponding `<h2>`.
    - `extractOpioidLanding($)` → one chunk per `<h2>` section under `<main>`: `at-a-glance`, `the-2022-clinical-practice-guideline`, `recommendations`, `intended-use-is`, `intended-use-is-not`. Section labels match the page's verbatim `<h2>` / `<h3>` text.
    - `extractStiClinicalGuidance($, slug)` → one chunk per page: `clinical-guidance` body taken verbatim from the page's `<main>` content area, minus header/share/related-pages chrome.
  - Selectors that fail on a page log a structured warning (`[extract] cdc/<slug>: <reason>`) and skip that section. Pages are never given fabricated content.
  - Each chunk file is markdown with YAML frontmatter `{publication: 'CDC', title, section, section_label, year, url, license_tier: 'public_domain', slug, surface, fetched_at, content_sha256}`. Frontmatter emitter mirrors `extract-uspstf-corpus.ts`'s hand-rolled YAML to keep the format identical and re-emittable.
  - Regenerate `agent/data/corpus/cdc/index.json` from the filesystem (sorted, stable). `index.json` shape mirrors USPSTF's so `reindex-corpus.ts` reads it without changes.
  (Surface dispatch lives in `extractFromHtml(surface, slug, html)` switching on the four surfaces. ACIP-notes anchors `<a id="note-*">` inside `<div class="cdc-textblock">` give per-vaccine chunk boundaries; ACIP-schedule keeps only `Purpose` + `How to use the schedule` since `Ages X Years or Older` is tabular-with-PDF and adds no narrative. Opioid + STI pages use a generic `<h2>`-section walker (`collectBySectionH2`) under `<main>`, dropping a small chrome-label set (`On This Page`, `Additional Information`, `Download the Schedule`, `Sources`, `Print`, `Share`).)
- [x] Add scripts to `agent/package.json`: `"corpus:fetch:cdc": "tsx scripts/fetch-cdc-corpus.ts"`, `"corpus:extract:cdc": "tsx scripts/extract-cdc-corpus.ts"`.
- [x] Vitest fixture tests (`agent/tests/scripts/extract-cdc-corpus.test.ts`):
  - Saved CDC HTML fixture per surface (one ACIP notes page, one schedule page, the opioid landing, one STI clinical-guidance sub-page) under `agent/tests/scripts/fixtures/cdc-<surface>.html`. Fixtures are trimmed-down real pages — same posture as USPSTF's `sample-recommendation.html`.
  - Assert: each fixture parses to the expected chunk count + section slugs; recommendation/note text appears verbatim in the body; missing-anchor and missing-`<main>` pages log structured warnings and emit zero chunks.
  (7 vitest cases covering acip-notes happy path + no-anchors fallback, acip-schedule chrome-dropping, opioid-landing h2 sections, sti-clinical-guidance h2 sections, missing-main, and chrome-only pages.)
- [x] Run `npm run corpus:fetch:cdc && npm run corpus:extract:cdc` from `agent/`, review the chunk count and content, commit the resulting `agent/data/corpus/cdc/` tree.
  (Output: 65 chunks across 10 source pages — 4 acip-schedule + 34 acip-notes + 4 opioid-landing + 23 sti-clinical-guidance. Bodies inspected and verbatim from publisher DOM; frontmatter shape-identical to USPSTF plus a new `surface` field.)
- [ ] When the user has Pinecone credentials populated, run `npm run evals:reindex-corpus` to upsert CDC chunks into namespace `guidelines-v1`. The reindex script is already source-agnostic; no code changes there.
  (Deferred to user — same gate as C.2/C.3 partial DoDs. Verified structurally: the reindex script's `for sourceName of sources` loop already iterates `data/corpus/*/index.json`, so the CDC dir gets picked up automatically once the user runs it.)
- [x] Update `agent/README.md` corpus section: add "CDC (license_tier: public_domain)" line item alongside USPSTF, link out to the three target URL families.
  (Added a "Sources currently in the corpus" table summarizing USPSTF + CDC and their license tiers + surfaces, plus the 3-step CDC quick-start mirroring the USPSTF block.)

**Definition of done.**
- `npm run corpus:fetch:cdc && npm run corpus:extract:cdc` populates `agent/data/corpus/cdc/` with verbatim chunks across all three surfaces; re-running is idempotent.
- `agent/data/corpus/cdc/index.json` is shape-identical to USPSTF's so `reindex-corpus.ts` indexes it with no changes.
- Vitest tests green.
- When the user has Pinecone credentials, `npm run evals:reindex-corpus` upserts CDC alongside USPSTF.
- `evidenceRetriever({source_filter: ['CDC']})` returns CDC chunks (validated structurally now; end-to-end against real vendors deferred to I.5 eval-validation gate, same gate as C.2/C.3).

---

## I.2 ADA Standards of Care in Diabetes (current year)

**Goal.** Add the ADA Standards of Care to the corpus. License is copyrighted-but-fair-use-for-CDS; the `license_tier='fair_use_cds'` field surfaces this in the renderer's citation popover, and `agent/README.md` documents the production-readiness note ("explicit ADA license required for production deployment").

The ADA Standards are published as the December annual supplement to *Diabetes Care* and structured into ~17 numbered sections. Two of six W1 archetypes are diabetic, so signal density per chunk is high.

**Blocked by:** I.1 (proves the source-agnostic ingest pattern with a second publisher).
**Unblocks:** I.5 eval-validation gate.

**Refs.** `WEEK2-PRESEARCH.md` Q9 (ADA license posture, content density); `W2_ARCHITECTURE.md` §"evidenceRetriever" (license_tier metadata).

**Checklist.** _(To be expanded when picked up; same shape as I.1.)_

---

## I.3 ACC/AHA Hypertension (2017 + 2023 update)

**Goal.** Add the ACC/AHA hypertension guideline to the corpus. License is `fair_use_cds`. `hypertensive` is a core W1 archetype; cross-cutting cardiovascular comorbidity in `diabetic_uncontrolled` and `complex_elderly`.

**Blocked by:** I.1 (template).
**Unblocks:** I.5 eval-validation gate.

**Refs.** `WEEK2-PRESEARCH.md` Q9.

**Checklist.** _(To be expanded when picked up.)_

---

## I.4 AGS Beers Criteria (2023)

**Goal.** Add the AGS Beers Criteria to the corpus. License posture is the most fragile in the set — single-publication artifact in *J Am Geriatr Soc*; synthetic-data demo is fine, production replacement is likely. Conditional on geriatric-prescribing being a featured demo path; defer if not.

**Blocked by:** I.1 (template); explicit demo-storytelling decision.
**Unblocks:** I.5 eval-validation gate.

**Refs.** `WEEK2-PRESEARCH.md` Q9 (license-risk note).

**Checklist.** _(To be expanded when picked up.)_

---

## I.5 Eval-validation gate between sources

**Goal.** After each I.1–I.4 sub-phase, run `npm run evals:experiment` against real vendors (Pinecone + OpenAI + Cohere + Anthropic) and confirm no regression in USPSTF retrieval quality. The Q9 architecture rule says "stop and review after 5 sources"; we cap earlier and re-evaluate so the retrieval-quality decay (more publishers = more competing chunks per query) is observable before it becomes structural.

**Blocked by:** Nothing inside Phase I (this gate is run against whichever sources have shipped).
**Unblocks:** Decision to ship I.2 / I.3 / I.4.

**Refs.** `agent/evals/runners/experiment.ts`; `docs/EVAL_RESULTS.md`.

**Checklist.** _(To be expanded when picked up; expected shape: re-run nightly experiment + diff against the per-suite baseline; flag any rubric drop > 5 % per the architecture's regression threshold.)_

---

## Open considerations

- **Multi-publisher retrieval quality.** Adding publishers competes for top-k slots in any given query. The I.5 gate exists to surface the decay before it's a regression incident; if we see retrieval quality drop, the answer is per-source per-query routing (the supervisor's `source_filter` arg is already wired for this), not bulk de-indexing.
- **License-tier surfacing in the panel UI.** The renderer's section-snippet popover already discriminates on `license_tier`; the demo storytelling needs a once-over on the `fair_use_cds` copy when I.2 ships, since "USPSTF (public domain)" reads cleanly but "ADA Standards of Care (fair use for CDS)" needs a one-line footnote.
- **Re-ingest cadence.** USPSTF fetches are skip-on-sha256-match; CDC follows the same pattern. ADA's annual revision cycle means each December a re-fetch lands the new edition. We don't need a scheduler — the user runs `npm run corpus:fetch:<source>` when they remember, and the manifest's `last_run_at` provides observability.
