/**
 * Archetypes suite — formerly UC1. One canonical ChartSnapshot per
 * archetype declared in `bin/seed/PatientArchetype.php`; ground
 * truth pins diagnosis codes, prescription names, external-care
 * encounter ids, overdue reminder items, and patient-reported
 * medication names the verifier should surface.
 */

import type { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';

import { createBriefingGraph } from '../../src/graph/index.js';
import { createAnthropicSynthesizer } from '../../src/graph/nodes/synthesize.js';
import type { BriefingSnapshot } from '../../src/graph/types.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';
import { loadFixture } from '../fixtures/load.js';
import { ARCHETYPES, type ArchetypeKey } from '../fixtures/regenerate-archetypes.js';

import {
    buildDatasetSnapshotClient,
    uploadDatasetGeneric,
    type EvalExample,
    type EvalSuite,
    type ExperimentRunResult,
    type UploadResult,
} from './shared.js';

export const DATASET_NAME = 'clinical-copilot-uc1-golden-v4';

const DATASET_DESCRIPTION =
    'UC1 default pre-visit briefing — one canonical ChartSnapshot per archetype declared in PatientArchetype.php. Inputs are the snapshot; outputs encode archetype-pinned ground truth (diagnosis codes, prescription names, ccda-importer encounter ids the §4.1 follow-up generator should surface as external_care suggestions, overdue reminder items, patient-reported medication names) the verifier must surface. v3 (Phase 4.6) renames the medications → prescriptions split (FHIR MedicationRequest), adds reminders + medicationStatements (FHIR Task / MedicationStatement) as first-class snapshot fields, and extends ground truth with `overdueReminderItems` and `medicationStatementNames`.';

interface ArchetypeOutputs {
    readonly diagnosisCodes: readonly string[];
    readonly prescriptionNames: readonly string[];
    readonly externalEncounterIds: readonly string[];
    readonly overdueReminderItems: readonly string[];
    readonly medicationStatementNames: readonly string[];
}

interface ArchetypeInputs {
    readonly snapshot: BriefingSnapshot;
    readonly archetype: ArchetypeKey;
}

/**
 * Returns the archetype-pinned ground truth used as the dataset's
 * `outputs` field. Mirrors the table in `archetypes.test.ts`.
 *
 * `externalEncounterIds` is the §4.4 UC4 contract: the recordIds of
 * any `system: 'ccda-importer'` encounters in the fixture. The §4.1
 * follow-ups generator must surface an `external_care` suggestion
 * grounded in at least one of these claims.
 *
 * Phase 4.6 additions:
 * - `overdueReminderItems`: itemTitles of overdue reminders the
 *   briefing should mention (and the §4.1 generator should surface
 *   as `reminder_detail` chips).
 * - `medicationStatementNames`: names of patient-reported entries
 *   the briefing should distinguish from clinic prescriptions.
 */
const groundTruth = (archetype: ArchetypeKey): ArchetypeOutputs => {
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

export const buildExamples = (): readonly EvalExample<
    ArchetypeInputs,
    ArchetypeOutputs,
    { archetype: ArchetypeKey }
>[] =>
    ARCHETYPES.map((archetype) => {
        const snapshot = loadFixture(archetype);
        return {
            inputs: { snapshot, archetype },
            outputs: groundTruth(archetype),
            metadata: { archetype },
        };
    });

export const uploadDataset = (
    options: { readonly client?: Client; readonly apiKey?: string } = {},
): Promise<UploadResult> =>
    uploadDatasetGeneric({
        datasetName: DATASET_NAME,
        description: DATASET_DESCRIPTION,
        buildExamples,
        ...options,
    });

const runExperiment = async (
    options: { readonly anthropicApiKey: string; readonly gitSha: string },
): Promise<ExperimentRunResult> => {
    const synthesizer = createAnthropicSynthesizer({ apiKey: options.anthropicApiKey });

    const target = async (input: ArchetypeInputs) => {
        const graph = createBriefingGraph({
            retrieve: {
                client: buildDatasetSnapshotClient(input.snapshot),
                token: 'experiment',
                siteId: 'default',
            },
            synthesize: { synthesizer },
            verify: { unverifiedClaimsLog: createNullUnverifiedClaimsLog() },
        });
        const out = await graph.invoke({
            envelope: {
                conversationId: `exp-${input.archetype}`,
                requestId: `exp-${input.archetype}`,
                siteId: 'default',
                actor: { userId: 'experiment', fhirUser: 'https://emr/Practitioner/experiment' },
                patient: { pid: input.snapshot.patient.pid, uuid: input.snapshot.patient.uuid },
                task: 'default_briefing',
            },
        });
        const accepted = out.verified?.accepted ?? [];
        return {
            verifierPassed: out.verified?.passed === true,
            acceptedCount: accepted.length,
            rejectedCount: out.verified?.rejected.length ?? 0,
            hardStops: out.verified?.safetyHardStops ?? [],
            diagnosisCodes: accepted.filter((c) => c.category === 'diagnosis').map((c) => c.text),
            medicationNames: accepted
                .filter((c) => c.category === 'prescription')
                .map((c) => c.text),
        };
    };

    const results = await evaluate(target, {
        data: DATASET_NAME,
        experimentPrefix: `archetypes-${options.gitSha.slice(0, 7)}`,
        metadata: { git_sha: options.gitSha, suite: 'archetypes' },
    });

    return {
        suiteName: 'archetypes',
        datasetName: DATASET_NAME,
        experimentName: results.experimentName,
    };
};

export const archetypesSuite: EvalSuite = {
    name: 'archetypes',
    datasetName: DATASET_NAME,
    uploadDataset,
    runExperiment,
};
