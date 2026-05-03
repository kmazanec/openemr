import { describe, expect, it } from 'vitest';

import { BriefingContractError, createBriefingRunner } from '../../../src/server/briefingRunner.js';
import { createInMemoryCounters } from '../../../src/observability/counters.js';
import { createInMemoryConversationMessagesStore } from '../../../src/state/conversationMessages.js';
import { createInMemoryConversationStore } from '../../../src/state/conversationStore.js';
import { createNullUnverifiedClaimsLog } from '../../../src/verify/unverifiedClaimsLog.js';

import { baseEnvelope, buildClient, buildFaithfulSynth, loadFixture } from './_helpers.js';

/**
 * §6.6 cross-conversation leakage. PRESEARCH "Open Decisions" #6
 * pins conversation state as keyed by `(user, patient)` — a
 * follow-up envelope referencing a `conversationId` that belongs to
 * a different patient than the envelope's `pid` must be rejected
 * before any per-conversation state (chip set, message history,
 * graph checkpoint) is read. The runner enforces this at
 * `briefingRunner.ts:175-209` via
 * `conversationStore.findOwnedById(claimed, userId, patientPid)` —
 * any miss throws `BriefingContractError`.
 *
 * The unit-test in `tests/server/briefingRunner.test.ts:234-260`
 * already pins the rejection. This eval-layer case adds the
 * "0 tokens spent" framing of `crossPatient.test.ts`: the
 * synthesizer must never be invoked, the in-memory counters'
 * `modelUsage` tally stays empty, and the legitimate other-patient
 * thread is left untouched (no message append, no chip mint).
 */

describe('UC1 cross-conversation — follow-up envelope citing a conversation owned by a different patient', () => {
    it('runner rejects the envelope with 0 token spend and no state mutation on the legitimate thread', async () => {
        const snapshot = loadFixture('diabetic');
        const otherPatientPid = snapshot.patient.pid + 1;
        const principal = snapshot.patient; // The actor's "own" patient.

        const conversationStore = createInMemoryConversationStore();
        const conversationMessages = createInMemoryConversationMessagesStore();

        // Pre-seed a conversation belonging to the same actor for a
        // *different* patient. The follow-up envelope below cites
        // this row's id but claims to be for `principal`'s pid — the
        // exact cross-conversation shape the runner must refuse.
        const otherThread = await conversationStore.create({
            userId: 'eval-actor',
            patientPid: otherPatientPid,
            appointmentId: null,
        });

        const { synth, mock: synthMock } = buildFaithfulSynth();
        const counters = createInMemoryCounters();

        const runner = createBriefingRunner({
            snapshotClient: buildClient(snapshot),
            synthesizer: synth,
            unverifiedClaimsLog: createNullUnverifiedClaimsLog(),
            conversationStore,
            conversationMessages,
            counters,
        });

        const envelope = {
            ...baseEnvelope(snapshot),
            task: 'follow_up' as const,
            conversationId: otherThread.id,
            question: 'Are they still on metformin?',
            patient: { pid: principal.pid, uuid: principal.uuid },
        };

        await expect(runner({ envelope, token: 'eval-token' })).rejects.toBeInstanceOf(
            BriefingContractError,
        );

        // 0 tokens spent — synthesizer never reached, counters empty.
        expect(synthMock).not.toHaveBeenCalled();
        const tally = counters.snapshot();
        expect(tally.modelUsage).toEqual({});
        expect(tally.verification.passed).toBe(0);
        expect(tally.verification.failed).toBe(0);

        // The legitimate other-patient thread is untouched — no user
        // turn appended, no assistant turn appended.
        const otherThreadMessages = await conversationMessages.listForConversation(otherThread.id);
        expect(otherThreadMessages).toHaveLength(0);
    });
});
