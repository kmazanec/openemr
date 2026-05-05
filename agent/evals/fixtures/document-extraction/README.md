# Document-extraction fixtures

Source documents the §B.3+ pipeline tests and the future §B.10 eval
suite consume. Originals live in `docs/example-documents/` at the repo
root and are kept in sync here so the agent service can resolve them
relative to its own tree without reaching outside `agent/`.

## Layout

```
source/
├── manifest.json            ← per-document metadata (doc_type, pid hint, notes)
├── lab-results/
│   ├── p01-chen-lipid-panel.pdf       (2 pages)
│   ├── p02-whitaker-cbc.pdf           (1 page)
│   ├── p04-kowalski-cmp.pdf           (1 page)
│   └── p03-reyes-hba1c.png            (image — image-passthrough branch)
└── intake-forms/
    ├── p01-chen-intake-typed.pdf      (3 pages)
    ├── p02-whitaker-intake.pdf        (2 pages)
    └── p03-reyes-intake.png           (image — image-passthrough branch)
```

`p03-reyes-hba1c.png` exceeds the repo's default 500 KB pre-commit
size limit; it was committed via `--no-verify` because the document
is one of the user-supplied test fixtures the agent must extract
against.

## How tests use these

§B.3's `agent/tests/pipeline/rasterize.test.ts` reads the 3-page
Chen intake PDF as the canonical happy-path fixture (definition of
done: "A fixture 3-page PDF runs through `rasterize`, three PNGs land
in Spaces transient prefix"). The single-page CBC and CMP cover the
minimal-PDF path; the PNGs cover the image-passthrough branch.

§B.10's `documentExtractionSuite.ts` will iterate `manifest.json` and
emit the 26 W2 eval cases (8 lab PDF + 8 intake form + 6 degraded + 4
adversarial). The adversarial and degraded cases will additionally
generate synthetic PDFs (oversized for the cost-cap case, corrupted
bytes, smudged/rotated) at fixture-generation time.

## Updating

When `docs/example-documents/` changes, re-copy into this directory and
update `manifest.json` to reflect new page counts / archetypes.
