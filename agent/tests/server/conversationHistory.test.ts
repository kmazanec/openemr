import { describe, expect, it } from 'vitest';

import type { AssistantMessage } from '../../src/graph/types.js';
import { createInMemoryConversationMessagesStore } from '../../src/state/conversationMessages.js';
import { createInMemoryConversationStore } from '../../src/state/conversationStore.js';
import { mintTestToken } from '../auth/testKeys.js';
import {
    TEST_AUDIENCE,
    TEST_ISSUER,
    buildAuthedApp,
    type AuthedApp,
} from './buildAuthedApp.js';

const ASSISTANT: AssistantMessage = {
    segments: [{ text: 'briefing.', claims: [], redacted: false }],
    gaps: [],
    suggestedFollowUps: [],
};

const PRACTITIONER = 'Practitioner/dr-patel';
const PID = 92;

const buildConversationApi = () => {
    const conversationMessages = createInMemoryConversationMessagesStore();
    const conversationStore = createInMemoryConversationStore(conversationMessages);
    return { conversationStore, conversationMessages };
};

const authedRequest = async (
    appBuilder: AuthedApp,
    path: string,
    subject = PRACTITIONER,
): Promise<Response> => {
    const token = await mintTestToken(appBuilder.privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject,
        scopes: [],
    });
    return appBuilder.app.request(path, {
        headers: { authorization: `Bearer ${token}` },
    });
};

