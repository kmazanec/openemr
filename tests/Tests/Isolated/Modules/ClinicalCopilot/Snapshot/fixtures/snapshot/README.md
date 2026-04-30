# ChartSnapshot fixtures

Pinned full-`ChartSnapshot` JSON for every `PatientArchetype`, produced by
`ChartSnapshotFixtureTest` against `ArchetypeChartFactory` at a fixed
Faker seed (`20260430`).

These fixtures are the deterministic equivalent of PRESEARCH decision #4's
golden-set strategy — every adapter is exercised end-to-end against the
seed pipeline's archetype contract.

The test compares **decoded structures**, not pretty-printed bytes — so
the on-disk JSON formatting (indentation, key-quote style) is purely
cosmetic and is normalized by the repo's `pretty-format-json`
pre-commit hook. Edits to whitespace don't affect the test.

Date fields appear as `<DATE>` / `<DATETIME>` placeholders. The seed
pipeline's `Faker::dateTimeBetween('-X years', 'now')` slides relative
to the system clock, so concrete dates would drift between runs. The
fixtures pin the *shape* and the *archetype-derived content*; the
adapter tests in `ArchetypeAdapterTest` pin the date semantics
independently.

## Updating

Regenerate after intentional adapter or factory changes:

```sh
UPDATE_FIXTURES=1 composer phpunit-isolated -- --filter ChartSnapshotFixtureTest
```

Always review the diff before committing. Drift in:
- archetype contracts (`bin/seed/PatientArchetype.php`)
- seed generators (`bin/seed/Generators/`)
- adapter normalization (`Snapshot/Adapter/*.php`)
- `ChartSnapshot::toArray()` shape

…all surface as fixture diffs. Phase 3.6's eval cases consume these
files via the agent-side decoder, so a fixture change is also a contract
change for the agent.
