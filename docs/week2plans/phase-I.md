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

The ADA Standards are published as the December annual supplement to *Diabetes Care* and structured into 17 numbered sections plus an Introduction & Methodology front-matter article. Two of six W1 archetypes are diabetic, so signal density per chunk is high.

The publisher's direct site (`diabetesjournals.org`) returns a Cloudflare JS-challenge to scripted fetches, so the fetcher targets the open-access PMC mirror (`pmc.ncbi.nlm.nih.gov/articles/PMC<id>/`) where every Standards-of-Care section is published as a separate article. The PMC mirror is a fetch-time choice; the chunk frontmatter records both `url` (PMC, what the fetcher actually used) and `publisher_url` (the canonical `diabetesjournals.org` link, what citation popovers display to users). License tier remains `fair_use_cds` — PMC's "free to read" doesn't relax ADA's copyright.

**Blocked by:** I.1 (proves the source-agnostic ingest pattern with a second publisher).
**Unblocks:** I.5 eval-validation gate.

**Refs.**
- `WEEK2-PRESEARCH.md` Q9 (ADA license posture, content density).
- `W2_ARCHITECTURE.md` §"evidenceRetriever" (license_tier metadata).
- `agent/scripts/fetch-cdc-corpus.ts`, `agent/scripts/extract-cdc-corpus.ts` — the I.1 reference implementation. ADA mirrors the structure but uses PMC as the fetch surface and emits `publisher_url` alongside `url`.
- `agent/scripts/reindex-corpus.ts` — already source-agnostic; ADA plugs in by dropping a `agent/data/corpus/ada/index.json` next to the chunk files.

**Files touched.**
- `agent/scripts/fetch-ada-corpus.ts` (new) — multi-target fetcher: each target is a typed `{slug, pmc_id, publisher_url, surface}` record.
- `agent/scripts/extract-ada-corpus.ts` (new) — PMC `<h2>`-section walker; emits chunks under `agent/data/corpus/ada/`.
- `agent/data/corpus/ada/{fetch-manifest.json,index.json}` (new — generated, committed).
- `agent/data/corpus/ada/<slug>--<section>.md` (new — generated, committed; chunk text verbatim from PMC).
- `agent/package.json` — `corpus:fetch:ada`, `corpus:extract:ada` script aliases.
- `agent/tests/scripts/extract-ada-corpus.test.ts` (new) — fixture-driven extractor tests.
- `agent/tests/scripts/fixtures/ada/*.html` (new) — saved fixture HTML for the PMC ADA shape.
- `agent/README.md` — corpus section gains an ADA line item plus a one-line production-readiness footnote.

**Checklist.**
- [x] Implement `agent/scripts/fetch-ada-corpus.ts`:
  - Hardcode the typed target list (Introduction & Methodology + sections 1–17, 18 entries total) in a top-of-file constant. PMC IDs are stable per article — discovery-by-index doesn't help here, an explicit list is honest about scope.
  - Polite crawl: 3 second inter-request delay against PMC. Single-threaded. Descriptive `User-Agent` matching the CDC/USPSTF fetcher shape.
  - For each target: GET the PMC article URL → write to `agent/.corpus-cache/ada/<slug>.html` → record `{slug, pmc_id, url, publisher_url, surface, fetched_at, content_sha256}`.
  - Persist `agent/data/corpus/ada/fetch-manifest.json` with `{source: 'ada', fetcher_version, first_run_at, last_run_at, entries[]}`. Re-runs skip when the cached file's sha256 still matches the manifest entry — same recovery story as USPSTF/CDC (manual cache wipe to force a re-fetch).
  (18 PMC IDs were discovered up front via NCBI eutils — `esearch.fcgi?db=pmc&term="Standards of Care in Diabetes—2026"[Title]` plus an esummary call to harvest titles + DOIs — so the typed list lands once with stable identifiers. Disclosures (`PMC12690169` / `dc26-SDIS`) and Summary of Revisions (`PMC12690167` / `dc26-SREV`) are intentionally excluded. `publisher_url` is the DOI form `https://doi.org/10.2337/dc26-S<NN>`, which redirects to the canonical `diabetesjournals.org` URL even when the publisher restructures slugs.)
