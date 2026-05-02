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

describe('createInMemoryConversationStore — create / findResumable / touch', () => {
    it('mints a fresh row on every create call (no dedup)', async () => {
        const store = createInMemoryConversationStore();
        const first = await store.create(baseKey());
        const second = await store.create(baseKey());
        expect(first.id).not.toBe(second.id);
        expect(first.userId).toBe('u-1');
        expect(first.patientPid).toBe(42);
        expect(first.appointmentId).toBeNull();
        expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.createdAt).toBe(first.updatedAt);
    });

    it('findResumable returns null when no rows match (user, patient)', async () => {
        const store = createInMemoryConversationStore();
        await store.create(baseKey({ userId: 'someone-else' }));
        await store.create(baseKey({ patientPid: 999 }));
        const resumed = await store.findResumable('u-1', 42, 12);
        expect(resumed).toBeNull();
    });

    it('findResumable returns the most recently updated row within the window', async () => {
        const store = createInMemoryConversationStore();
        const older = await store.create(baseKey());
        const newer = await store.create(baseKey());
        const resumed = await store.findResumable('u-1', 42, 12);
        expect(resumed).not.toBeNull();
        // newer was inserted last → highest touch sequence on insertion-tie.
        expect(resumed!.id).toBe(newer.id);
        expect(resumed!.id).not.toBe(older.id);
    });

    it('findResumable scopes by user — Dr. A does not resume Dr. B\'s thread on the same patient', async () => {
        const store = createInMemoryConversationStore();
        const drA = await store.create(baseKey({ userId: 'u-A' }));
        await store.create(baseKey({ userId: 'u-B' }));
        const resumed = await store.findResumable('u-A', 42, 12);
        expect(resumed!.id).toBe(drA.id);
    });

    it('findResumable scopes by patient — opening a different patient does not resume', async () => {
        const store = createInMemoryConversationStore();
        const ptA = await store.create(baseKey({ patientPid: 1 }));
        await store.create(baseKey({ patientPid: 2 }));
        const resumed = await store.findResumable('u-1', 1, 12);
        expect(resumed!.id).toBe(ptA.id);
    });

    it('findResumable ignores rows whose updated_at falls outside the window', async () => {
        const store = createInMemoryConversationStore();
        const row = await store.create(baseKey());
        // Force the row's updated_at to 13h ago. The in-memory store
        // exposes `touch` only, so we monkey-patch via findResumable's
        // behavior: 0-hour window returns null even if a fresh row exists.
        const resumed = await store.findResumable('u-1', 42, 0);
        expect(resumed).toBeNull();
        // Sanity: with a window the just-created row resumes.
        const insideWindow = await store.findResumable('u-1', 42, 12);
        expect(insideWindow!.id).toBe(row.id);
    });

    it('touch on a non-existent id is a silent no-op', async () => {
        const store = createInMemoryConversationStore();
        await expect(store.touch('00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
    });

    it('touch updates the row\'s position in the resume order', async () => {
        const store = createInMemoryConversationStore();
        const a = await store.create(baseKey());
        // Without a touch, the latest insert (b) wins because its
        // insertion sequence is higher.
        const b = await store.create(baseKey());
        const beforeTouch = await store.findResumable('u-1', 42, 12);
        expect(beforeTouch!.id).toBe(b.id);
        // Touching `a` reassigns it the highest sequence, so the next
        // resume picks it instead.
        await store.touch(a.id);
        const afterTouch = await store.findResumable('u-1', 42, 12);
        expect(afterTouch!.id).toBe(a.id);
    });
});
