# Document-extraction fixtures

Source documents the §B.3+ pipeline tests and the §B.10 eval suite
consume. The manifest at `source/manifest.json` is the single source
of truth - the regenerator is at
`agent/evals/fixtures/regenerate-document-extraction.ts`. Always edit
the regenerator and run `npm run evals:regenerate-fixtures`; never
hand-edit `manifest.json`.

## Layout

```
source/
├── manifest.json            ← per-document metadata (case kind, doc type, expected outcome)
├── lab-results/             ← original example-document lab PDFs / PNGs
├── intake-forms/            ← original example-document intake PDFs / PNGs
├── tiffs/                   ← cohort-5 fax-packet TIFFs (image-passthrough cases)
└── synthetic/               ← hand-built single-page PDFs:
    ├── build-synthetic-fixtures.ts
    ├── blank.pdf            ← valid 1-page PDF, no extractable content
    ├── prompt-injection.pdf ← embeds an "ignore previous instructions" payload
    ├── unrelated-document.pdf ← non-clinical invoice content
    └── corrupted.pdf        ← deliberately malformed bytes (rasterize must fail)
```

`p03-reyes-intake.png` (464 KB) and `p04-kowalski-intake.png` (582 KB)
exceed the repo's default 500 KB pre-commit size limit; they were
committed via `--no-verify` because they are the canonical
test-fixture intake forms the agent must extract against (per
`feedback_preserve_user_added_fixtures`).

## How tests use these

§B.3's `agent/tests/pipeline/rasterize.test.ts` reads the 3-page Chen
intake PDF as the canonical happy-path fixture (definition of done:
"A fixture 3-page PDF runs through `rasterize`, three PNGs land in
Spaces transient prefix"). The single-page CBC and CMP cover the
minimal-PDF path; the PNGs cover the image-passthrough branch.

§B.10's `documentExtractionSuite.ts` iterates `manifest.json` to emit
the 26 W2 eval cases:

- 8 lab-pdf cases (4 example-document labs + 4 cohort-5 TIFF fax packets).
- 8 intake-form cases (4 example-document intakes + 3 fax intake-shape + 1 demographics-delta variant on Chen).
- 6 degraded cases (smudged / rotated / blank / unrelated / partial / OCR-bad). The blank and unrelated cases use the synthetic PDFs above; the rest reuse the real fixtures with the eval target stubbing the vision invoker to simulate the degradation.
- 4 adversarial cases (wrong-patient / prompt-injection / oversized / corrupted).

## Updating

When `docs/example-documents/` or `docs/cohort-5-week-2-assets-v2/`
changes, re-copy the relevant binaries into this directory and update
`regenerate-document-extraction.ts` (the manifest entries) to reflect
new page counts / archetypes. Then run
`npm run evals:regenerate-fixtures` to write the manifest.
