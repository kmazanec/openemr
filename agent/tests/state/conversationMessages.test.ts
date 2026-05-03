import { describe, expect, it } from 'vitest';

import {
    createInMemoryConversationMessagesStore,
} from '../../src/state/conversationMessages.js';
import type { AssistantMessage } from '../../src/graph/types.js';

const ASSISTANT_MESSAGE: AssistantMessage = {
    segments: [
        {
            text: 'Patient has type 2 diabetes (E11.9).',
            claims: [
                {
                    id: 'c-1',
                    text: 'Patient has type 2 diabetes',
                    category: 'diagnosis',
                    sourceReferences: [
                        {
                            system: 'openemr',
                            recordType: 'Condition',
                            recordId: 'c-1',
                            field: null,
                            recordedAt: null,
                        },
                    ],
                    safetyCritical: false,
                },
            ],
            redacted: false,
        },
    ],
    gaps: [],
    suggestedFollowUps: [],
    archetypeFlags: [],
};

describe('createInMemoryConversationMessagesStore', () => {
    it('appends user and assistant turns and returns them in order', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({
            conversationId: 'conv-1',
            role: 'user',
            text: 'What are the active diagnoses?',
        });
        await store.append({
            conversationId: 'conv-1',
            role: 'assistant',
            message: ASSISTANT_MESSAGE,
        });

        const thread = await store.listForConversation('conv-1');
        expect(thread).toHaveLength(2);
        expect(thread[0]!.role).toBe('user');
        if (thread[0]!.role === 'user') {
            expect(thread[0]!.text).toBe('What are the active diagnoses?');
        }
        expect(thread[1]!.role).toBe('assistant');
        if (thread[1]!.role === 'assistant') {
            expect(thread[1]!.message).toEqual(ASSISTANT_MESSAGE);
        }
    });

    it('isolates messages by conversation id', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({ conversationId: 'conv-1', role: 'user', text: 'A' });
        await store.append({ conversationId: 'conv-2', role: 'user', text: 'B' });
        const conv1 = await store.listForConversation('conv-1');
        const conv2 = await store.listForConversation('conv-2');
        expect(conv1).toHaveLength(1);
        expect(conv2).toHaveLength(1);
        if (conv1[0]!.role === 'user') expect(conv1[0]!.text).toBe('A');
        if (conv2[0]!.role === 'user') expect(conv2[0]!.text).toBe('B');
    });

    it('returns empty array for an unknown conversation id', async () => {
        const store = createInMemoryConversationMessagesStore();
        const thread = await store.listForConversation('does-not-exist');
        expect(thread).toEqual([]);
    });

    it('preserves insertion order for messages appended within the same millisecond', async () => {
        const store = createInMemoryConversationMessagesStore();
        await store.append({ conversationId: 'c', role: 'user', text: 'first' });
        await store.append({ conversationId: 'c', role: 'assistant', message: ASSISTANT_MESSAGE });
        await store.append({ conversationId: 'c', role: 'user', text: 'third' });

        const thread = await store.listForConversation('c');
        expect(thread).toHaveLength(3);
        expect(thread[0]!.role).toBe('user');
        expect(thread[1]!.role).toBe('assistant');
        expect(thread[2]!.role).toBe('user');
    });
});
