# Seed pipeline

This directory and `bin/seed/` together implement the seeding pipeline that
populates an OpenEMR environment with synthetic chart-deep data for the
Clinical Co-Pilot scenarios defined in `USERS.md`. The pipeline is what
makes Dr. Patel's 90-second window demoable: every patient comes with the
problems, meds, vitals, labs, encounter notes, allergies, outside care,
and calendar appointments the briefing engine needs to find something
clinically interesting to surface.

## Quickstart

Inside the OpenEMR container (locally via `docker compose exec openemr ...`,
on a server via `ssh` + `docker compose exec`):

```sh
# Local dev: full reset + seed
db/seeds/seed-all.sh --count=100 --days=10

# Production / any environment with real users: SKIP THE BASELINE.
db/seeds/seed-all.sh --skip-baseline --count=100 --days=10

# Incremental: only add (or refresh) the docs/example-documents fixture
# patients + their weekly appointments — no random fill, no baseline.
db/seeds/seed-all.sh --fixtures-only
```

> **Container path note.** The container's default cwd is one level
> above `openemr/`, so the relative path `db/seeds/seed-all.sh` won't
> resolve from `docker compose exec`. Use the absolute path:
>
> ```sh
> docker compose exec openemr \
>   /var/www/localhost/htdocs/openemr/db/seeds/seed-all.sh --fixtures-only
> ```

The default invocation includes a destructive first step
(`restore-baseline.sh`) that drops and replaces every table, including
the `users` table. Always pass `--skip-baseline` on environments where
the admin password and real users matter. The script prompts before
running the destructive step and refuses to proceed in non-interactive
contexts unless `--yes` is also passed.

