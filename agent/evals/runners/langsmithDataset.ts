/**
 * §3.6 LangSmith dataset uploader. Pushes the canonical archetype
 * fixtures into the `clinical-copilot-uc1-golden-v1` dataset so the
 * §6.1 LangSmith eval workflow can run experiments against the same
 * golden set our local Vitest cases use.
 *
 * Idempotency: a dataset that already exists is left alone. The
 * uploader is a one-shot bootstrap, not a sync — re-running it is a
 * no-op. Re-creating the dataset (after a schema change) means
 * deleting it on the LangSmith side first.
 *
 * No-op when LANGSMITH_API_KEY is unset, so the agent's `npm test` and
 * the host-side phpunit-isolated suite never reach LangSmith. CI's
 * `test:agent-evals` job sets the env var explicitly.
 */

import { Client } from 'langsmith';

import type { BriefingSnapshot } from '../../src/graph/types.js';
import {
    loadFixture,
    loadUc2Fixture,
    loadUc5MorningPrepDay,
    type Uc2Scenario,
    type Uc5LoadedSlot,
} from '../fixtures/load.js';
import { ARCHETYPES, type ArchetypeKey } from '../fixtures/regenerate.js';
import { UC2_SCENARIOS } from '../fixtures/regenerate-uc2.js';

export const DATASET_NAME = 'clinical-copilot-uc1-golden-v3';
const DATASET_DESCRIPTION =
    'UC1 default pre-visit briefing — one canonical ChartSnapshot per archetype declared in PatientArchetype.php. Inputs are the snapshot; outputs encode archetype-pinned ground truth (diagnosis codes, prescription names, ccda-importer encounter ids the §4.1 follow-up generator should surface as external_care suggestions, overdue reminder items, patient-reported medication names) the verifier must surface. v3 (Phase 4.6) renames the medications → prescriptions split (FHIR MedicationRequest), adds reminders + medicationStatements (FHIR Task / MedicationStatement) as first-class snapshot fields, and extends ground truth with `overdueReminderItems` and `medicationStatementNames`.';

interface UploadResult {
    readonly created: boolean;
    readonly datasetName: string;
    readonly exampleCount: number;
    readonly skippedReason?: string;
}

/**
 * Returns the archetype-pinned ground truth used as the dataset's
 * `outputs` field. Mirrors the table in `archetypes.test.ts`.
 *
 * `externalEncounterIds` is the §4.4 UC4 contract: the recordIds of
 * any `system: 'ccda-importer'` encounters in the fixture. The
 * §4.1 follow-ups generator must surface an `external_care`
 * suggestion grounded in at least one of these claims; the LangSmith
 * eval scores the real-model run on whether it both renders the
 * suggestion and accepts a follow-up claim citing one of the listed
 * recordIds.
 *
 * Phase 4.6 additions:
 * - `overdueReminderItems`: itemTitles of overdue reminders the
 *   briefing should mention (and the §4.1 generator should surface
 *   as `reminder_detail` chips).
 * - `medicationStatementNames`: names of patient-reported entries
 *   the briefing should distinguish from clinic prescriptions.
 */