- [x] Implement `agent/scripts/extract-ada-corpus.ts`:
  - Single surface `pmc-section` (every ADA target shares the same PMC article shape). PMC pages put the article body inside `<section class="body main-article-body">`, with each top-level topic announced by `<h2 class="pmc_sec_title">`. The extractor walks every direct `<h2>` under the body and emits one chunk per topic.
  - Drop PMC's surrounding chrome by `<section>` class (everything outside `body main-article-body` — front-matter banner, citation block, references, history, footer). Chrome-label drop list (e.g. `References`, `Article information`) excludes the references list, which is bibliography rather than guidance.
  - Selectors that fail on a page log a structured warning (`[extract] ada/<slug>: <reason>`) and skip that section. Pages are never given fabricated content.
  - Each chunk file is markdown with YAML frontmatter `{publication: 'ADA', title, section, section_label, year, url, publisher_url, license_tier: 'fair_use_cds', slug, surface, fetched_at, content_sha256}`. Frontmatter emitter mirrors `extract-cdc-corpus.ts`'s hand-rolled YAML; one new field (`publisher_url`) sits between `url` and `license_tier`.
  - Regenerate `agent/data/corpus/ada/index.json` from the filesystem (sorted, stable). `index.json` shape matches USPSTF/CDC plus a top-level `license_tier: 'fair_use_cds'` so `reindex-corpus.ts` reads it without changes.
  (Title comes from `<meta name="citation_title">`; year from `<meta name="citation_publication_date">` (e.g. "2025 Dec 8"); URL from `<link rel="canonical">`. The h2-walker uses each h2's enclosing `<section>` for body capture, with a sibling-walk fallback when an h2 isn't in a section. Chrome-label drop list expanded beyond `References`/`Footnotes`/`Contributor Information` to also exclude PMC's `Article information`, `Author Contributions`, `Funding Statement`, `Conflict of Interest`, and `Acknowledgments` so future PMC template additions don't quietly leak into chunks.)
- [x] Add scripts to `agent/package.json`: `"corpus:fetch:ada": "tsx scripts/fetch-ada-corpus.ts"`, `"corpus:extract:ada": "tsx scripts/extract-ada-corpus.ts"`.
- [x] Vitest fixture tests (`agent/tests/scripts/extract-ada-corpus.test.ts`):
  - Saved PMC HTML fixture under `agent/tests/scripts/fixtures/ada/pmc-section-sample.html` — trimmed-down real article (a few `<h2 class="pmc_sec_title">` sections plus PMC chrome). Same posture as USPSTF/CDC fixtures.
  - Assert: each fixture parses to the expected chunk count + section slugs; recommendation text appears verbatim in the body; missing-body and chrome-only pages log structured warnings and emit zero chunks.
  (3 vitest cases: pmc-section happy path with chrome dropping + verbatim recommendation text + empty-section warning, missing-article-body fallback, chrome-only fallback. Fixture is hand-built to exercise the canonical PMC shape — abstract + 3 real h2 topics + chrome — without committing 350 KB of real article HTML.)
- [x] Run `npm run corpus:fetch:ada && npm run corpus:extract:ada` from `agent/`, review the chunk count and content, commit the resulting `agent/data/corpus/ada/` tree.
  (Output: 126 chunks across 18 source articles — 6 to 13 chunks per ADA section depending on size; section 16 (Hospital) and 13 (Older Adults) are densest. Bodies inspected and verbatim from PMC DOM, including numbered recommendations like "11.1a Assess kidney function with random urine albumin-to-creatinine ratio (UACR) ... B" and "9.24 Include healthy behaviors ... A". Idempotent re-run reports 0 fetched / 18 skipped.)
