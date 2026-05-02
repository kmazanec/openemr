import { describe, expect, it } from 'vitest';

import {
    createNullScheduleBriefingsLog,
    type ScheduleBriefingsLog,
    type ScheduleBriefingSummary,
} from '../../src/state/scheduleBriefings.js';
import { mintTestToken } from '../auth/testKeys.js';
import {
    TEST_AUDIENCE,
    TEST_ISSUER,
    buildAuthedApp,
    type AuthedApp,
} from './buildAuthedApp.js';

const PRACTITIONER_UUID = '11111111-1111-1111-1111-111111111111';
const ANOTHER_UUID = '22222222-2222-2222-2222-222222222222';
const DATE = '2026-05-02';

const buildLogStub = (
    rows: readonly ScheduleBriefingSummary[],
): { log: ScheduleBriefingsLog; calls: { practitionerUuid: string; dateUtc: string }[] } => {
    const calls: { practitionerUuid: string; dateUtc: string }[] = [];
    const base = createNullScheduleBriefingsLog();
    return {
        calls,
        log: {
            ...base,
            listForPractitionerDay: (key) => {
                calls.push({ practitionerUuid: key.practitionerUuid, dateUtc: key.dateUtc });
                return Promise.resolve(rows);
            },
        },
    };
};

const buildAuthedRequest = async (
    appBuilder: AuthedApp,
    queryString: string,
    subject = PRACTITIONER_UUID,
): Promise<Response> => {
    const token = await mintTestToken(appBuilder.privateKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        subject,
        scopes: [],
    });
    return appBuilder.app.request(`/v1/agent/schedule_briefings${queryString}`, {
        headers: { authorization: `Bearer ${token}` },
    });
};

describe('GET /v1/agent/schedule_briefings', () => {
    it('rejects unauthenticated requests', async () => {
        const { log } = buildLogStub([]);
        const built = await buildAuthedApp({ scheduleBriefingsLog: log });
        const res = await built.app.request(
            `/v1/agent/schedule_briefings?practitioner_uuid=${PRACTITIONER_UUID}&date=${DATE}`,
        );
        expect(res.status).toBe(401);
    });

    it('returns 503 when the schedule-briefings log is not wired', async () => {
        // Defensive: the route depends on the cache store. Without it,
        // the schedule annotations endpoint should degrade — `503` keeps
        // the contract distinct from "no rows" (200 with empty list).
        const built = await buildAuthedApp({});
        const res = await buildAuthedRequest(
            built,
            `?practitioner_uuid=${PRACTITIONER_UUID}&date=${DATE}`,
        );
        expect(res.status).toBe(503);
    });

    it('returns 400 when practitioner_uuid is missing or malformed', async () => {
        const { log } = buildLogStub([]);
        const built = await buildAuthedApp({ scheduleBriefingsLog: log });
        for (const q of [
            `?date=${DATE}`,
            `?practitioner_uuid=&date=${DATE}`,
            `?practitioner_uuid=not-a-uuid&date=${DATE}`,
        ]) {
            const res = await buildAuthedRequest(built, q);
            expect(res.status).toBe(400);
        }
    });

    it('returns 400 when date is missing or not YYYY-MM-DD', async () => {
        const { log } = buildLogStub([]);
        const built = await buildAuthedApp({ scheduleBriefingsLog: log });
        for (const q of [
            `?practitioner_uuid=${PRACTITIONER_UUID}`,
            `?practitioner_uuid=${PRACTITIONER_UUID}&date=`,
            `?practitioner_uuid=${PRACTITIONER_UUID}&date=05-02-2026`,
            `?practitioner_uuid=${PRACTITIONER_UUID}&date=2026-13-01`,
            `?practitioner_uuid=${PRACTITIONER_UUID}&date=2026-02-30`,
        ]) {
            const res = await buildAuthedRequest(built, q);
            expect(res.status).toBe(400);
        }
    });

    it('returns 403 when the principal is not the requested practitioner', async () => {
        // Self-only invariant: the morning-prep cache is the
        // requesting practitioner's own pre-warm data. Reading another
        // clinician's row would be a HIPAA-relevant disclosure with no
        // corresponding `AgentDisclosure` audit row to back it up.
        const { log, calls } = buildLogStub([]);
        const built = await buildAuthedApp({ scheduleBriefingsLog: log });
        const res = await buildAuthedRequest(
            built,
            `?practitioner_uuid=${ANOTHER_UUID}&date=${DATE}`,
            PRACTITIONER_UUID,
        );
        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0);
    });

    it('returns the cached briefings for the day, matching the call key', async () => {
        const { log, calls } = buildLogStub([
            {
                appointmentId: 'appt-42',
                flags: ['DiabeticUncontrolled', 'RecentEdVisit'],
                generatedAt: '2026-05-02T13:50:00.000Z',
            },
            {
                appointmentId: 'appt-43',
                flags: [],
                generatedAt: '2026-05-02T13:51:00.000Z',
            },
        ]);
        const built = await buildAuthedApp({ scheduleBriefingsLog: log });
        const res = await buildAuthedRequest(
            built,
            `?practitioner_uuid=${PRACTITIONER_UUID}&date=${DATE}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { briefings: unknown };
        expect(body).toEqual({
            briefings: [
                {
                    appointment_id: 'appt-42',
                    flags: ['DiabeticUncontrolled', 'RecentEdVisit'],
                    generated_at: '2026-05-02T13:50:00.000Z',
                },
                {
                    appointment_id: 'appt-43',
                    flags: [],
                    generated_at: '2026-05-02T13:51:00.000Z',
                },
            ],
        });
        expect(calls).toEqual([{ practitionerUuid: PRACTITIONER_UUID, dateUtc: DATE }]);
    });

    it('returns an empty briefings list when the cache is cold for the day', async () => {
        // The disabled-default story relies on this: an opted-out
        // practitioner who never ran the precompute gets a 200 with no
        // rows, not a 404. The PHP shim treats either-empty identically.
        const { log } = buildLogStub([]);
        const built = await buildAuthedApp({ scheduleBriefingsLog: log });
        const res = await buildAuthedRequest(
            built,
            `?practitioner_uuid=${PRACTITIONER_UUID}&date=${DATE}`,
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ briefings: [] });
    });
});
