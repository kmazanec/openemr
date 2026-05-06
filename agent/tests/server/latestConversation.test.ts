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
                            source_type: 'chart' as const,
                            source_id: 'c-1',
                            locator: { field: 'condition.code' },
                            quote: 'c-1',
                        },
                    ],
                    safetyCritical: false,
                },
            ],
            redacted: false,
        },
    ],
    claimGroups: {},
    gaps: [],
    suggestedFollowUps: [],
    archetypeFlags: [],
};

const buildResume = () => {
    // Wire the messages projection into the conversation store so the
    // in-memory implementation mirrors the production EXISTS filter
    // (orphan rows with zero messages are hidden from resume + history).
    const conversationMessages = createInMemoryConversationMessagesStore();
    return {
        conversationStore: createInMemoryConversationStore(conversationMessages),
        conversationMessages,
    };
};

const PRACTITIONER = 'Practitioner/dr-patel';
const PID = 92;

const buildAuthedRequest = async (
    appBuilder: AuthedApp,
    pidQuery: string,
    subject = PRACTITIONER,
): Promise<Response> => {
    const token = await mintTestToken(appBuilder.privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject,
        scopes: [],
    });
    return appBuilder.app.request(`/v1/agent/latest_conversation?pid=${pidQuery}`, {
        headers: { authorization: `Bearer ${token}` },
    });
};

describe('GET /v1/agent/latest_conversation', () => {
    it('rejects unauthenticated requests', async () => {
        const resume = buildResume();
        const { app } = await buildAuthedApp({ resume });
        const res = await app.request(`/v1/agent/latest_conversation?pid=${PID}`);
        expect(res.status).toBe(401);
    });

    it('returns 400 when pid is missing or non-positive', async () => {
        const resume = buildResume();
        const built = await buildAuthedApp({ resume });
        const noPid = await buildAuthedRequest(built, '');
        const zeroPid = await buildAuthedRequest(built, '0');
        const negativePid = await buildAuthedRequest(built, '-5');
        const wordy = await buildAuthedRequest(built, 'abc');
        for (const res of [noPid, zeroPid, negativePid, wordy]) {
            expect(res.status).toBe(400);
        }
    });

    it('returns 404 when no conversation exists for this (user, patient)', async () => {
        const resume = buildResume();
        const built = await buildAuthedApp({ resume });
        const res = await buildAuthedRequest(built, String(PID));
        expect(res.status).toBe(404);
    });

    it('resumes the most recent conversation within the window with its rendered thread', async () => {
        const resume = buildResume();
        // Seed: a conversation owned by Dr. Patel for this patient, with
        // one user turn and one assistant turn already persisted.
        const seed = await resume.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: PID,
            appointmentId: null,
        });
        await resume.conversationMessages.append({
            conversationId: seed.id,
            role: 'user',
            text: 'What are the active diagnoses?',
        });
        await resume.conversationMessages.append({
            conversationId: seed.id,
            role: 'assistant',
            message: ASSISTANT,
        });

        const built = await buildAuthedApp({ resume });
        const res = await buildAuthedRequest(built, String(PID));
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            conversationId: string;
            updatedAt: string;
            thread: readonly { role: string; text?: string; message?: AssistantMessage }[];
        };
        expect(body.conversationId).toBe(seed.id);
        expect(typeof body.updatedAt).toBe('string');
        expect(body.thread).toHaveLength(2);
        expect(body.thread[0]!.role).toBe('user');
        expect(body.thread[0]!.text).toBe('What are the active diagnoses?');
        expect(body.thread[1]!.role).toBe('assistant');
        expect(body.thread[1]!.message).toEqual(ASSISTANT);
    });

    it('does not return another doctor\'s conversation on the same patient', async () => {
        const resume = buildResume();
        const otherDr = 'Practitioner/dr-other';
        const seed = await resume.conversationStore.create({
            userId: otherDr,
            patientPid: PID,
            appointmentId: null,
        });
        await resume.conversationMessages.append({
            conversationId: seed.id,
            role: 'assistant',
            message: ASSISTANT,
        });

        const built = await buildAuthedApp({ resume });
        const res = await buildAuthedRequest(built, String(PID), PRACTITIONER);
        expect(res.status).toBe(404);
    });

    it('returns 404 when the only candidate is older than the window', async () => {
        const resume = buildResume();
        // 0-hour window means anything is "outside" — exercise the
        // window gate without time-traveling the in-memory store.
        const seed = await resume.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: PID,
            appointmentId: null,
        });
        await resume.conversationMessages.append({
            conversationId: seed.id,
            role: 'assistant',
            message: ASSISTANT,
        });

        const built = await buildAuthedApp({ resume: { ...resume, windowHours: 0 } });
        const res = await buildAuthedRequest(built, String(PID));
        expect(res.status).toBe(404);
    });

    it('returns 404 when the resume deps are not wired (defensive default)', async () => {
        const built = await buildAuthedApp({});
        const res = await buildAuthedRequest(built, String(PID));
        expect(res.status).toBe(404);
    });

    it('skips orphan rows (zero messages) and resumes the prior real thread', async () => {
        // Reproduces the prod-403 incident: the runner created the
        // conversations row, the snapshot fetch 403'd, and the row was
        // left without any messages. On the next reload the resume
        // endpoint surfaced the orphan, the panel rendered an empty
        // "resumed" thread, and the user had no way to retry.
        const resume = buildResume();
        const realThread = await resume.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: PID,
            appointmentId: null,
        });
        await resume.conversationMessages.append({
            conversationId: realThread.id,
            role: 'assistant',
            message: ASSISTANT,
        });
        // Mint a later orphan to confirm we walk past it instead of
        // taking the most-recent-by-time row blindly.
        await new Promise((r) => setTimeout(r, 5));
        await resume.conversationStore.create({
            userId: PRACTITIONER,
            patientPid: PID,
            appointmentId: null,
        });
        const built = await buildAuthedApp({ resume });
        const res = await buildAuthedRequest(built, String(PID));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { conversationId: string };
        expect(body.conversationId).toBe(realThread.id);
    });
});
