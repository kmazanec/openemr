import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';

import { BriefingContractError, createBriefingRunner } from '../../src/server/briefingRunner.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { SupervisorDecide, SupervisorDeps } from '../../src/graph/nodes/supervisor.js';
import type { ClaimLedger, RequestEnvelope, SupervisorDecision } from '../../src/graph/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createInMemoryConversationMessagesStore } from '../../src/state/conversationMessages.js';
import { createInMemoryConversationStore } from '../../src/state/conversationStore.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

const PID = 42;

const FIELD_FOR_RECORD_TYPE: Record<string, string> = {
    Patient: 'patient.name',
    Appointment: 'appointment.start',
    Condition: 'condition.code',
    MedicationRequest: 'medication.name',
    AllergyIntolerance: 'allergy.substance',
    Observation: 'observation.value',
    Encounter: 'encounter.date',
    Task: 'task.description',
    MedicationStatement: 'medicationStatement.medication',
    DocumentReference: 'documentReference.text',
};

const sourceRef = (recordType: string, recordId: string) => ({
    source_type: 'chart' as const,
    source_id: recordId,
    locator: { field: FIELD_FOR_RECORD_TYPE[recordType] ?? 'chart.record' },
    quote: recordId,
});

const buildEnvelope = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({
    conversationId: 'conv-42-placeholder',
    requestId: 'r-1',
    siteId: 'default',
    actor: { userId: 'u-patel', fhirUser: 'https://emr/Practitioner/u-patel' },
    patient: { pid: PID, uuid: 'p-1' },
    task: 'default_briefing',
    ...overrides,
});

const happyPathSnapshot = {
    patient: {
        pid: PID,
        uuid: 'p-1',
        displayName: 'Patel, Maya',
        sex: 'F',
        dateOfBirth: '1958-03-15',
        source: sourceRef('Patient', '42'),
    },
    appointment: null,
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes',
            onsetDate: '2020-01-01',
            source: sourceRef('Condition', 'c-1'),
        },
    ],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
};

const cannedLedger: ClaimLedger = {
    claims: [
        {
            id: 'c-1',
            text: 'Patient has type 2 diabetes (E11.9)',
            category: 'diagnosis',
            sourceReferences: [sourceRef('Condition', 'c-1')],
            safetyCritical: false,
        },
    ],
};

const buildClient = (): SnapshotClient => ({
    fetchSnapshot: vi.fn(() => Promise.resolve(happyPathSnapshot)),
});

const buildSynth = (): Synthesizer =>
    vi.fn(() =>
        Promise.resolve({
            draft: { segments: [{ text: 'Briefing.', claimIds: ['c-1'] }] },
            ledger: cannedLedger,
        }),
    );

const buildDeps = () => ({
    conversationStore: createInMemoryConversationStore(),
    conversationMessages: createInMemoryConversationMessagesStore(),
});