describe('GET /v1/agent/conversation_history', () => {
    it('rejects unauthenticated requests', async () => {
        const conversationApi = buildConversationApi();
        const { app } = await buildAuthedApp({ conversationApi });
        const res = await app.request(`/v1/agent/conversation_history?pid=${PID}`);
        expect(res.status).toBe(401);
    });

    it('returns 400 when pid is missing or non-positive', async () => {
        const conversationApi = buildConversationApi();
        const built = await buildAuthedApp({ conversationApi });
        for (const q of ['', '0', '-5', 'abc']) {
            const res = await authedRequest(built, `/v1/agent/conversation_history?pid=${q}`);
            expect(res.status).toBe(400);
        }
    });

    it('returns 400 when only one half of the cursor is present', async () => {
        const conversationApi = buildConversationApi();
        const built = await buildAuthedApp({ conversationApi });
        const onlyTs = await authedRequest(
            built,
            `/v1/agent/conversation_history?pid=${PID}&before_updated_at=2026-01-01T00:00:00Z`,
        );
        expect(onlyTs.status).toBe(400);
        const onlyId = await authedRequest(
            built,
            `/v1/agent/conversation_history?pid=${PID}&before_id=00000000-0000-0000-0000-000000000001`,
        );
        expect(onlyId.status).toBe(400);
    });

    it('returns 200 with empty items when no history exists for this patient', async () => {
        const conversationApi = buildConversationApi();
        const built = await buildAuthedApp({ conversationApi });
        const res = await authedRequest(built, `/v1/agent/conversation_history?pid=${PID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; nextBefore: unknown };
        expect(body.items).toEqual([]);
        expect(body.nextBefore).toBeNull();
    });

    it('returns conversations newest-first with messageCount and firstQuestion', async () => {
        const conversationApi = buildConversationApi();
        const seed = await conversationApi.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: PID,
            appointmentId: null,
        });
        await conversationApi.conversationMessages.append({
            conversationId: seed.id,
            role: 'assistant',
            message: ASSISTANT,
        });
        await conversationApi.conversationMessages.append({
            conversationId: seed.id,
            role: 'user',
            text: 'Are they on metformin?',
        });
        await conversationApi.conversationMessages.append({
            conversationId: seed.id,
            role: 'assistant',
            message: ASSISTANT,
        });

        const built = await buildAuthedApp({ conversationApi });
        const res = await authedRequest(built, `/v1/agent/conversation_history?pid=${PID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            items: readonly {
                conversationId: string;
                messageCount: number;
                firstQuestion: string | null;
            }[];
            nextBefore: unknown;
        };
        expect(body.items).toHaveLength(1);
        expect(body.items[0]!.conversationId).toBe(seed.id);
        expect(body.items[0]!.messageCount).toBe(3);
        expect(body.items[0]!.firstQuestion).toBe('Are they on metformin?');
    });

    it('does not return another doctor\'s rows', async () => {
        const conversationApi = buildConversationApi();
        await conversationApi.conversationStore.create({
            userId: 'Practitioner/dr-other',
            patientPid: PID,
            appointmentId: null,
        });
        const built = await buildAuthedApp({ conversationApi });
        const res = await authedRequest(built, `/v1/agent/conversation_history?pid=${PID}`);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items).toEqual([]);
    });

    it('paginates: full page returns nextBefore, short page returns null', async () => {
        const conversationApi = buildConversationApi();
        // 3 rows, ask for limit=2 → first page is full (nextBefore set);
        // second page has 1 row (nextBefore null).
        for (let i = 0; i < 3; i++) {
            await conversationApi.conversationStore.create({
                userId: PRACTITIONER,
                patientPid: PID,
                appointmentId: null,
            });
            await new Promise((r) => setTimeout(r, 2));
        }
        const built = await buildAuthedApp({ conversationApi });
        const page1 = await authedRequest(
            built,
            `/v1/agent/conversation_history?pid=${PID}&limit=2`,
        );
        const body1 = (await page1.json()) as {
            items: readonly { conversationId: string; updatedAt: string }[];
            nextBefore: { updatedAt: string; id: string } | null;
        };
        expect(body1.items).toHaveLength(2);
        expect(body1.nextBefore).not.toBeNull();

        const cursorTs = encodeURIComponent(body1.nextBefore!.updatedAt);
        const cursorId = encodeURIComponent(body1.nextBefore!.id);
        const page2 = await authedRequest(
            built,
            `/v1/agent/conversation_history?pid=${PID}&limit=2&before_updated_at=${cursorTs}&before_id=${cursorId}`,
        );
        const body2 = (await page2.json()) as {
            items: readonly unknown[];
            nextBefore: unknown;
        };
        expect(body2.items).toHaveLength(1);
        expect(body2.nextBefore).toBeNull();
    });

    it('returns empty items when conversationApi is not wired (defensive default)', async () => {
        const built = await buildAuthedApp({});
        const res = await authedRequest(built, `/v1/agent/conversation_history?pid=${PID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; nextBefore: unknown };
        expect(body.items).toEqual([]);
        expect(body.nextBefore).toBeNull();
    });
});

describe('GET /v1/agent/latest_conversation?conversation=<uuid> (force-resume)', () => {
    it('400 on a non-UUID conversation param', async () => {
        const conversationApi = buildConversationApi();
        const built = await buildAuthedApp({ conversationApi });
        const res = await authedRequest(
            built,
            `/v1/agent/latest_conversation?pid=${PID}&conversation=not-a-uuid`,
        );
        expect(res.status).toBe(400);
    });

    it('200 with the requested thread when the principal owns it', async () => {
        const conversationApi = buildConversationApi();
        const seed = await conversationApi.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: PID,
            appointmentId: null,
        });
        await conversationApi.conversationMessages.append({
            conversationId: seed.id,
            role: 'user',
            text: 'follow-up question',
        });
        await conversationApi.conversationMessages.append({
            conversationId: seed.id,
            role: 'assistant',
            message: ASSISTANT,
        });
        const built = await buildAuthedApp({ conversationApi });
        const res = await authedRequest(
            built,
            `/v1/agent/latest_conversation?pid=${PID}&conversation=${seed.id}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            conversationId: string;
            thread: readonly { role: string; text?: string; message?: AssistantMessage }[];
        };
        expect(body.conversationId).toBe(seed.id);
        expect(body.thread).toHaveLength(2);
        expect(body.thread[0]!.role).toBe('user');
        expect(body.thread[0]!.text).toBe('follow-up question');
    });

    it('404 when the requested conversation belongs to a different doctor', async () => {
        const conversationApi = buildConversationApi();
        const seed = await conversationApi.conversationStore.create({
            userId: 'Practitioner/dr-other',
            patientPid: PID,
            appointmentId: null,
        });
        const built = await buildAuthedApp({ conversationApi });
        const res = await authedRequest(
            built,
            `/v1/agent/latest_conversation?pid=${PID}&conversation=${seed.id}`,
        );
        expect(res.status).toBe(404);
    });

    it('404 when the requested conversation belongs to a different patient', async () => {
        const conversationApi = buildConversationApi();
        const seed = await conversationApi.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: 999,
            appointmentId: null,
        });
        const built = await buildAuthedApp({ conversationApi });
        const res = await authedRequest(
            built,
            `/v1/agent/latest_conversation?pid=${PID}&conversation=${seed.id}`,
        );
        expect(res.status).toBe(404);
    });

    it('force-resume bypasses the 12h window — older conversations come back', async () => {
        const conversationApi = buildConversationApi();
        const seed = await conversationApi.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: PID,
            appointmentId: null,
        });
        await conversationApi.conversationMessages.append({
            conversationId: seed.id,
            role: 'assistant',
            message: ASSISTANT,
        });
        // Window=0 means auto-resume always returns 404. Force-resume
        // should still load the row.
        const built = await buildAuthedApp({
            conversationApi: { ...conversationApi, resumeWindowHours: 0 },
        });
        const auto = await authedRequest(built, `/v1/agent/latest_conversation?pid=${PID}`);
        expect(auto.status).toBe(404);
        const forced = await authedRequest(
            built,
            `/v1/agent/latest_conversation?pid=${PID}&conversation=${seed.id}`,
        );
        expect(forced.status).toBe(200);
    });
});
