# Phase H — Fast-followers: verifier robustness + supervisor narrative quality

**Status.** Post-W2 fast-follower phase. Not on the W2 submission critical path. Sequenced after Phase G, picked up when the W2 sprint closes and we have eval-run signal pointing at the long tail.

**Phase summary.** The W2 sprint shipped narrow, hand-curated fixes for two production incidents that surfaced after the supervisor-driven uploads MR landed on master:

1. The verifier rejected accurate clinical claims because synthesizers used standard medical abbreviations (HbA1c, BUN, LDL) that didn't word-for-word reproduce the chart's verbose LOINC display strings, and natural prose ("Metformin 500 mg twice daily") that omitted RxNorm form descriptors ("Oral Tablet"). Hotfixes:
   - `87ea7e6dd fix(agent): tolerate medical abbreviations + Rx form descriptors in verifier` — added a 10-group lab-analyte alias table and a 28-token prescription form-descriptor strip-list.
   - `df8f7f2c9 feat(agent): synthesize an implicit question on upload-only turns` — for upload-only follow-ups, observeState fills in a deterministic "what should I consider doing about this lab" question so the supervisor's existing guideline-routing rule fires.

These hotfixes covered the four named analytes and one drug shape that the production incident exposed. The pattern (chart carries spelled-out LOINC display, model writes the abbreviation) applies to dozens of common labs we haven't enumerated; brand-vs-generic (Lipitor ↔ Atorvastatin) is a different mismatch axis the strip-list doesn't help with at all. Phase H captures the more durable solutions.

**Phase definition of done.**
- The verifier no longer relies on a hand-curated alias table for the long tail of clinical names. Either the alias table is fed by an authoritative terminology source (LOINC parts, RxNorm synonyms) or a fallback similarity check catches the cases the table doesn't.
- A regression-eval surface exists that lets future model + chart-row pairs fail an eval rather than production: `unverified_claims` rows are queryable by `(chart_analyte, claim_excerpt)` and the eval suite consumes them as fixtures.
- Brand-vs-generic prescription matching is solved.
- Generalised solution is observable in LangSmith / cost dashboards — we know what the alias hit-rate is and what fraction of rejections still fall through to the strict path.

**Owner.** Engineer (no user-facing UI changes; this is verifier + observability work).

**Refs.**
- `W2_ARCHITECTURE.md` §"Verification Architecture", §"Citation Contract and Verification".
- `agent/src/verify/verifier.ts` — the LAB_ANALYTE_ALIASES table and matchesDrugName helper that this phase generalizes.

---

## H.1 Reactive alias-table expansion driven by `unverified_claims` telemetry

**Goal.** Use the existing `unverified_claims` postgres table as a feedback loop. When a claim is rejected with `claim-text-does-not-match-source-fields`, the row records the chart-side `source_references` and the claim text. A weekly job (or manual query) groups rejections by chart-analyte / chart-drug-name and surfaces the long-tail patterns the alias table doesn't cover. Each new pattern lands as a one-line addition to `LAB_ANALYTE_ALIASES` (or `PRESCRIPTION_FORM_DESCRIPTORS`) plus a regression test pinning the new acceptance.

**Blocked by:** Phase G merged (so the deployed app has stable verifier behavior to observe).
**Unblocks:** H.2 (we want telemetry-driven evidence before adopting a heavier solution).

**Refs.** Hotfix commit `87ea7e6dd`; `agent/src/verify/unverifiedClaimsLog.ts`; `agent/src/state/migrations/*.sql` for the `unverified_claims` schema.

**Files touched.**
- `agent/src/verify/verifier.ts` (alias table additions only).
- `agent/tests/verify/verifier.test.ts` (regression-test additions).
- `agent/scripts/<new>-rejection-rollup.ts` — query helper that groups recent `unverified_claims` by chart row and prints candidate aliases.

**Checklist.**
- [ ] Write `agent/scripts/rejection-rollup.ts` that reads `unverified_claims` for the last N days, joins the source_references array, and prints `(chart_analyte_or_drug, claim_text_excerpt, count)` rows sorted by count.
- [ ] Run weekly against the prod DB. Each high-count row that's a real abbreviation (not a fabrication) becomes a pending alias-table entry.
- [ ] Each new alias entry ships with one regression test in `verifier.test.ts` that pins the new acceptance.
- [ ] Document the workflow in `agent/README.md` — "How to expand the verifier alias table from production telemetry."