`--fixtures-only` implies `--skip-baseline` and propagates to both
`seed:patients` and `seed:schedule` — only the four `docs/example-documents/`
fixture patients (Chen / Whitaker / Reyes / Kowalski) and their weekly
appointments are inserted (idempotent on `(lname, DOB)` so re-running
without baseline restore doesn't duplicate). `seed:availability` still
runs because it's idempotent and harmless.

## Production usage

For environments with real users (production, staging with real data):

```sh
ssh <server>
cd /srv/openemr/current/docker/digitalocean   # or wherever compose lives
docker compose exec openemr db/seeds/seed-all.sh --skip-baseline \
    --count=100 --days=10
```

`--skip-baseline` runs only the four additive/idempotent steps:

| Step                | Touches existing data           |
|---------------------|----------------------------------|
| `seed:patients`     | INSERT-only — adds new patients  |
| `seed:availability` | Idempotent — skips covered providers |
| `seed:schedule`     | Stacks — adds appointments       |
| `seed:status`       | Read-only                        |

None of these touch the `users` table, so admin credentials are safe.

The `restore-baseline.sh` script itself has two layers of protection:

1. Refuses to run if `patient_data` already has rows. Override with
   `--force` (which means "you've thought about this").
2. With `--force`, scans the existing `users` table. If any username is
   present that's not in the upstream baseline dump, the operator is
   prompted to confirm before proceeding. That's the strong tell of a
   real environment. Pass `--yes` to bypass non-interactively.

## What you get

After `seed-all.sh`, the environment has roughly this shape per 100 patients:

| Layer                    | Count   | Drives             |
|--------------------------|---------|--------------------|
| Patients (archetype mix) | 100     | UC1 baseline       |
| Past encounters w/ SOAP  | ~250    | UC1, UC2, UC3      |
| Vitals (per encounter)   | ~250    | UC1                |
| Labs — orders / results  | ~290 / ~1,200 | UC1, UC2     |
| Active prescriptions     | ~210    | UC1, UC3           |
| Stopped prescriptions    | ~25     | UC1 deltas         |
| Allergies                | ~35     | UC1                |
| Outside encounters       | ~15     | UC4                |
| Calendar appointments    | ~540 (10 days × 3 providers × 18 slots) | UC1, UC5 |

Every layer is generated coherently per-patient via a `PatientArchetype`
(see below) — a "diabetic" patient is guaranteed an E11.9 problem, a
metformin prescription with `indication = 'Type 2 diabetes mellitus'`, a
prescribing-visit SOAP note that names the drug + indication, vitals
clustered around the diabetic baseline, and a real A1c series tracked
through `procedure_order` / `procedure_report` / `procedure_result`.

## Commands

| Command                       | What it does | Idempotency |
|-------------------------------|--------------|-------------|
| `db/seeds/restore-baseline.sh`| Restore upstream demo dump (3 patients, 9 users, ACLs, list_options). Refuses to run with a populated `patient_data` unless `--force`. | One-shot — overwrites everything. |
| `seed:patients --count=N`     | Add N archetype-driven patients with full clinical scaffolding. | **Pure additive** — re-running adds more patients. |
| `seed:availability --weeks=N` | Insert weekly In Office / Out Of Office calendar blocks per provider so the EHR considers them available for booking. | **Idempotent** — skips providers that already have a current block. |
| `seed:schedule --days=N`      | Populate calendar with appointments for yesterday + N business days. Distributes across providers, biases toward each provider's panel with ~30% coverage swaps. | **Stacks** — re-running adds more appointments to the same dates. |
| `seed:status`                 | Report row counts, coverage %, PCP panels, schedule window. Read-only. | n/a |
| `db/seeds/seed-all.sh`        | Orchestrates the four steps above in the correct order. | Runs baseline restore unless `--skip-baseline`; downstream steps follow their own rules. |

All commands take an optional `--seed=N` for deterministic Faker output.

### `seed-all.sh` flags

```
--count=N           Patients to generate (default 100)
--days=N            Business days of appointments to schedule (default 10)
--weeks=N           Weeks of provider availability to seed (default 26)
--seed=N            Faker seed for deterministic output
--skip-baseline     Don't restore baseline first (additive run on existing data)
--force-baseline    Pass --force to restore-baseline.sh (clobbers existing)
-y, --yes           Skip the destructive-step confirmation prompt
```

## Patient archetypes

`seed:patients` picks a `PatientArchetype` per patient first, then drives
every downstream generator off that archetype. This is what makes the
USERS.md scenarios reproducible — the briefing engine needs a known
data shape to retrieve, and the archetype is the contract.

| Archetype              | Share | Required problems | Required meds | Lab series | Notable |
|------------------------|-------|-------------------|---------------|------------|---------|
| `HealthyAdult`         | 40%   | none              | none          | annual CMP | Annual physicals only. |
| `Hypertensive`         | 20%   | I10               | lisinopril    | lipid + CMP | Standard HTN follow-up demo. |
| `Diabetic`             | 15%   | E11.9             | metformin     | A1c (controlled 6.5-7.2) + lipid | Stable diabetes case. |
| `DiabeticUncontrolled` | 5%    | E11.9             | metformin + lisinopril | A1c walking 7.0 → 7.6 → 8.2 + lipid + CMP | **UC2's defining demo** — the A1c trend the briefing should flag. |
| `ComplexElderly`       | 15%   | I10, E78.5, M19.90 | lisinopril + atorvastatin | lipid + CMP | High-touch chart with multiple chronic problems. |
| `RecentEdVisit`        | 5%    | none              | none          | one recent CMP | Has 1 ED visit + 1 specialty consult in `external_encounters`. **UC4's defining demo.** |

Across all archetypes, ~15% of patients pick up an opportunistic recent
abnormal lab result (last 90 days) so UC1's "new abnormal labs" briefing
slot has content even for otherwise healthy patients.

## Fixture patients

`seed:patients` also pins four **fixture patients** before the random
fill — Chen / Whitaker / Reyes / Kowalski — whose name+DOB+sex match the
intake forms and lab results under `docs/example-documents/`. The agent
pipeline's §B.6 `patientMatch` node refuses on a confident demographic
mismatch, so the fixtures need a chart to match against; pinning them
here keeps every run's demo + eval state consistent without a manual
chart-creation step.

The fixture truth-table lives in `bin/seed/FixturePatient.php` (one enum
case per document, with the exact `lname` + `DOB` the fixtures encode).
Fixture inserts are skipped when a `patient_data` row with the same
`(lname, DOB)` already exists, so re-running the seed without a baseline
restore is idempotent for the four pinned fixtures.

`seed:schedule` then adds **one upcoming appointment per week per
fixture patient** for the next `--fixture-weeks` weeks (default 12),
anchored to a fixed slot on the default PCP. This keeps each fixture
patient visible on the morning-prep view for the whole demo window and
gives the panel-upload trigger a deterministic patient to fire against.

## PCP assignment

~70% of seeded patients are assigned to the baseline `physician` user
(Donna Lee, id 6) as their PCP via `patient_data.providerID`. The rest
spread across other authorized providers. This makes Dr. Patel's panel
testable as a distinct workflow from partner-coverage visits.

`seed:schedule` consumes that assignment: each provider's calendar is
weighted toward their own panel but ~30% of slots get filled with
coverage patients from other providers' panels — matching the
Riverside Family Health workflow USERS.md describes.

## Ordering matters

The pipeline has one hard ordering constraint:

> `seed:availability` must run before `seed:schedule`.

Without current In Office blocks for every provider, OpenEMR's
appointment-availability check refuses to allow check-in on appointments,
even though the rows exist in `openemr_postcalendar_events`. The upstream
baseline ships availability blocks but they expire in 2018, so any
modern environment needs `seed:availability` to insert fresh ones before
appointments are usable.

`seed-all.sh` enforces this order. If you run the commands manually,
follow the same sequence.

## Verification

Run `seed:status` any time. It reports:

- **Row counts** for each clinical table
- **Coverage %** across the patient population (problems, allergies, prescriptions, stopped meds, vitals, labs, recent abnormals, SOAP notes, outside encounters)
- **PCP panel breakdown** — confirm Dr. Patel's ~70% panel skew
- **Schedule window** — past 7 days / today / next 14 days appointment counts

Reasonable target shape after `seed-all.sh --count=100`:

| Coverage metric         | Expected % |
|-------------------------|------------|
| has problem entry       | 75-85%     |
| has allergy             | 30-40%     |
| has prescription        | 70-80%     |
| has stopped med         | 10-15%     |
| has vitals record       | 100%       |
| has lab order           | 90-100%    |
| has recent abnormal lab | 40-60%     |
| has SOAP note           | 100%       |
| has outside encounter   | 15-25%     |

## Troubleshooting

### "Provider not available" on patient check-in

Cause: `seed:availability` hasn't been run, or its blocks have expired
since the last run. The upstream baseline rows expire in 2018 and don't
count.

Fix: `php bin/console seed:availability --weeks=26`. Idempotent, so
safe to re-run any time.

### Console errors about authUserID / undefined session keys

Several OpenEMR services (encounter inserts, vitals calc, calendar
inserts) read `authUserID` from the session. The seed commands set this
to the default PCP user ID via `SessionUtil::setSession()` at the top
of execution. If you write a new seed command, follow the same pattern —
without it, downstream service writes will throw `TypeError: Cannot
assign null to property ... $authUserId of type int`.

### `restore-baseline.sh` refuses to run

Default behavior is to refuse if `patient_data` already has rows so we
can't accidentally clobber a populated environment. Use `--force` if
you genuinely want to replace it.

### "WARNING — non-baseline users detected" prompt

`restore-baseline.sh --force` scans the existing `users` table and
prompts if it finds any username not in the upstream baseline dump.
That's almost always the right behavior — it usually means you're
about to wipe a real environment. If you really do want to proceed
(rare), pass `--yes` along with `--force`. If running non-interactively
(CI, script), `--yes` is required because the script refuses to hang
on a prompt without a tty.

### "stdin is not a terminal" error from `seed-all.sh`

Means the destructive baseline step is in the plan but stdin can't
prompt. Fix one of two ways:

- Add `--skip-baseline` (correct on prod / any environment with real users).
- Add `--yes` (only for fresh dev environments that should be wiped).

### Seed counts look low after a fresh run

Small-sample variance is real — at `--count=20` with bad luck, no
diabetic-uncontrolled patients may land. For demo-stable counts use
`--count=100` or higher, or pin `--seed=42` once you find a draw you like.

## Adding a new generator

The pattern is consistent across the existing generators:

1. **Data**: drop a curated JSON file under `bin/seed/data/` if your
   generator needs a catalog (LOINC codes, drug list, etc.).
2. **Generator class**: under `bin/seed/Generators/`, namespace
   `OpenEMR\Seed\Generators`. Take `Faker\Generator` in the constructor,
   any catalog files via `__DIR__ . '/../data/...'`. Return plain arrays
   or small `final readonly` value classes — *do not* write to the DB
   from the generator.
3. **Wire into `SeedPatientsCommand`**: instantiate the generator near
   the others, call it inside the per-patient loop, write to the DB
   from the command (via the matching service if one exists, or
   `QueryUtils::sqlInsert`/`sqlStatementThrowException` if not).
4. **Update `seed:status`**: add a row count to the `TABLES` constant
   and a coverage line to the `execute()` method's coverage table.
5. **Document**: append a row to the table at the top of this README.

Use `procedure_order` insertion in `SeedPatientsCommand::insertLabDraw()`
or `SOAP form` insertion in `insertSoapForm()` as references when you
hit a table that has no service-layer write API.

## Layout

```
db/seeds/
├── README.md               (this file)
├── baseline.README.md      Notes on the upstream-demo dump
├── baseline.sql.gz         Committed snapshot of the upstream demo DB
├── regenerate-baseline.sh  Refresh baseline.sql.gz from a clean install
├── restore-baseline.sh     Restore the dump into the current environment
└── seed-all.sh             End-to-end orchestrator

bin/seed/
├── PatientArchetype.php    Enum + clinical profile per archetype
├── Generators/             Faker generators (autoloaded as OpenEMR\Seed\*)
└── data/*.json             Curated catalogs (conditions, meds, labs, encounters)

src/Common/Command/
├── SeedPatientsCommand.php       seed:patients
├── SeedAvailabilityCommand.php   seed:availability
├── SeedScheduleCommand.php       seed:schedule
└── SeedStatusCommand.php         seed:status
```

Seed commands write through the same services the application uses
(`PatientService`, `EncounterService`, `ListService`,
`PrescriptionService`, `VitalsService`, `AppointmentService`,
`FormService`) so seeded data exercises the real validation and
event-dispatch flow. Tables without a write-side service
(`procedure_order`, `procedure_result`, `external_encounters`,
`form_soap`, calendar availability) are written via `QueryUtils`
direct INSERTs.
