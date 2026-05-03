/**
 * §5.5 UC5 morning-prep eval scaffolding.
 *
 * Drives the agent's `POST /v1/agent/briefing` precompute route with
 * a fake `briefingRunner` that, for every envelope, looks up the
 * matching slot in the loaded 20-patient day and emits an
 * `assistantMessage` event whose `archetypeFlags` is the slot's
 * `expectedArchetypeFlags`. The fake `ScheduleBriefingsLog` records
 * what the route actually persisted so cases can assert per-slot
 * flag content + run counts.
 *
 * Stub-synthesizer pattern (memory:
 * feedback applies — don't replace this with real Anthropic calls;
 * real-model coverage belongs in the nightly LangSmith experiment).
 */

import { vi } from 'vitest';

import type { BriefingRunner } from '../../../src/server/briefingRunner.js';
import type { BriefingStreamEvent } from '../../../src/server/briefingStream.js';
import type {
    AssistantMessage,
    RequestEnvelope,
} from '../../../src/graph/types.js';
import type {
    RecordOutcome,
    ScheduleBriefingRecord,
    ScheduleBriefingsLog,
} from '../../../src/state/scheduleBriefings.js';
import type { Uc5LoadedDay, Uc5LoadedSlot } from '../../fixtures/load.js';
import { loadUc5MorningPrepDay } from '../../fixtures/load.js';
import {
    buildAuthedApp,
    TEST_AUDIENCE,
    TEST_ISSUER,
    type AuthedApp,
    type AuthedAppOptions,
} from '../../../tests/server/buildAuthedApp.js';
import { mintTestToken } from '../../../tests/auth/testKeys.js';

export const loadDay = (): Uc5LoadedDay => loadUc5MorningPrepDay();

interface ExistsBehavior {
    /**
     * If `false`, every slot is "fresh" — the route invokes the runner
     * and writes a row. If `true`, every slot short-circuits with
     * `skipped_idempotent` and the runner is never called. The §5.5
     * idempotency case flips this between two passes.
     */
    readonly existsForToday: boolean;
}

export interface FakeLogState {
    readonly recorded: ScheduleBriefingRecord[];
    readonly forceFlags: boolean[];
    readonly existsCalls: { practitionerUuid: string; appointmentId: string }[];
}

export const buildFakeLog = (
    behavior: ExistsBehavior,
): { log: ScheduleBriefingsLog; state: FakeLogState } => {
    const state: FakeLogState = {
        recorded: [],
        forceFlags: [],
        existsCalls: [],
    };
    const recordOutcome: RecordOutcome = { written: true, outcome: 'inserted' };
    const log: ScheduleBriefingsLog = {
        setup: () => Promise.resolve(),
        existsForToday: (key) => {
            state.existsCalls.push({
                practitionerUuid: key.practitionerUuid,
                appointmentId: key.appointmentId,
            });
            return Promise.resolve(behavior.existsForToday);
        },
        record: (entry, options) => {
            state.recorded.push(entry);
            state.forceFlags.push(options.force);
            return Promise.resolve(recordOutcome);
        },
        listForPractitionerDay: () => Promise.resolve([]),
    };
    return { log, state };
};

const slotByAppointmentId = (
    day: Uc5LoadedDay,
): Map<string, Uc5LoadedSlot> => {
    const map = new Map<string, Uc5LoadedSlot>();
    for (const slot of day.slots) {
        map.set(slot.appointmentId, slot);
    }
    return map;
};

const buildAssistantEvent = (slot: Uc5LoadedSlot): BriefingStreamEvent => {
    const message: AssistantMessage = {
        // The UC5 eval doesn't assert prose. It asserts the row's
        // `flags[]` content, which is `gaps.map(reason) ++
        // archetypeFlags`. An empty segment list is fine for the gate.
        segments: [],
        gaps: [],
        suggestedFollowUps: [],
        archetypeFlags: slot.expectedArchetypeFlags,
    };
    return { type: 'assistantMessage', message };
};

export interface PrecomputeAppHandle {
    readonly app: AuthedApp['app'];
    readonly privateKey: AuthedApp['privateKey'];
    readonly day: Uc5LoadedDay;
    readonly state: FakeLogState;
    readonly runnerCallCount: () => number;
}

export const buildPrecomputeApp = async (
    behavior: ExistsBehavior,
    extra: Omit<AuthedAppOptions, 'briefingRunner' | 'scheduleBriefingsLog'> = {},
): Promise<PrecomputeAppHandle> => {
    const day = loadDay();
    const slots = slotByAppointmentId(day);
    let runnerCalls = 0;
    const runner: BriefingRunner = ({ envelope }: { envelope: RequestEnvelope }) => {
        runnerCalls += 1;
        // The precompute route extracts `appointmentId` from the parsed
        // envelope — but it is part of the precompute request payload,
        // not the canonical `RequestEnvelope`. The runner harness only
        // sees the canonical envelope, so we can't look up the slot
        // here. Instead, the caller threads the appointmentId via a
        // distinct conversationId (set per slot below) — the matching
        // slot is the one whose appointmentId === conversationId.
        const slot = slots.get(envelope.conversationId);
        if (slot === undefined) {
            return Promise.resolve([
                { type: 'error', code: 'no_slot_for_envelope' },
            ] satisfies readonly BriefingStreamEvent[]);
        }
        return Promise.resolve([
            buildAssistantEvent(slot),
            { type: 'done', persistedAt: '2026-05-04T07:50:00.000Z' },
        ]);
    };
    const { log, state } = buildFakeLog(behavior);
    const built = await buildAuthedApp({
        briefingRunner: runner,
        scheduleBriefingsLog: log,
        ...extra,
    });
    return {
        app: built.app,
        privateKey: built.privateKey,
        day,
        state,
        runnerCallCount: () => runnerCalls,
    };
};

export interface PostSlotResult {
    readonly status: number;
    readonly body: string;
}

export const postSlot = async (
    handle: PrecomputeAppHandle,
    slot: Uc5LoadedSlot,
    options: { readonly force?: boolean } = {},
): Promise<PostSlotResult> => {
    const token = await mintTestToken(handle.privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject: `Practitioner/${slot.practitionerUuid}`,
    });
    // Thread the slot id through `conversationId` so the harness's
    // runner can resolve "which slot is this?" from the canonical
    // envelope alone (see `buildPrecomputeApp`'s runner).
    const body = {
        conversationId: slot.appointmentId,
        requestId: `req-${slot.appointmentId}`,
        siteId: 'default',
        patient: { pid: slot.snapshot.patient.pid, uuid: slot.snapshot.patient.uuid },
        task: 'default_briefing',
        precompute: true,
        practitionerUuid: slot.practitionerUuid,
        appointmentId: slot.appointmentId,
        force: options.force ?? false,
    };
    const res = await handle.app.request('/v1/agent/briefing', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    // Mock vitest unused — placate eslint for the bring-along import.
    void vi;
    return { status: res.status, body: text };
};
