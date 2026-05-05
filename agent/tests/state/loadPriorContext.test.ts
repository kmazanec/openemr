import { describe, expect, it, vi } from 'vitest';

import { createInMemoryConversationMessagesStore } from '../../src/state/conversationMessages.js';
import { loadPriorContext } from '../../src/state/loadPriorContext.js';
import type {
    AssistantMessage,
    BriefingSnapshot,
    PriorTurn,
} from '../../src/graph/types.js';

const sourceRef = (id: string, field = 'condition.code') => ({
    source_type: 'chart' as const,
    source_id: id,
    locator: { field },
    quote: id,
});

const snapshot: BriefingSnapshot = {
    patient: {
        pid: 42,
        uuid: 'p-1',
        displayName: 'Mrs. Patel',
        sex: 'F',
        dateOfBirth: '1968-03-15',
        ageYears: 58,
        source: sourceRef('p-42', 'patient.name'),
    },
    appointment: null,
    diagnoses: [
        {
            code: 'E11.9',
            codeSystem: 'ICD-10',
            label: 'Type 2 diabetes',
            onsetDate: '2020-01-01',
            source: sourceRef('dx-1', 'condition.code'),
        },
    ],
    prescriptions: [
        {
            name: 'Metformin',
            dose: '500 mg',
            route: 'PO',
            frequency: 'BID',
            startDate: '2020-01-01',
            stopDate: null,
            prescriber: 'Dr. Lee',
            indication: null,
            prescriptionId: 'rx-1',
            source: sourceRef('rx-1', 'medication.name'),
        },
    ],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
    labHistory: null,
};

const assistantMessage = (citationIds: readonly string[]): AssistantMessage => ({
    segments: citationIds.map((id, idx) => ({
        text: `segment ${idx}`,
        claims: [
            {
                id: `c-${id}`,
                text: `claim referencing ${id}`,
                category: 'diagnosis' as const,
                sourceReferences: [sourceRef(id)],
                safetyCritical: false,
            },
        ],
        redacted: false,
    })),
    gaps: [],
    suggestedFollowUps: [],
    archetypeFlags: [],
});

const silentLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
});

// Cast to the pino Logger shape — we only call the four methods above.
const asLogger = (l: ReturnType<typeof silentLogger>) =>
    l as unknown as Parameters<typeof loadPriorContext>[0]['logger'];

