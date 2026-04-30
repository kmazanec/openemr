import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';

import { createBriefingRunner } from '../../src/server/briefingRunner.js';
import type { Synthesizer } from '../../src/graph/nodes/synthesize.js';
import type { ClaimLedger, RequestEnvelope } from '../../src/graph/types.js';
import type { SnapshotClient } from '../../src/tools/snapshotClient.js';
import { createInMemoryConversationStore } from '../../src/state/conversationStore.js';
import { createNullUnverifiedClaimsLog } from '../../src/verify/unverifiedClaimsLog.js';

const PID = 42;

const sourceRef = (recordType: string, recordId: string) => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

const buildEnvelope = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({
    conversationId: 'browser-supplied-stale',
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
    medications: [],
    allergies: [],
    labs: [],
    encounters: [],
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
    vi.fn(() => Promise.resolve({ draft: 'Briefing.', ledger: cannedLedger }));

describe('createBriefingRunner — §3.5 conversation persistence', () => {
    it('first invocation creates a canonical conversation id and overrides the browser-supplied one', async () => {
        const conversationStore = createInMemoryConversationStore();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
        });

        const envelope = buildEnvelope({ conversationId: 'browser-supplied-stale' });
        const events = await runner({ envelope, token: 'tok' });

        const meta = events.find((e) => e.type === 'meta');
        if (meta?.type !== 'meta') throw new Error('expected meta event');
        expect(meta.conversationId).not.toBe('browser-supplied-stale');
        expect(meta.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('second invocation by the same user for the same patient resumes the same conversation', async () => {
        const conversationStore = createInMemoryConversationStore();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
        });

        const first = await runner({ envelope: buildEnvelope({ requestId: 'r-1' }), token: 'tok' });
        const second = await runner({ envelope: buildEnvelope({ requestId: 'r-2' }), token: 'tok' });

        const firstMeta = first.find((e) => e.type === 'meta');
        const secondMeta = second.find((e) => e.type === 'meta');
        if (firstMeta?.type !== 'meta' || secondMeta?.type !== 'meta') {
            throw new Error('expected meta events on both invocations');
        }
        expect(secondMeta.conversationId).toBe(firstMeta.conversationId);
    });

    it('different users on the same patient get separate conversations', async () => {
        const conversationStore = createInMemoryConversationStore();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
        });

        const drA = await runner({ envelope: buildEnvelope({ actor: { userId: 'u-A', fhirUser: 'fA' } }), token: 'tok' });
        const drB = await runner({ envelope: buildEnvelope({ actor: { userId: 'u-B', fhirUser: 'fB' } }), token: 'tok' });

        const aMeta = drA.find((e) => e.type === 'meta');
        const bMeta = drB.find((e) => e.type === 'meta');
        if (aMeta?.type !== 'meta' || bMeta?.type !== 'meta') {
            throw new Error('expected meta events');
        }
        expect(aMeta.conversationId).not.toBe(bMeta.conversationId);
    });

    it('uses the canonical conversation id as the LangGraph thread_id (observable via the checkpointer)', async () => {
        // Wire a stub checkpointer that records the thread_id passed in
        // RunnableConfig. LangGraph calls `getTuple({configurable: {thread_id}})`
        // before each step and `put(...)` after each step; either is enough
        // to observe the id the runner picked.
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

        const conversationStore = createInMemoryConversationStore();
        const runner = createBriefingRunner({
            snapshotClient: buildClient(),
            synthesizer: buildSynth(),
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
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
