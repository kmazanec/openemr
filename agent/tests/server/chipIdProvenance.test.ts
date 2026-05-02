import { describe, expect, it } from 'vitest';

import { stableId } from '../../src/graph/followUps.js';
import type { BriefingRunner } from '../../src/server/briefingRunner.js';
import {
    createInMemoryConversationSuggestionStore,
} from '../../src/state/conversationSuggestions.js';
import { mintTestToken } from '../auth/testKeys.js';

import { TEST_AUDIENCE, TEST_ISSUER, buildAuthedApp } from './buildAuthedApp.js';

/**
 * Suggestion-chip provenance gate. Every typed `followUp` envelope is
 * re-hashed via `stableId(conversationId, params)` and looked up against
 * the per-conversation chip set the runner persisted on a previous
 * default-briefing turn. Chips that were never offered must be rejected
 * before the runner runs.
 */

const CONVERSATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_CONVERSATION_ID = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';

const baseBody = {
    requestId: 'r-1',
    siteId: 'default',
    patient: { pid: 42, uuid: 'p-1' },
    task: 'follow_up' as const,
};

const mintToken = (privateKey: Parameters<typeof mintTestToken>[0]) =>
    mintTestToken(privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject: 'Practitioner/dr-patel',
    });

describe('§4.1 chip-ID provenance gate', () => {
    it('proceeds when the chip ID was previously persisted for this conversation', async () => {
        const conversationSuggestions = createInMemoryConversationSuggestionStore();
        const followUp = { type: 'lab_trend' as const, analyte: 'A1c' };
        const chipId = stableId(CONVERSATION_ID, followUp);
        await conversationSuggestions.record({
            conversationId: CONVERSATION_ID,
            requestId: 'prior-default-1',
            chipIds: [chipId],
        });

        let runnerCalled = false;
        const runner: BriefingRunner = () => {
            runnerCalled = true;
            return Promise.resolve([]);
        };

        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            conversationSuggestions,
        });
        const token = await mintToken(privateKey);

        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                ...baseBody,
                conversationId: CONVERSATION_ID,
                followUp,
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain('"code":"unknown_chip_id"');
        expect(runnerCalled).toBe(true);
    });

    it('rejects an unknown chip ID with code unknown_chip_id and never invokes the runner', async () => {
        const conversationSuggestions = createInMemoryConversationSuggestionStore();

        let runnerCalled = false;
        const runner: BriefingRunner = () => {
            runnerCalled = true;
            return Promise.resolve([]);
        };

        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            conversationSuggestions,
        });
        const token = await mintToken(privateKey);

        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                ...baseBody,
                conversationId: CONVERSATION_ID,
                followUp: { type: 'lab_trend', analyte: 'A1c' },
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"unknown_chip_id"');
        expect(runnerCalled).toBe(false);
    });

    it('default_briefing turns proceed without a prior suggestion set', async () => {
        // The chip-ID gate fires only on follow-ups (`followUp` set);
        // first-turn default briefings have nothing to validate against
        // and must run normally.
        const conversationSuggestions = createInMemoryConversationSuggestionStore();
        let runnerCalled = false;
        const runner: BriefingRunner = () => {
            runnerCalled = true;
            return Promise.resolve([]);
        };

        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            conversationSuggestions,
        });
        const token = await mintToken(privateKey);

        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                ...baseBody,
                task: 'default_briefing',
                conversationId: CONVERSATION_ID,
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain('"code":"unknown_chip_id"');
        expect(runnerCalled).toBe(true);
    });

    it('rejects a chip ID minted for a different conversation (cross-conversation replay)', async () => {
        const conversationSuggestions = createInMemoryConversationSuggestionStore();
        const followUp = { type: 'lab_trend' as const, analyte: 'A1c' };
        const otherConvChipId = stableId(OTHER_CONVERSATION_ID, followUp);
        // Record the chip ID under conversation B…
        await conversationSuggestions.record({
            conversationId: OTHER_CONVERSATION_ID,
            requestId: 'prior-default-1',
            chipIds: [otherConvChipId],
        });

        let runnerCalled = false;
        const runner: BriefingRunner = () => {
            runnerCalled = true;
            return Promise.resolve([]);
        };

        const { app, privateKey } = await buildAuthedApp({
            briefingRunner: runner,
            conversationSuggestions,
        });
        const token = await mintToken(privateKey);

        // …then attempt to redeem against conversation A. Even if the
        // panel claimed `conversationId: A`, the recomputed chip ID for
        // (A, params) is different from the (B, params) hash we
        // persisted, so the lookup misses and the request fails closed.
        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                ...baseBody,
                conversationId: CONVERSATION_ID,
                followUp,
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('"code":"unknown_chip_id"');
        expect(runnerCalled).toBe(false);
    });

    it('skips the gate when no suggestion store is wired (legacy tests stay green)', async () => {
        // The gate is opt-in: omitting `conversationSuggestions` lets
        // older tests build an app without the side-channel. Production
        // always wires the store.
        let runnerCalled = false;
        const runner: BriefingRunner = () => {
            runnerCalled = true;
            return Promise.resolve([]);
        };
        const { app, privateKey } = await buildAuthedApp({ briefingRunner: runner });
        const token = await mintToken(privateKey);

        const res = await app.request('/v1/agent/briefing', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                ...baseBody,
                conversationId: CONVERSATION_ID,
                followUp: { type: 'lab_trend', analyte: 'A1c' },
            }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain('"code":"unknown_chip_id"');
        expect(runnerCalled).toBe(true);
    });
});