describe('loadPriorContext', () => {
    it('returns an empty turns list for a brand-new conversation', async () => {
        const store = createInMemoryConversationMessagesStore();
        const logger = silentLogger();

        const ctx = await loadPriorContext({
            conversationId: 'never-touched',
            currentQuestion: null,
            snapshot,
            listForConversation: store.listForConversation,
            logger: asLogger(logger),
        });

        expect(ctx).toEqual({ turns: [] });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('windows to the last 5 turn pairs (oldest-first) when more history exists', async () => {
        const store = createInMemoryConversationMessagesStore();
        // Append 7 alternating user/assistant turn pairs = 14 messages.
        for (let i = 0; i < 7; i++) {
            await store.append({
                conversationId: 'conv-window',
                role: 'user',
                text: `q-${i}`,
            });
            await store.append({
                conversationId: 'conv-window',
                role: 'assistant',
                message: assistantMessage([`dx-1`]),
            });
        }
        const logger = silentLogger();

        const ctx = await loadPriorContext({
            conversationId: 'conv-window',
            currentQuestion: null,
            snapshot,
            listForConversation: store.listForConversation,
            logger: asLogger(logger),
        });

        // 5 pairs * 2 = 10 messages, oldest-first within the window.
        expect(ctx.turns).toHaveLength(10);
        const userTexts = ctx.turns
            .filter((t): t is Extract<PriorTurn, { role: 'user' }> => t.role === 'user')
            .map((t) => t.text);
        // Pairs 0 + 1 dropped; window is q-2..q-6.
        expect(userTexts).toEqual(['q-2', 'q-3', 'q-4', 'q-5', 'q-6']);
    });

    it('strips the trailing current-turn user entry when text matches', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({
            conversationId: 'conv-strip',
            role: 'user',
            text: 'old question',
        });
        await store.append({
            conversationId: 'conv-strip',
            role: 'assistant',
            message: assistantMessage(['dx-1']),
        });
        await store.append({
            conversationId: 'conv-strip',
            role: 'user',
            text: 'is that trending?',
        });
        const logger = silentLogger();

        const ctx = await loadPriorContext({
            conversationId: 'conv-strip',
            currentQuestion: 'is that trending?',
            snapshot,
            listForConversation: store.listForConversation,
            logger: asLogger(logger),
        });

        // Exactly 2 turns survive — the older user/assistant pair —
        // because the trailing 'is that trending?' was the runner's
        // own pre-graph append and must not replay as prior context.
        expect(ctx.turns).toHaveLength(2);
        expect(ctx.turns[0]).toEqual({ role: 'user', text: 'old question' });
        expect(ctx.turns[1]?.role).toBe('assistant');
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs a warning and does not strip when trailing text does not match', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({
            conversationId: 'conv-mismatch',
            role: 'user',
            text: 'old question',
        });
        // Trailing user text does NOT equal currentQuestion — could
        // be a clock skew or unexpected dual write. Failing closed
        // here would corrupt the next turn, so we log and keep both.
        const logger = silentLogger();

        const ctx = await loadPriorContext({
            conversationId: 'conv-mismatch',
            currentQuestion: 'something else',
            snapshot,
            listForConversation: store.listForConversation,
            logger: asLogger(logger),
        });

        expect(ctx.turns).toHaveLength(1);
        expect(ctx.turns[0]).toEqual({ role: 'user', text: 'old question' });
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logger.warn.mock.calls[0]?.[1]).toMatch(/does not match envelope.question/);
    });

    it('falls back to opaque-pointer mode for citations not in the current snapshot', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({
            conversationId: 'conv-opaque',
            role: 'user',
            text: 'q',
        });
        // Citation source_id 'dx-stale' was in last turn's snapshot
        // but the current snapshot only carries 'dx-1'. The supervisor
        // still sees the citation; rawValue collapses to null.
        await store.append({
            conversationId: 'conv-opaque',
            role: 'assistant',
            message: assistantMessage(['dx-stale']),
        });
        const logger = silentLogger();

        const ctx = await loadPriorContext({
            conversationId: 'conv-opaque',
            currentQuestion: null,
            snapshot,
            listForConversation: store.listForConversation,
            logger: asLogger(logger),
        });

        expect(ctx.turns).toHaveLength(2);
        const assistantTurn = ctx.turns[1];
        expect(assistantTurn?.role).toBe('assistant');
        if (assistantTurn?.role !== 'assistant') return;
        expect(assistantTurn.citations).toHaveLength(1);
        expect(assistantTurn.citations[0]?.source_id).toBe('dx-stale');
        expect(assistantTurn.facts).toHaveLength(1);
        expect(assistantTurn.facts[0]?.rawValue).toBeNull();
        // Debug event logged so an operator can grep "opaque-pointer" if
        // a turn looks under-contextualized.
        expect(logger.debug).toHaveBeenCalledOnce();
    });

    it('resolves assistant citations against the current snapshot when source_id matches', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({
            conversationId: 'conv-resolve',
            role: 'user',
            text: 'q',
        });
        await store.append({
            conversationId: 'conv-resolve',
            role: 'assistant',
            message: assistantMessage(['dx-1']),
        });
        const logger = silentLogger();

        const ctx = await loadPriorContext({
            conversationId: 'conv-resolve',
            currentQuestion: null,
            snapshot,
            listForConversation: store.listForConversation,
            logger: asLogger(logger),
        });

        const assistantTurn = ctx.turns[1];
        expect(assistantTurn?.role).toBe('assistant');
        if (assistantTurn?.role !== 'assistant') return;
        // dx-1 lives in snapshot.diagnoses, so the projected fact
        // carries the resolved Diagnosis row, not null.
        expect(assistantTurn.facts).toHaveLength(1);
        const resolved = assistantTurn.facts[0]?.rawValue as { code: string };
        expect(resolved?.code).toBe('E11.9');
        expect(logger.debug).not.toHaveBeenCalled();
    });
});