describe('createBriefingRunner — §4.6 conversation persistence and resume', () => {
    it('default_briefing always mints a fresh row, ignoring any conversationId in the envelope', async () => {
        // Even if the panel sends an authoritative UUID, default_briefing
        // is by definition the start of a new conversation. The runner
        // mints a new row and ignores the supplied id — otherwise a
        // stale tab could re-run a default briefing into an existing
        // thread and pollute it.
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });
        const seed = await conversationStore.create({
            userId: 'u-patel',
            patientPid: PID,
            appointmentId: null,
        });

        const events = await runner({
            envelope: buildEnvelope({ conversationId: seed.id }),
            token: 'tok',
        });

        const meta = events.find((e) => e.type === 'meta');
        if (meta?.type !== 'meta') throw new Error('expected meta event');
        expect(meta.conversationId).not.toBe(seed.id);
        expect(meta.conversationId).toMatch(/^[0-9a-f-]{36}$/);
        // The seed row stays empty — nothing was appended into it.
        const seedThread = await conversationMessages.listForConversation(seed.id);
        expect(seedThread).toHaveLength(0);
    });

    it('every default_briefing mints a new conversation row — no implicit resume in the runner', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });

        const first = await runner({ envelope: buildEnvelope({ requestId: 'r-1' }), token: 'tok' });
        const second = await runner({ envelope: buildEnvelope({ requestId: 'r-2' }), token: 'tok' });

        const firstMeta = first.find((e) => e.type === 'meta');
        const secondMeta = second.find((e) => e.type === 'meta');
        if (firstMeta?.type !== 'meta' || secondMeta?.type !== 'meta') {
            throw new Error('expected meta events on both invocations');
        }
        // Different rows: resume is the panel's job, not the runner's.
        expect(secondMeta.conversationId).not.toBe(firstMeta.conversationId);
    });

    it('follow_up against an owned conversation appends to that thread', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });
        const seed = await conversationStore.create({
            userId: 'u-patel',
            patientPid: PID,
            appointmentId: null,
        });

        const events = await runner({
            envelope: buildEnvelope({
                conversationId: seed.id,
                task: 'follow_up',
                question: 'Are they on metformin?',
            }),
            token: 'tok',
        });

        const meta = events.find((e) => e.type === 'meta');
        if (meta?.type !== 'meta') throw new Error('expected meta event');
        expect(meta.conversationId).toBe(seed.id);

        const thread = await conversationMessages.listForConversation(seed.id);
        expect(thread).toHaveLength(2);
        expect(thread[0]!.role).toBe('user');
        expect(thread[1]!.role).toBe('assistant');
    });

    it('follow_up without a UUID conversationId throws BriefingContractError', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });

        await expect(
            runner({
                envelope: buildEnvelope({
                    conversationId: 'conv-42-placeholder',
                    task: 'follow_up',
                    question: 'Are they on metformin?',
                }),
                token: 'tok',
            }),
        ).rejects.toBeInstanceOf(BriefingContractError);
    });

    it('follow_up against a conversation owned by a different user is rejected', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });
        const otherDrSeed = await conversationStore.create({
            userId: 'u-other',
            patientPid: PID,
            appointmentId: null,
        });

        await expect(
            runner({
                envelope: buildEnvelope({
                    conversationId: otherDrSeed.id,
                    task: 'follow_up',
                    question: 'Are they on metformin?',
                }),
                token: 'tok',
            }),
        ).rejects.toBeInstanceOf(BriefingContractError);

        // And the other doctor's thread is untouched.
        const thread = await conversationMessages.listForConversation(otherDrSeed.id);
        expect(thread).toHaveLength(0);
    });

    it('follow_up against a conversation scoped to a different patient is rejected', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });
        // Same user owns this conversation, but for a different patient.
        const otherPatientSeed = await conversationStore.create({
            userId: 'u-patel',
            patientPid: 999,
            appointmentId: null,
        });

        await expect(
            runner({
                envelope: buildEnvelope({
                    conversationId: otherPatientSeed.id,
                    task: 'follow_up',
                    question: 'Are they on metformin?',
                }),
                token: 'tok',
            }),
        ).rejects.toBeInstanceOf(BriefingContractError);
    });

    it('persists the assistant turn into conversation_messages on a default briefing', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });

        const events = await runner({ envelope: buildEnvelope(), token: 'tok' });
        const meta = events.find((e) => e.type === 'meta');
        if (meta?.type !== 'meta') throw new Error('expected meta event');

        const thread = await conversationMessages.listForConversation(meta.conversationId);
        expect(thread).toHaveLength(1);
        expect(thread[0]!.role).toBe('assistant');
        if (thread[0]!.role === 'assistant') {
            expect(thread[0]!.message.segments[0]!.text).toBe('Briefing.');
        }
    });

    it('persists user + assistant turns on a follow-up', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });
        const seed = await conversationStore.create({
            userId: 'u-patel',
            patientPid: PID,
            appointmentId: null,
        });

        const events = await runner({
            envelope: buildEnvelope({
                conversationId: seed.id,
                task: 'follow_up',
                question: 'Are they on metformin?',
            }),
            token: 'tok',
        });
        const meta = events.find((e) => e.type === 'meta');
        if (meta?.type !== 'meta') throw new Error('expected meta event');

        const thread = await conversationMessages.listForConversation(seed.id);
        expect(thread).toHaveLength(2);
        expect(thread[0]!.role).toBe('user');
        if (thread[0]!.role === 'user') {
            expect(thread[0]!.text).toBe('Are they on metformin?');
        }
        expect(thread[1]!.role).toBe('assistant');
    });

    it('touch() bumps updated_at on every persisted turn so the row stays resumable', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });

        const events = await runner({ envelope: buildEnvelope(), token: 'tok' });
        const meta = events.find((e) => e.type === 'meta');
        if (meta?.type !== 'meta') throw new Error('expected meta event');

        // The conversation we just created should be findable as
        // resumable within a 12h window.
        const resumed = await conversationStore.findResumable('u-patel', PID, 12);
        expect(resumed).not.toBeNull();
        expect(resumed!.id).toBe(meta.conversationId);
    });

    it('different users on the same patient get separate conversations', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });

        const drA = await runner({
            envelope: buildEnvelope({ actor: { userId: 'u-A', fhirUser: 'fA' } }),
            token: 'tok',
        });
        const drB = await runner({
            envelope: buildEnvelope({ actor: { userId: 'u-B', fhirUser: 'fB' } }),
            token: 'tok',
        });

        const aMeta = drA.find((e) => e.type === 'meta');
        const bMeta = drB.find((e) => e.type === 'meta');
        if (aMeta?.type !== 'meta' || bMeta?.type !== 'meta') {
            throw new Error('expected meta events');
        }
        expect(aMeta.conversationId).not.toBe(bMeta.conversationId);
    });

    it('uses the canonical conversation id as the LangGraph thread_id (observable via the checkpointer)', async () => {
        const observed: string[] = [];
        const stubCheckpointer = {
            getTuple: ({ configurable }: { configurable?: Record<string, unknown> }) => {
                const tid = configurable?.['thread_id'];
                if (typeof tid === 'string') observed.push(tid);
                return Promise.resolve(undefined);
            },
            put: ({ configurable }: { configurable?: Record<string, unknown> }) => {
                const tid = configurable?.['thread_id'];
                if (typeof tid === 'string') observed.push(tid);
                return Promise.resolve({ configurable });
            },
            putWrites: () => Promise.resolve(),
            list: () => (async function* () { /* empty */ })(),
            getNextVersion: (current: number | undefined) => (current ?? 0) + 1,
        };

        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
            checkpointer: stubCheckpointer as unknown as BaseCheckpointSaver,
        });

        const events = await runner({ envelope: buildEnvelope(), token: 'tok' });
        const meta = events.find((e) => e.type === 'meta');
        if (meta?.type !== 'meta') throw new Error('expected meta event');

        expect(observed.length).toBeGreaterThan(0);
        for (const tid of observed) {
            expect(tid).toBe(meta.conversationId);
        }
    });

});

