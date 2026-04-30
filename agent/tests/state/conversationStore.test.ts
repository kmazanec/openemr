import { describe, expect, it } from 'vitest';

import {
    createInMemoryConversationStore,
    type ConversationKey,
} from '../../src/state/conversationStore.js';

const baseKey = (overrides: Partial<ConversationKey> = {}): ConversationKey => ({
    userId: 'u-1',
    patientPid: 42,
    appointmentId: null,
    ...overrides,
});

describe('createInMemoryConversationStore', () => {
    it('creates a new conversation row on first lookup', async () => {
        const store = createInMemoryConversationStore();
        const result = await store.findOrCreate(baseKey());
        expect(result.created).toBe(true);
        expect(result.conversation.userId).toBe('u-1');
        expect(result.conversation.patientPid).toBe(42);
        expect(result.conversation.appointmentId).toBeNull();
        expect(result.conversation.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns the same conversation id on subsequent opens', async () => {
        const store = createInMemoryConversationStore();
        const first = await store.findOrCreate(baseKey());
        const second = await store.findOrCreate(baseKey());
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.conversation.id).toBe(first.conversation.id);
    });

    it('separates conversations across users for the same patient', async () => {
        const store = createInMemoryConversationStore();
        const drA = await store.findOrCreate(baseKey({ userId: 'u-A' }));
        const drB = await store.findOrCreate(baseKey({ userId: 'u-B' }));
        expect(drA.conversation.id).not.toBe(drB.conversation.id);
    });

    it('separates conversations across patients for the same user', async () => {
        const store = createInMemoryConversationStore();
        const ptA = await store.findOrCreate(baseKey({ patientPid: 1 }));
        const ptB = await store.findOrCreate(baseKey({ patientPid: 2 }));
        expect(ptA.conversation.id).not.toBe(ptB.conversation.id);
    });

    it('treats different appointment IDs as different conversations', async () => {
        const store = createInMemoryConversationStore();
        const free = await store.findOrCreate(baseKey({ appointmentId: null }));
        const apptOne = await store.findOrCreate(baseKey({ appointmentId: 'appt-1' }));
        const apptTwo = await store.findOrCreate(baseKey({ appointmentId: 'appt-2' }));
        const apptOneAgain = await store.findOrCreate(baseKey({ appointmentId: 'appt-1' }));
        expect(free.conversation.id).not.toBe(apptOne.conversation.id);
        expect(apptOne.conversation.id).not.toBe(apptTwo.conversation.id);
        expect(apptOneAgain.conversation.id).toBe(apptOne.conversation.id);
        expect(apptOneAgain.created).toBe(false);
    });
});
