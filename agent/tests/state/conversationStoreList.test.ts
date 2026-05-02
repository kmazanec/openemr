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
    /**
     * Helper for tests that exercise list ordering / scoping but
     * don't care about message content. The store's listing is
     * deliberately blind to orphan rows (no persisted messages), so
     * a bare `store.create()` would not surface — every fixture row
     * needs at least one message attached to be visible.
     */
    const createReal = async (overrides: Partial<ConversationKey> = {}) => {
        const conv = await store.create(baseKey(overrides));
        await messages.append({
            conversationId: conv.id,
            role: 'assistant',
            message: ASSISTANT,
        });
        return conv;
    };
    return { store, messages, createReal };
};

describe('listForUserAndPatient — §4.7 history sidebar', () => {
    it('returns rows ordered by updated_at DESC', async () => {
        const { store, createReal } = buildStores();
        const a = await createReal();
        await new Promise((r) => setTimeout(r, 2));
        const b = await createReal();
        await new Promise((r) => setTimeout(r, 2));
        const c = await createReal();
        // Touch the oldest so its updated_at advances past the others.
        await new Promise((r) => setTimeout(r, 2));
        await store.touch(a.id);

        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items.map((i) => i.id)).toEqual([a.id, c.id, b.id]);
    });

    it('scopes by user — does not return another doctor\'s rows', async () => {
        const { store, createReal } = buildStores();
        const mine = await createReal({ userId: 'u-patel' });
        await createReal({ userId: 'u-other' });

        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items.map((i) => i.id)).toEqual([mine.id]);
    });

    it('scopes by patient — does not return rows for a different patient', async () => {
        const { store, createReal } = buildStores();
        const onPatient42 = await createReal({ patientPid: 42 });
        await createReal({ patientPid: 999 });

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
        const { store, createReal } = buildStores();
        // Five rows created in tight succession; many will share the same
        // updatedAt millisecond. The composite cursor must still walk the
        // full set without dropping or repeating any row.
        const created = [];
        for (let i = 0; i < 5; i++) {
            created.push(await createReal());
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
        const { store, createReal } = buildStores();
        // Create one row; we just need to verify the cap doesn't throw
        // and the limit is honored as the smaller of (rows, cap).
        await createReal();
        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 1_000_000 });
        expect(items).toHaveLength(1);
    });

    it('returns an empty array when the user has no conversations on this patient', async () => {
        const { store } = buildStores();
        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items).toEqual([]);
    });

    it('hides orphan rows (zero persisted messages) from the listing', async () => {
        // Reproduces the prod-403 incident: the runner created the
        // conversations row, the snapshot fetch 403'd, the row was
        // left without any messages. Both the resume endpoint and
        // the sidebar must filter those out so a clinician never gets
        // stranded on an empty thread.
        const { store, createReal } = buildStores();
        const real = await createReal();
        await store.create(baseKey()); // orphan — no messages appended

        const items = await store.listForUserAndPatient('u-patel', 42, { limit: 10 });
        expect(items.map((i) => i.id)).toEqual([real.id]);
    });
});