describe('createBriefingRunner — progress event emission', () => {
    it('emits stage events in order through the onEvent callback (live SSE path)', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });

        const sink: { type: string; stage?: string; status?: string }[] = [];
        const returned = await runner({
            envelope: buildEnvelope(),
            token: 'tok',
            onEvent: (event) => {
                if (event.type === 'progress') {
                    sink.push({ type: event.type, stage: event.stage, status: event.status });
                } else {
                    sink.push({ type: event.type });
                }
            },
        });

        // When onEvent is set the runner returns an empty buffer
        // (everything went through the callback) so the route's
        // legacy iteration doesn't double-emit.
        expect(returned).toHaveLength(0);

        const types = sink.map((e) => e.type);
        expect(types[0]).toBe('meta');
        // First user-visible stage opens before the graph yields its
        // first chunk so the panel paints a spinner immediately.
        expect(sink[1]).toMatchObject({ type: 'progress', stage: 'retrieve', status: 'started' });
        expect(types[types.length - 2]).toBe('assistantMessage');
        expect(types[types.length - 1]).toBe('done');

        // Every stage in the user-visible order completes; pairs are
        // (started, completed) per stage so the renderer has both
        // edges to flip its UI.
        const progressOnly = sink.filter((e) => e.type === 'progress');
        const stageStarts = progressOnly
            .filter((e) => e.status === 'started')
            .map((e) => e.stage);
        const stageCompletes = progressOnly
            .filter((e) => e.status === 'completed')
            .map((e) => e.stage);
        expect(stageStarts).toEqual(['retrieve', 'synthesize', 'verify', 'format']);
        expect(stageCompletes).toEqual(['retrieve', 'synthesize', 'verify', 'format']);
    });

    it('without onEvent, returns a buffered event array (legacy contract for tests/precompute)', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
        });

        const events = await runner({ envelope: buildEnvelope(), token: 'tok' });

        const types = events.map((e) => e.type);
        expect(types[0]).toBe('meta');
        expect(types).toContain('progress');
        expect(types[types.length - 2]).toBe('assistantMessage');
        expect(types[types.length - 1]).toBe('done');
    });
});

describe('createBriefingRunner — supervisor narration emission', () => {
    const buildSupervisorDeps = (decisions: SupervisorDecision[]): SupervisorDeps => {
        let i = 0;
        const decide: SupervisorDecide = vi.fn(() => {
            const next = decisions[Math.min(i, decisions.length - 1)];
            i += 1;
            if (next === undefined) {
                throw new Error('supervisor stub: no decision available');
            }
            return Promise.resolve(next);
        });
        return { decide };
    };

    it('forwards each supervisor decision\'s narration as a supervisorNarration SSE event', async () => {
        const { conversationStore, conversationMessages } = buildDeps();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
            supervisor: buildSupervisorDeps([
                {
                    handoff: 'evidenceRetriever',
                    reason: 'guideline-shaped question',
                    narration: 'Checking the USPSTF on statin primary prevention.',
                    args: { query: 'statin primary prevention' },
                },
                {
                    handoff: 'synthesize',
                    reason: 'evidence in hand; ready to draft',
                    narration: 'Drafting your briefing.',
                },
            ]),
        });

        const sink: { type: string; handoff?: string; text?: string }[] = [];
        await runner({
            envelope: buildEnvelope(),
            token: 'tok',
            onEvent: (event) => {
                if (event.type === 'supervisorNarration') {
                    sink.push({ type: event.type, handoff: event.handoff, text: event.text });
                }
            },
        });

        // The synthesize narration is intentionally suppressed — its
        // assistantMessage frame already signals end-of-turn — so we
        // only see the non-terminal handoff narration.
        expect(sink).toEqual([
            {
                type: 'supervisorNarration',
                handoff: 'evidenceRetriever',
                text: 'Checking the USPSTF on statin primary prevention.',
            },
        ]);
    });
});