const groundTruth = (archetype: ArchetypeKey): {
    readonly diagnosisCodes: readonly string[];
    readonly prescriptionNames: readonly string[];
    readonly externalEncounterIds: readonly string[];
    readonly overdueReminderItems: readonly string[];
    readonly medicationStatementNames: readonly string[];
} => {
    switch (archetype) {
        case 'healthy_adult':
            return {
                diagnosisCodes: [],
                prescriptionNames: [],
                externalEncounterIds: [],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'hypertensive':
            return {
                diagnosisCodes: ['I10'],
                prescriptionNames: ['Lisinopril'],
                externalEncounterIds: [],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'diabetic':
            return {
                diagnosisCodes: ['E11.9'],
                prescriptionNames: ['Metformin'],
                externalEncounterIds: [],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'diabetic_uncontrolled':
            return {
                diagnosisCodes: ['E11.9'],
                prescriptionNames: ['Metformin', 'Lisinopril'],
                externalEncounterIds: [],
                // The diabetic_uncontrolled fixture carries an A1c
                // follow-up reminder with `due_status='due'`, not
                // 'overdue' — so it doesn't appear in
                // `overdueReminderItems`. The briefing still mentions
                // it; only the chip-emission rule keys on overdue.
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
        case 'complex_elderly':
            return {
                diagnosisCodes: ['I10', 'E78.5', 'M19.90'],
                prescriptionNames: ['Lisinopril', 'Atorvastatin'],
                externalEncounterIds: [],
                overdueReminderItems: ['Mammogram screening'],
                medicationStatementNames: ['Tylenol'],
            };
        case 'recent_ed_visit':
            return {
                diagnosisCodes: [],
                prescriptionNames: [],
                externalEncounterIds: ['enc-6006-ed'],
                overdueReminderItems: [],
                medicationStatementNames: [],
            };
    }
};

const buildExamples = (): readonly {
    inputs: { snapshot: BriefingSnapshot; archetype: ArchetypeKey };
    outputs: {
        diagnosisCodes: readonly string[];
        prescriptionNames: readonly string[];
        externalEncounterIds: readonly string[];
        overdueReminderItems: readonly string[];
        medicationStatementNames: readonly string[];
    };
    metadata: { archetype: ArchetypeKey };
}[] =>
    ARCHETYPES.map((archetype) => {
        const snapshot = loadFixture(archetype);
        return {
            inputs: { snapshot, archetype },
            outputs: groundTruth(archetype),
            metadata: { archetype },
        };
    });

export const uploadDataset = async (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> => {
    const apiKey = options.apiKey ?? process.env['LANGSMITH_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        return {
            created: false,
            datasetName: DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'LANGSMITH_API_KEY not set',
        };
    }

    const client = options.client ?? new Client({ apiKey });

    const exists = await client.hasDataset({ datasetName: DATASET_NAME });
    if (exists) {
        return {
            created: false,
            datasetName: DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'dataset already exists',
        };
    }

    const dataset = await client.createDataset(DATASET_NAME, {
        description: DATASET_DESCRIPTION,
        dataType: 'kv',
    });

    const examples = buildExamples().map((ex) => ({
        inputs: ex.inputs,
        outputs: ex.outputs,
        metadata: ex.metadata,
        dataset_id: dataset.id,
    }));

    await client.createExamples(examples);
    return {
        created: true,
        datasetName: DATASET_NAME,
        exampleCount: examples.length,
    };
};

// ---------------------------------------------------------------------
// §4.2 UC2 lab-trend dataset
// ---------------------------------------------------------------------

export const UC2_DATASET_NAME = 'clinical-copilot-uc2-trend-v1';

const UC2_DATASET_DESCRIPTION =
    'UC2 (lab/vitals trend) — one fixture per trend scenario (a1c_trend_up, a1c_trend_stable, no_lab_history). Inputs are the BriefingSnapshot whose `labHistory` slot is populated; outputs encode the expected verifier verdict (passes/redacts/no-claims) for the canonical faithful-model response shape.';

/**
 * Per-scenario ground truth: what should happen when a faithful
 * model emits a single trend-shaped claim citing every history row.
 * The Vitest gate exercises adversarial cases too; this dataset
 * captures the happy path so the nightly LangSmith experiment can
 * compare a real model run against the same expectation.
 */
const uc2GroundTruth = (scenario: Uc2Scenario): {
    readonly trendDirection: 'up' | 'stable' | 'none';
    readonly expectedAccept: boolean;
} => {
    switch (scenario) {
        case 'a1c_trend_up':
            return { trendDirection: 'up', expectedAccept: true };
        case 'a1c_trend_stable':
            return { trendDirection: 'stable', expectedAccept: true };
        case 'no_lab_history':
            // Faithful model emits a no-data acknowledgement (empty
            // ledger). No claims to accept; turn passes through.
            return { trendDirection: 'none', expectedAccept: true };
    }
};

const buildUc2Examples = (): readonly {
    inputs: { snapshot: BriefingSnapshot; scenario: Uc2Scenario };
    outputs: { trendDirection: 'up' | 'stable' | 'none'; expectedAccept: boolean };
    metadata: { scenario: Uc2Scenario };
}[] =>
    UC2_SCENARIOS.map((scenario) => {
        const snapshot = loadUc2Fixture(scenario);
        return {
            inputs: { snapshot, scenario },
            outputs: uc2GroundTruth(scenario),
            metadata: { scenario },
        };
    });

export const uploadUc2Dataset = async (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> => {
    const apiKey = options.apiKey ?? process.env['LANGSMITH_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        return {
            created: false,
            datasetName: UC2_DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'LANGSMITH_API_KEY not set',
        };
    }

    const client = options.client ?? new Client({ apiKey });

    const exists = await client.hasDataset({ datasetName: UC2_DATASET_NAME });
    if (exists) {
        return {
            created: false,
            datasetName: UC2_DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'dataset already exists',
        };
    }

    const dataset = await client.createDataset(UC2_DATASET_NAME, {
        description: UC2_DATASET_DESCRIPTION,
        dataType: 'kv',
    });

    const examples = buildUc2Examples().map((ex) => ({
        inputs: ex.inputs,
        outputs: ex.outputs,
        metadata: ex.metadata,
        dataset_id: dataset.id,
    }));

    await client.createExamples(examples);
    return {
        created: true,
        datasetName: UC2_DATASET_NAME,
        exampleCount: examples.length,
    };
};

// ---------------------------------------------------------------------
// §5.5 UC5 morning-prep dataset
// ---------------------------------------------------------------------

export const UC5_DATASET_NAME = 'clinical-copilot-uc5-morning-prep-v1';

const UC5_DATASET_DESCRIPTION =
    'UC5 (schedule-aware morning prep) — one example per slot in the synthetic 20-patient day fixture. Inputs are the slot snapshot + appointment metadata; outputs encode the expected `archetypeFlags` deriveArchetypeFlags() should produce for that slot (e.g. `archetype:diabetic_uncontrolled`). The flagged subset is 8 of 20 (3 diabetic_uncontrolled, 3 complex_elderly_new_med, 2 recent_ed_visit). Bumping the example shape means renaming this constant to `…-v2`; old experiments stay comparable.';

const buildUc5Examples = (): readonly {
    inputs: {
        snapshot: BriefingSnapshot;
        appointmentId: string;
        practitionerUuid: string;
        startAt: string;
        archetype: string;
    };
    outputs: { archetypeFlags: readonly string[] };
    metadata: { archetype: string; appointmentId: string };
}[] => {
    const day = loadUc5MorningPrepDay();
    return day.slots.map((slot: Uc5LoadedSlot) => ({
        inputs: {
            snapshot: slot.snapshot,
            appointmentId: slot.appointmentId,
            practitionerUuid: slot.practitionerUuid,
            startAt: slot.startAt,
            archetype: slot.archetype,
        },
        outputs: { archetypeFlags: slot.expectedArchetypeFlags },
        metadata: { archetype: slot.archetype, appointmentId: slot.appointmentId },
    }));
};

export const uploadUc5Dataset = async (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> => {
    const apiKey = options.apiKey ?? process.env['LANGSMITH_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
        return {
            created: false,
            datasetName: UC5_DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'LANGSMITH_API_KEY not set',
        };
    }

    const client = options.client ?? new Client({ apiKey });

    const exists = await client.hasDataset({ datasetName: UC5_DATASET_NAME });
    if (exists) {
        return {
            created: false,
            datasetName: UC5_DATASET_NAME,
            exampleCount: 0,
            skippedReason: 'dataset already exists',
        };
    }

    const dataset = await client.createDataset(UC5_DATASET_NAME, {
        description: UC5_DATASET_DESCRIPTION,
        dataType: 'kv',
    });

    const examples = buildUc5Examples().map((ex) => ({
        inputs: ex.inputs,
        outputs: ex.outputs,
        metadata: ex.metadata,
        dataset_id: dataset.id,
    }));

    await client.createExamples(examples);
    return {
        created: true,
        datasetName: UC5_DATASET_NAME,
        exampleCount: examples.length,
    };
};

export const __uc5InternalsForTesting = { buildUc5Examples };
