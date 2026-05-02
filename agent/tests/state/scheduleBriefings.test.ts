import { describe, expect, it } from 'vitest';

import {
    createNullScheduleBriefingsLog,
    createScheduleBriefingsLogFromPool,
    type PoolLike,
    type ScheduleBriefingRecord,
} from '../../src/state/scheduleBriefings.js';
import type { AssistantMessage } from '../../src/graph/types.js';

const summary: AssistantMessage = {
    segments: [],
    gaps: [],
    suggestedFollowUps: [],
};

const fixtureRecord = (): ScheduleBriefingRecord => ({
    key: {
        practitionerUuid: '11111111-1111-1111-1111-111111111111',
        appointmentId: 'appt-42',
    },
    summary,
    flags: ['DiabeticUncontrolled'],
    requestId: 'req-abc',
});

interface QueryCall {
    readonly sql: string;
    readonly params: readonly unknown[] | undefined;
    readonly via: 'pool' | 'client';
}

interface FakePool extends PoolLike {
    readonly calls: QueryCall[];
    readonly clientReleased: { count: number };
}

const buildFakePool = (
    plan: ReadonlyArray<{ rowCount: number; rows?: ReadonlyArray<Record<string, unknown>> }>,
): FakePool => {
    const calls: QueryCall[] = [];
    const clientReleased = { count: 0 };
    let planIdx = 0;

    const respond = (sql: string): { rowCount: number; rows: ReadonlyArray<Record<string, unknown>> } => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
            return { rowCount: 0, rows: [] };
        }
        const next = plan[planIdx++];
        if (next === undefined) {
            throw new Error(`fake pool exhausted at sql: ${sql.slice(0, 60)}`);
        }
        return { rowCount: next.rowCount, rows: next.rows ?? [] };
    };

    const poolQuery: PoolLike['query'] = async (sql, params) => {
        calls.push({ sql, params, via: 'pool' });
        return respond(sql);
    };

    const client = {
        query: (async (sql: string, params?: readonly unknown[]) => {
            calls.push({ sql, params, via: 'client' });
            return respond(sql);
        }) as Awaited<ReturnType<PoolLike['connect']>>['query'],
        release: () => {
            clientReleased.count += 1;
        },
    };

    const connect: PoolLike['connect'] = async () => client;

    return {
        query: poolQuery,
        connect,
        calls,
        clientReleased,
    };
};

describe('createNullScheduleBriefingsLog', () => {
    it('setup resolves and existsForToday always returns false', async () => {
        const log = createNullScheduleBriefingsLog();
        await expect(log.setup()).resolves.toBeUndefined();
        await expect(
            log.existsForToday({ practitionerUuid: 'u', appointmentId: 'a' }, '2026-05-02'),
        ).resolves.toBe(false);
    });

    it('record returns an inserted outcome without touching any database', async () => {
        const log = createNullScheduleBriefingsLog();
        const result = await log.record(fixtureRecord(), { force: false });
        expect(result).toEqual({ written: true, outcome: 'inserted' });
    });
});

describe('createScheduleBriefingsLogFromPool', () => {
    it('setup runs the schema DDL on the pool', async () => {
        const pool = buildFakePool([{ rowCount: 0 }]);
        const log = createScheduleBriefingsLogFromPool(pool);
        await log.setup();
        expect(pool.calls.length).toBe(1);
        const ddl = pool.calls[0]?.sql ?? '';
        expect(ddl).toContain('CREATE TABLE IF NOT EXISTS schedule_briefings');
        expect(ddl).toContain('UNIQUE INDEX IF NOT EXISTS schedule_briefings_unique');
    });

    it('existsForToday issues the indexed lookup with the date param', async () => {
        const pool = buildFakePool([{ rowCount: 1, rows: [{ '?column?': 1 }] }]);
        const log = createScheduleBriefingsLogFromPool(pool);
        const exists = await log.existsForToday(
            { practitionerUuid: 'u-1', appointmentId: 'a-1' },
            '2026-05-02',
        );
        expect(exists).toBe(true);
        expect(pool.calls[0]?.params).toEqual(['u-1', 'a-1', '2026-05-02']);
    });

    it('existsForToday returns false on an empty rowset', async () => {
        const pool = buildFakePool([{ rowCount: 0 }]);
        const log = createScheduleBriefingsLogFromPool(pool);
        const exists = await log.existsForToday(
            { practitionerUuid: 'u-1', appointmentId: 'a-1' },
            '2026-05-02',
        );
        expect(exists).toBe(false);
    });

    it('record without force inserts and returns inserted', async () => {
        const pool = buildFakePool([{ rowCount: 1, rows: [{ id: '7' }] }]);
        const log = createScheduleBriefingsLogFromPool(pool);
        const result = await log.record(fixtureRecord(), { force: false });
        expect(result).toEqual({ written: true, outcome: 'inserted' });
        const sqlCalls = pool.calls.map((c) => c.sql.trim().split(/\s+/)[0]);
        expect(sqlCalls).toEqual(['BEGIN', 'INSERT', 'COMMIT']);
        expect(pool.clientReleased.count).toBe(1);
    });

    it('record without force returns skipped_idempotent on UNIQUE conflict', async () => {
        const pool = buildFakePool([{ rowCount: 0 }]);
        const log = createScheduleBriefingsLogFromPool(pool);
        const result = await log.record(fixtureRecord(), { force: false });
        expect(result).toEqual({ written: false, outcome: 'skipped_idempotent' });
    });

    it('record with force deletes-then-inserts and returns overwritten', async () => {
        const pool = buildFakePool([
            { rowCount: 1 }, // DELETE matched one row
            { rowCount: 1, rows: [{ id: '8' }] }, // INSERT
        ]);
        const log = createScheduleBriefingsLogFromPool(pool);
        const result = await log.record(fixtureRecord(), { force: true });
        expect(result).toEqual({ written: true, outcome: 'overwritten' });
        const verbs = pool.calls.map((c) => c.sql.trim().split(/\s+/)[0]);
        expect(verbs).toEqual(['BEGIN', 'DELETE', 'INSERT', 'COMMIT']);
    });

    it('record with force still reports inserted when no prior row existed', async () => {
        const pool = buildFakePool([
            { rowCount: 0 }, // DELETE matched nothing
            { rowCount: 1, rows: [{ id: '9' }] }, // INSERT
        ]);
        const log = createScheduleBriefingsLogFromPool(pool);
        const result = await log.record(fixtureRecord(), { force: true });
        expect(result).toEqual({ written: true, outcome: 'inserted' });
    });

    it('record passes JSON-serialized summary and flags to the INSERT', async () => {
        const pool = buildFakePool([{ rowCount: 1, rows: [{ id: '10' }] }]);
        const log = createScheduleBriefingsLogFromPool(pool);
        await log.record(fixtureRecord(), { force: false });
        const insertCall = pool.calls.find((c) => c.sql.trim().startsWith('INSERT'));
        expect(insertCall).toBeDefined();
        const params = insertCall?.params ?? [];
        expect(params[0]).toBe('11111111-1111-1111-1111-111111111111');
        expect(params[1]).toBe('appt-42');
        expect(typeof params[2]).toBe('string');
        expect(JSON.parse(params[2] as string)).toEqual(summary);
        expect(JSON.parse(params[3] as string)).toEqual(['DiabeticUncontrolled']);
        expect(params[4]).toBe('req-abc');
    });
});