**Definition of done.** A runnable script + a documented workflow. The verifier's alias table grows from real production patterns rather than speculative additions.

---

## H.2 LOINC-backed analyte equivalence (replace the alias table)

**Goal.** Replace the hand-curated `LAB_ANALYTE_ALIASES` table with a LOINC-driven equivalence check. Every lab observation in the chart already carries a `LOINC` code in `procedure_result.result_code`; the snapshot endpoint just doesn't surface it today. Surface the LOINC on the lab observation, then rather than matching display names, the verifier accepts a claim when the claim text mentions any registered LOINC display name OR LOINC short-name OR LOINC component for the same code. LOINC ships its part-name table free; the agent loads it once at boot.

**Blocked by:** H.1 (we want to know the alias table's hit-rate before paying the LOINC integration cost).
**Unblocks:** H.4.

**Refs.** [LOINC Term Database](https://loinc.org/downloads/) (§COMPONENT, §LONG_COMMON_NAME, §SHORTNAME columns); `interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot/Adapter/LabsAdapter.php`.

**Files touched.**
- `agent/src/verify/verifier.ts` — replace `LAB_ANALYTE_ALIASES` with a LOINC lookup; `LabObservation` gains a `loincCode` field.
- `agent/src/snapshot/types.ts` — `LabObservation.loincCode: string | null`.
- `agent/src/snapshot/decode.ts` — decode the new field.
- `interface/.../src/Snapshot/LabObservation.php` — surface `loincCode` on the wire.
- `interface/.../src/Snapshot/Adapter/LabsAdapter.php` — populate `loincCode` from `result_code`.
- `agent/data/loinc/parts.json` (or similar) — committed snapshot of the LOINC part-name table, keyed by LOINC code → list of equivalent display strings.
- New helper `agent/src/verify/loincSynonyms.ts` — loads the part-name table once, exposes `equivalentNames(loincCode)`.

**Checklist.**
- [ ] Vendor a snapshot of the LOINC part-name table to `agent/data/loinc/`. License is permissive for this use; pin the version.
- [ ] Wire `loincCode` from PHP to TS through the snapshot endpoint.
- [ ] Replace `matchesLabAnalyte` to consult LOINC equivalents when the chart row carries a `loincCode`; fall back to the alias table for rows without one.
- [ ] Update existing regression tests; add new tests for LOINC-driven matches that the alias table didn't cover (TSH, INR, BNP, ALT, AST, etc.).
- [ ] Trace metadata records `loinc_match_used: true|false` per accepted lab claim so we can dashboard the hit-rate.

**Definition of done.** A claim citing any common analyte by abbreviation matches against a LOINC-coded chart row without that analyte appearing in `LAB_ANALYTE_ALIASES`. The alias table either shrinks to a fallback for non-LOINC rows, or is deleted entirely.

---

## H.3 RxNorm-backed prescription-name matching (brand ↔ generic)

**Goal.** Solve the brand-vs-generic mismatch the form-descriptor strip-list doesn't address. Chart row stores `Atorvastatin calcium 40 MG Oral Tablet`; clinician (and synthesizer) writes `Lipitor 40 mg`. The verifier should accept this. RxNorm has explicit `BN`/`IN`/`SCD`/`SBD` relationships that resolve brand ↔ ingredient; the NIH ships RxNav as a free API, and the static RxNorm release ships as downloadable data files we can vendor.

**Blocked by:** H.1.
**Unblocks:** H.4.

**Refs.** [RxNorm release](https://www.nlm.nih.gov/research/umls/rxnorm/); existing prescription matcher at `agent/src/verify/verifier.ts` `matchesDrugName` and `matchesPrescriptionChange`.

**Files touched.**
- `agent/src/verify/verifier.ts` — extend `matchesDrugName` with a brand→ingredient lookup.
- `agent/src/verify/rxnormSynonyms.ts` — new helper.
- `agent/data/rxnorm/brand-ingredient.json` — vendored, version-pinned.
- `interface/.../src/Snapshot/Prescription.php` — surface `rxnormCui` if not already present.
- `agent/src/snapshot/types.ts` — `Prescription.rxnormCui: string | null`.

**Checklist.**
- [ ] Vendor a snapshot of RxNorm's brand↔ingredient mappings.
- [ ] Wire RxNorm CUI from PHP to TS.
- [ ] Extend `matchesDrugName` to accept a claim that mentions any brand name registered against the chart row's ingredient (or vice versa).
- [ ] Strength tokens stay strictly enforced (the existing safety floor — 500 mg vs 1000 mg confusion is exactly what brand-name matching can't loosen).
- [ ] Trace metadata records `rxnorm_brand_match: true|false` per accepted prescription claim.
- [ ] Tests: brand-cited claim matches a generic-coded chart row; generic-cited claim matches a brand-coded chart row; wrong drug still rejects; wrong strength still rejects.

**Definition of done.** Lipitor ↔ Atorvastatin works. The form-descriptor strip-list either stays as an inner helper or is folded into the RxNorm path.

---

## H.4 Embedding-similarity fallback for the long tail

**Goal.** For analyte/drug names that aren't in LOINC or RxNorm (uncommon labs, custom panels, off-list compounds, vet meds in unusual deployments), use an embedding similarity check as a verifier fallback. When the alias / LOINC / RxNorm checks all reject, embed the chart field and the claim's relevant span via a small embedding model, and accept above a calibrated threshold.

**Blocked by:** H.2 + H.3 (we want to know what's in the long tail before we add a model call).
**Unblocks:** none — this is the lower-risk default for everything LOINC and RxNorm don't cover.

**Refs.** `agent/src/retrievers/cohere.ts` (existing rerank model wiring) — same provider, same rate-limit story.

**Files touched.**
- `agent/src/verify/verifier.ts` — wire the fallback after LOINC and RxNorm checks fail.
- `agent/src/verify/embeddingFallback.ts` — new helper.
- `agent/evals/cases/verifier/embedding-fallback/*.test.ts` — calibration tests.

**Checklist.**
- [ ] Pick the embedding model (likely the same OpenAI `text-embedding-3-large` already used for the guideline corpus, or a smaller dedicated model if cost matters).
- [ ] Calibrate the threshold against a labeled set of (chart row, claim text, should-accept?) pairs. The set comes from the H.1 rejection-rollup output plus hand-labeled positives/negatives.
- [ ] Cache the chart-side embeddings per snapshot turn so repeated claims against the same row don't re-embed.
- [ ] Trace metadata records `embedding_match_score: 0..1` per claim that hit the fallback.
- [ ] Hard floor: no embedding score, however high, can override the strict numeric value / date / unit checks. The fallback only relaxes the analyte/drug naming axis.

**Definition of done.** The verifier no longer rejects clinically-equivalent rephrasings even outside the curated terminology databases. False-positive rate (acceptance of a fabricated drug or wrong analyte) stays below the calibrated threshold per the eval suite.

---

## H.5 Verifier-rejection eval surface

**Goal.** Make verifier-rejection regressions a per-MR Vitest gate, not a production discovery. Today the four-rejected-claims incident surfaced from a doctor's screenshot; the eval suite had no coverage of "this specific (chart row, claim text) pair should accept." H.5 adds a pinned eval surface that's fed by H.1's rejection-rollup output: every confirmed alias-worthy rejection becomes a per-MR fixture that asserts the disposition.

**Blocked by:** H.1.
**Unblocks:** H.2, H.3 (gives the more general solutions a regression backstop).

**Refs.** `agent/evals/cases/<suite>/*.test.ts` for the existing per-MR Vitest gate pattern.

**Files touched.**
- `agent/evals/cases/verifier/regressions/*.test.ts` — new directory.
- `agent/evals/fixtures/verifier-regressions.json` — fixture file.

**Checklist.**
- [ ] Define the fixture shape: `{ chartRow: { analyte | drug, ... }, claimText: string, expectedDisposition: 'accept' | 'reject', incidentRef: string }`.
- [ ] Convert the four May 2026 incident pairs to fixtures; add new fixtures from H.1's rejection-rollup output.
- [ ] Per-MR test asserts every fixture's disposition matches the verifier's output. CI fails on regression.
- [ ] When a future model + chart row produces a new abbreviation pattern, the workflow is: (1) rejection-rollup surfaces it, (2) human confirms it's accept-worthy, (3) fixture lands, (4) verifier expansion lands in the same MR.

**Definition of done.** Adding a new alias / LOINC term / RxNorm synonym always lands with a fixture pinning the acceptance. A future verifier refactor that drops the fix produces a red CI gate.
