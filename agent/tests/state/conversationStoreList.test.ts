import { describe, expect, it } from 'vitest';

import {
    createInMemoryConversationMessagesStore,
} from '../../src/state/conversationMessages.js';
import {
    createInMemoryConversationStore,
    type ConversationKey,
} from '../../src/state/conversationStore.js';
import type { AssistantMessage } from '../../src/graph/types.js';

const ASSISTANT: AssistantMessage = {
    segments: [{ text: 'briefing.', claims: [], redacted: false }],
    gaps: [],
    suggestedFollowUps: [],
};

const baseKey = (overrides: Partial<ConversationKey> = {}): ConversationKey => ({
    userId: 'u-patel',
    patientPid: 42,
    appointmentId: null,
    ...overrides,
});

const buildStores = () => {
    const messages = createInMemoryConversationMessagesStore();
    const store = createInMemoryConversationStore(messages);
    return { store, messages };
};

describe('listForUserAndPatient — §4.7 history sidebar', () => {
    it('returns rows ordered by updated_at DESC', async () => {
        const { store } = buildStores();
        const a = await store.create(baseKey());
        await new Promise((r) => setTimeout(r, 2));
        const b = await store.create(baseKey());
        await new Promise((r) => setTimeout(r, 2));
        const c = await store.create(baseKey());
        // Touch the oldest so its updated_at advances past the others.
        await new Promise((r) => setTimeout(r, 2));
        await store.touch(a.id);

        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items.map((i) => i.id)).toEqual([a.id, c.id, b.id]);
    });

    it('scopes by user — does not return another doctor\'s rows', async () => {
        const { store } = buildStores();
        const mine = await store.create(baseKey({ userId: 'u-patel' }));
        await store.create(baseKey({ userId: 'u-other' }));

        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items.map((i) => i.id)).toEqual([mine.id]);
    });

    it('scopes by patient — does not return rows for a different patient', async () => {
        const { store } = buildStores();
        const onPatient42 = await store.create(baseKey({ patientPid: 42 }));
        await store.create(baseKey({ patientPid: 999 }));

        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items.map((i) => i.id)).toEqual([onPatient42.id]);
    });

    it('derives messageCount and firstQuestion from the messages store', async () => {
        const { store, messages } = buildStores();
        const conv = await store.create(baseKey());
        await messages.append({
            conversationId: conv.id,
            role: 'assistant',
            message: ASSISTANT,
        });
        await messages.append({
            conversationId: conv.id,
            role: 'user',
            text: 'Are they on metformin?',
        });
        await messages.append({
            conversationId: conv.id,
            role: 'assistant',
            message: ASSISTANT,
        });

        const [item] = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(item!.messageCount).toBe(3);
        expect(item!.firstQuestion).toBe('Are they on metformin?');
    });

    it('returns firstQuestion = null for a conversation with no user turns', async () => {
        const { store, messages } = buildStores();
        const conv = await store.create(baseKey());
        await messages.append({
            conversationId: conv.id,
            role: 'assistant',
            message: ASSISTANT,
        });

        const [item] = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(item!.firstQuestion).toBeNull();
        expect(item!.messageCount).toBe(1);
    });

    it('paginates via the `(updatedAt, id)` cursor — including across same-ms ties', async () => {
        const { store } = buildStores();
        // Five rows created in tight succession; many will share the same
        // updatedAt millisecond. The composite cursor must still walk the
        // full set without dropping or repeating any row.
        const created = [];
        for (let i = 0; i < 5; i++) {
            created.push(await store.create(baseKey()));
        }

        const seen = new Set<string>();
        const page1 = await store.listForUserAndPatient('u-patel', 42, { limit: 2 });
        expect(page1).toHaveLength(2);
        for (const item of page1) seen.add(item.id);

        const page2 = await store.listForUserAndPatient('u-patel', 42, {
            limit: 2,
            before: { updatedAt: page1[1]!.updatedAt, id: page1[1]!.id },
        });
        expect(page2).toHaveLength(2);
        for (const item of page2) seen.add(item.id);

        const page3 = await store.listForUserAndPatient('u-patel', 42, {
            limit: 2,
            before: { updatedAt: page2[1]!.updatedAt, id: page2[1]!.id },
        });
        expect(page3).toHaveLength(1);
        for (const item of page3) seen.add(item.id);

        // Every row is exactly once in the union of pages.
        expect(seen.size).toBe(5);
        for (const c of created) expect(seen.has(c.id)).toBe(true);
    });

    it('caps `limit` at 100 regardless of caller input', async () => {
        const { store } = buildStores();
        // Create one row; we just need to verify the cap doesn't throw
        // and the limit is honored as the smaller of (rows, cap).
        await store.create(baseKey());
        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 1_000_000 });
        expect(items).toHaveLength(1);
    });

    it('returns an empty array when the user has no conversations on this patient', async () => {
        const { store } = buildStores();
        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items).toEqual([]);
    });
});