- [ ] When the user has Pinecone credentials populated, run `npm run evals:reindex-corpus` to upsert ADA chunks into namespace `guidelines-v1`. The reindex script is already source-agnostic; no code changes there. (Deferred to user — same gate as I.1's last checkbox.)
- [x] Update `agent/README.md` corpus section: add an "ADA Standards of Care in Diabetes (2026, license_tier: `fair_use_cds`)" row to the sources table, with a one-line production-readiness footnote ("explicit ADA license required for production deployment"); add an ADA quick-start mirroring the CDC block.
  (Sources table now has three rows; ADA row carries a footnote ¹ explaining the fair-use posture, and an ADA-specific quick-start block follows the CDC one — including the one-line rationale for why the fetcher targets PMC over the publisher's direct URL.)

**Definition of done.**
- `npm run corpus:fetch:ada && npm run corpus:extract:ada` populates `agent/data/corpus/ada/` with verbatim chunks across all 18 PMC articles; re-running is idempotent.
- `agent/data/corpus/ada/index.json` is shape-identical to USPSTF/CDC's (with `license_tier: 'fair_use_cds'` at the top level) so `reindex-corpus.ts` indexes it with no changes.
- Vitest tests green.
- When the user has Pinecone credentials, `npm run evals:reindex-corpus` upserts ADA alongside USPSTF and CDC.
- `evidenceRetriever({source_filter: ['ADA']})` returns ADA chunks (validated structurally now; end-to-end against real vendors deferred to I.5 eval-validation gate).

---

## I.3 CDC High Blood Pressure + Million Hearts hypertension content

**Goal.** Five clinician-facing CDC HBP and Million Hearts pages are fetched verbatim from the publisher, parsed by the existing `cdc-clinical-guidance` extractor, and committed under `agent/data/corpus/cdc/` alongside the I.1 ACIP/opioid/STI chunks. License is `public_domain` across all five (federal-government works). The pages cover the core implementation surface a primary-care team needs for the `hypertensive` archetype — a CDC-published management toolkit, the pharmacist's patient-care process guide, the team-based-care evidence brief, telehealth-strategies evaluations, and the Million Hearts treatment-protocols index (cholesterol management, tobacco cessation, hypertension treatment). The supervisor can then issue `evidenceRetriever({source_filter: ['CDC'], …})` and surface hypertension-specific chunks; absent a filter, the new chunks compete with USPSTF and the existing CDC corpus on hybrid score.

This sub-phase originally targeted the 2017 ACC/AHA Hypertension Guideline (Whelton et al.). After the upstream survey (probed `ahajournals.org`, `jacc.org`, NICE, NHLBI, VA/DoD, AHRQ EPC, Million Hearts, AAFP, Cleveland Clinic, Mayo Clinic), AHA Journals + JACC turned out to be Cloudflare-protected with no PMC mirror, while patient-ed sites (Cleveland Clinic, Mayo, NHLBI consumer pages) are "all rights reserved" and content-thin. CDC HBP / Million Hearts emerged as the only candidate that both **scrapes cleanly with our existing CDC fetcher** and carries clinician-grade content (drug-class first-line recommendations, titration intervals, team-based-care evidence) — so the sub-phase is repointed there. The architecture's "publisher-at-a-time" rule still holds; this just deepens the existing CDC corpus rather than spinning up a new publisher.

The five new pages are:
1. **HMP Toolkit** — `/high-blood-pressure/hcp/hmp-toolkit/index.html` (CDC's Hypertension Management Program clinician toolkit).
2. **Pharmacists' Patient-Care Process Approach Guide** — `/high-blood-pressure/hcp/data-research/pharmacists-patient-care/index.html`.
3. **Team-Based Care to Improve Blood Pressure Control** — `/high-blood-pressure/php/data-research/team-based-care/index.html`.
4. **Rapid Evaluations of Telehealth Strategies to Address Hypertension** — `/high-blood-pressure/php/data-research/telehealth-strategies/index.html`.
5. **Million Hearts Treatment Protocols** — `https://millionhearts.hhs.gov/tools-protocols/protocols.html` (cholesterol management, tobacco cessation, hypertension treatment protocols index).

ACC/AHA + JACC publishers are deferred until a real path to that source exists (Playwright/headless-browser fetcher, an explicit license arrangement, or a PMC deposit). The `'ACC-AHA'` member is removed from `EVIDENCE_SOURCE_FILTERS` since no ingest path exists; `'ADA'` and `'AGS-Beers'` stay (still in scope per I.2 / I.4).

**Blocked by:** I.1 (template — `cdc-clinical-guidance` shape reuses the I.1 generic-h2 walker).
**Unblocks:** I.5 eval-validation gate.

**Refs.**
- `W2_ARCHITECTURE.md` §"evidenceRetriever" (corpus curation rules; publisher-at-a-time, no model-authored chunks).
- `agent/scripts/fetch-cdc-corpus.ts`, `agent/scripts/extract-cdc-corpus.ts` — the I.1 reference implementation. The new `cdc-clinical-guidance` surface adds five fetch targets and one switch arm; no new files, no new dependencies. The new surface reuses the existing `extractGenericH2Sections` walker.
- `agent/scripts/reindex-corpus.ts` — source-agnostic; existing `cdc` corpus dir picks up the new chunk files automatically.

**Files touched.**
- `agent/scripts/fetch-cdc-corpus.ts` — extends `CdcSurface` with `'cdc-clinical-guidance'`; appends five new entries to `FETCH_TARGETS`.
- `agent/scripts/extract-cdc-corpus.ts` — adds `'cdc-clinical-guidance'` to the surface dispatch (reuses the existing `extractGenericH2Sections`); extends `SKIP_SECTION_LABELS` with Million Hearts chrome (`Subscribe.`, `Connect.`, `Explore.`, `Take Action.`) and CDC HBP chrome (`Additional content`, `Related resources`, `Related Webpages`, `Tools and Resources`).
- `agent/data/corpus/cdc/{fetch-manifest.json,index.json}` — five new entries appended.
- `agent/data/corpus/cdc/{hbp-*,million-hearts-*}--<section>.md` — 20 new chunk files.
- `agent/tests/scripts/extract-cdc-corpus.test.ts` — adds a `cdc-clinical-guidance` describe block with two cases (CDC HBP page + Million Hearts protocols page).
- `agent/tests/scripts/fixtures/cdc/cdc-clinical-guidance-{hbp,million-hearts}-sample.html` — two new fixtures.
- `agent/src/graph/types.ts` — drops `'ACC-AHA'` from `EVIDENCE_SOURCE_FILTERS` (no ingest path).
- `agent/README.md` — extends the CDC line in the sources table to mention the new HBP/Million Hearts surfaces.

**Checklist.**
- [x] Extend `agent/scripts/fetch-cdc-corpus.ts`:
  - Add `'cdc-clinical-guidance'` to the `CdcSurface` union.
  - Append five entries to `FETCH_TARGETS` (slugs `hbp-hmp-toolkit`, `hbp-pharmacists-patient-care`, `hbp-team-based-care`, `hbp-telehealth-strategies`, `million-hearts-protocols`).
- [x] Extend `agent/scripts/extract-cdc-corpus.ts`:
  - Add `extractCdcClinicalGuidance` (delegates to existing `extractGenericH2Sections`); dispatch from `extractFromHtml` switch.
  - Extend `SKIP_SECTION_LABELS` with the Million Hearts boilerplate four (`Subscribe.`, `Connect.`, `Explore.`, `Take Action.`) and CDC HBP footer chrome (`Additional content`, `Related resources`, `Related Webpages`, `Tools and Resources`).
- [x] Vitest fixture tests (`agent/tests/scripts/extract-cdc-corpus.test.ts`):
  - Two new fixtures under `agent/tests/scripts/fixtures/cdc/cdc-clinical-guidance-*-sample.html` (CDC HBP HMP-toolkit shape + Million Hearts protocols shape).
  - Two new cases asserting expected sections, verbatim body content, and chrome dropping.
- [x] Run `npm run corpus:fetch:cdc && npm run corpus:extract:cdc` from `agent/`, review the new 20 chunks, commit only the new chunk files + the appended index.json/fetch-manifest.json entries (preserve old entries' timestamps).
  (Output: 20 new chunks across 5 source pages — 4 hbp-hmp-toolkit + 3 hbp-pharmacists-patient-care + 5 hbp-team-based-care + 5 hbp-telehealth-strategies + 3 million-hearts-protocols. Old chunk timestamps preserved via selective `git checkout`; index.json + fetch-manifest.json patched surgically rather than fully regenerated.)
- [x] Drop `'ACC-AHA'` from `EVIDENCE_SOURCE_FILTERS` in `agent/src/graph/types.ts` (no ingest path; `'ADA'` and `'AGS-Beers'` stay for I.2/I.4).
- [x] Update `agent/README.md` corpus section: extend the CDC row with the HBP/Million Hearts surface line item.
- [ ] When the user has Pinecone credentials populated, run `npm run evals:reindex-corpus` to upsert the new chunks into namespace `guidelines-v1`. The reindex script is already source-agnostic; no code changes there. (Deferred to user — same gate as C.2/C.3/I.1 partial DoDs.)

**Definition of done.**
- `npm run corpus:fetch:cdc && npm run corpus:extract:cdc` produces 20 new chunks under `agent/data/corpus/cdc/` (5 pages × ~4 sections each); re-running is idempotent.
- Vitest tests green (full agent suite, not just the extended test file).
- `EVIDENCE_SOURCE_FILTERS` no longer contains `'ACC-AHA'`.
- When the user has Pinecone credentials, `npm run evals:reindex-corpus` upserts the new CDC chunks alongside the existing CDC + USPSTF corpora.
- `evidenceRetriever({source_filter: ['CDC']})` returns hypertension-management chunks (validated structurally now; end-to-end against real vendors deferred to I.5 eval-validation gate, same gate as C.2/C.3/I.1).

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
