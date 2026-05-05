import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    DocumentLockTimeoutError,
    createExtractionArtifactStoreFromPool,
    createPgExtractionArtifactStore,
    type ExtractionArtifactStore,
    type NewExtractionArtifact,
    type PoolLike,
} from '../../src/state/extractionArtifacts.js';

interface QueryCall {
    readonly sql: string;
    readonly params: readonly unknown[] | undefined;
    readonly via: 'pool' | 'client';
}

interface FakePool extends PoolLike {
    readonly calls: QueryCall[];
    readonly clientReleased: { count: number };
}

interface PlanEntry {
    readonly rowCount?: number;
    readonly rows?: readonly Record<string, unknown>[];
    readonly throws?: Error;
}

const buildFakePool = (plan: readonly PlanEntry[]): FakePool => {
    const calls: QueryCall[] = [];
    const clientReleased = { count: 0 };
    let planIdx = 0;

    const respond = (
        sql: string,
    ): { rowCount: number; rows: readonly Record<string, unknown>[] } => {
        const next = plan[planIdx++];
        if (next === undefined) {
            throw new Error(`fake pool exhausted at sql: ${sql.slice(0, 80)}`);
        }
        if (next.throws !== undefined) throw next.throws;
        return { rowCount: next.rowCount ?? 0, rows: next.rows ?? [] };
    };

    const poolQuery: PoolLike['query'] = (sql, params) => {
        calls.push({ sql, params, via: 'pool' });
        return Promise.resolve(respond(sql));
    };

    const client = {
        query: ((sql: string, params?: readonly unknown[]) => {
            calls.push({ sql, params, via: 'client' });
            return Promise.resolve(respond(sql));
        }) as Awaited<ReturnType<PoolLike['connect']>>['query'],
        release: () => {
            clientReleased.count += 1;
        },
    };

    const connect: PoolLike['connect'] = () => Promise.resolve(client);

    return {
        query: poolQuery,
        connect,
        calls,
        clientReleased,
    };
};

const fixtureArtifact = (overrides: Partial<NewExtractionArtifact> = {}): NewExtractionArtifact => ({
    artifactId: '11111111-1111-1111-1111-111111111111',
    documentUuid: '22222222-2222-2222-2222-222222222222',
    pid: 42,
    docType: 'lab_pdf',
    extractorVersion: 'v1.0.0',
    schemaJson: { results: [{ analyte: 'HbA1c', value: 6.4 }] },
    deltasJson: { new_diagnoses: [] },
    confidenceSignal: { patient_match_score: 1.0 },
    status: 'pending_confirmation',
    documentHash: 'a'.repeat(64),
    ...overrides,
});

const insertedRow = (artifact: NewExtractionArtifact): Record<string, unknown> => ({
    artifact_id: artifact.artifactId,
    document_uuid: artifact.documentUuid,
    pid: artifact.pid,
    doc_type: artifact.docType,
    extractor_version: artifact.extractorVersion,
    schema_json: artifact.schemaJson,
    deltas_json: artifact.deltasJson,
    confidence_signal: artifact.confidenceSignal,
    status: artifact.status,
    document_hash: artifact.documentHash,
    created_at: new Date('2026-05-05T12:00:00.000Z'),
    confirmed_at: null,
    confirmed_by_user: null,
});

describe('createExtractionArtifactStoreFromPool — setup', () => {
    it('creates the table with the architecture-pinned DDL', async () => {
        const pool = buildFakePool([{ rowCount: 0 }]);
        const store = createExtractionArtifactStoreFromPool(pool);
        await store.setup();
        expect(pool.calls.length).toBe(1);
        const ddl = pool.calls[0]?.sql ?? '';
        // The exact column set + idempotency key the architecture
        // pins. If a future change drops one of these the test
        // fails — that's the point.
        expect(ddl).toContain('CREATE TABLE IF NOT EXISTS extraction_artifacts');
        expect(ddl).toContain('artifact_id UUID PRIMARY KEY');
        expect(ddl).toContain('document_uuid VARCHAR(36) NOT NULL');
        expect(ddl).toContain('pid INTEGER NOT NULL');
        expect(ddl).toContain('doc_type VARCHAR(32) NOT NULL');
        expect(ddl).toContain('extractor_version VARCHAR(32) NOT NULL');
        expect(ddl).toContain('schema_json JSONB NOT NULL');
        expect(ddl).toContain('deltas_json JSONB');
        expect(ddl).toContain('confidence_signal JSONB');
        expect(ddl).toContain('document_hash VARCHAR(64) NOT NULL');
        expect(ddl).toContain("DEFAULT 'pending_confirmation'");
        expect(ddl).toContain('UNIQUE (document_hash, extractor_version)');
        expect(ddl).toContain(
            'extraction_artifacts_pid_doctype_status_idx',
        );
        expect(ddl).toContain('extraction_artifacts_pid_created_idx');
    });

    it('setup is idempotent — repeated calls fire the same DDL without erroring', async () => {
        const pool = buildFakePool([{ rowCount: 0 }, { rowCount: 0 }]);
        const store = createExtractionArtifactStoreFromPool(pool);
        await store.setup();
        await store.setup();
        expect(pool.calls.length).toBe(2);
    });
});

describe('createExtractionArtifactStoreFromPool — claimDocumentLock', () => {
    it('acquires the lock on the first try when free', async () => {
        const pool = buildFakePool([
            { rowCount: 1, rows: [{ locked: true }] },
            { rowCount: 1, rows: [{ released: true }] },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const handle = await store.claimDocumentLock(
            '33333333-3333-3333-3333-333333333333',
        );
        const tryCall = pool.calls.find((c) => c.sql.includes('pg_try_advisory_lock'));
        expect(tryCall).toBeDefined();
        expect(tryCall?.via).toBe('client');
        expect(typeof tryCall?.params?.[0]).toBe('string');
        await handle.release();
        const unlockCall = pool.calls.find((c) => c.sql.includes('pg_advisory_unlock'));
        expect(unlockCall).toBeDefined();
        expect(unlockCall?.params?.[0]).toBe(tryCall?.params?.[0]);
        expect(pool.clientReleased.count).toBe(1);
    });

    it('polls until the lock becomes available', async () => {
        const pool = buildFakePool([
            { rowCount: 1, rows: [{ locked: false }] },
            { rowCount: 1, rows: [{ locked: false }] },
            { rowCount: 1, rows: [{ locked: true }] },
            { rowCount: 1, rows: [{ released: true }] },
        ]);
        // Replace `setTimeout` with an immediate-resolve fake so the
        // poll loop runs synchronously in test time.
        const sleepCalls: number[] = [];
        const store = createExtractionArtifactStoreFromPool(pool, {
            sleepMs: (ms) => {
                sleepCalls.push(ms);
                return Promise.resolve();
            },
        });
        const handle = await store.claimDocumentLock(
            '44444444-4444-4444-4444-444444444444',
        );
        const tryCalls = pool.calls.filter((c) => c.sql.includes('pg_try_advisory_lock'));
        expect(tryCalls.length).toBe(3);
        expect(sleepCalls.length).toBe(2);
        await handle.release();
    });

    it('throws DocumentLockTimeoutError after the configured timeout', async () => {
        const pool = buildFakePool([
            { rowCount: 1, rows: [{ locked: false }] },
            { rowCount: 1, rows: [{ locked: false }] },
            { rowCount: 1, rows: [{ locked: false }] },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool, {
            // Each fake "sleep" advances mocked time by 50ms —
            // combined with a 100ms timeout the loop bails on the
            // third try.
            sleepMs: (_ms) => Promise.resolve(),
        });
        await expect(
            store.claimDocumentLock('55555555-5555-5555-5555-555555555555', {
                timeoutMs: 0,
            }),
        ).rejects.toBeInstanceOf(DocumentLockTimeoutError);
        // Client is released even on timeout — no leaked connection.
        expect(pool.clientReleased.count).toBe(1);
    });

    it('release is idempotent — calling twice does not double-unlock', async () => {
        const pool = buildFakePool([
            { rowCount: 1, rows: [{ locked: true }] },
            { rowCount: 1, rows: [{ released: true }] },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const handle = await store.claimDocumentLock(
            '66666666-6666-6666-6666-666666666666',
        );
        await handle.release();
        await handle.release(); // No-op; pool plan would fail otherwise.
        const unlockCalls = pool.calls.filter((c) => c.sql.includes('pg_advisory_unlock'));
        expect(unlockCalls.length).toBe(1);
    });

    it('hashes the documentUuid stably across calls', async () => {
        const pool = buildFakePool([
            { rowCount: 1, rows: [{ locked: true }] },
            { rowCount: 1, rows: [{ released: true }] },
            { rowCount: 1, rows: [{ locked: true }] },
            { rowCount: 1, rows: [{ released: true }] },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const docUuid = '77777777-7777-7777-7777-777777777777';
        const first = await store.claimDocumentLock(docUuid);
        await first.release();
        const second = await store.claimDocumentLock(docUuid);
        await second.release();
        const tryCalls = pool.calls.filter((c) => c.sql.includes('pg_try_advisory_lock'));
        expect(tryCalls.length).toBe(2);
        expect(tryCalls[0]?.params?.[0]).toBe(tryCalls[1]?.params?.[0]);
    });
});

describe('createExtractionArtifactStoreFromPool — findArtifactByDocumentHash', () => {
    it('returns null on a miss', async () => {
        const pool = buildFakePool([{ rowCount: 0 }]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const found = await store.findArtifactByDocumentHash('h'.repeat(64), 'v1.0.0');
        expect(found).toBeNull();
        expect(pool.calls[0]?.params).toEqual(['h'.repeat(64), 'v1.0.0']);
    });

    it('returns the parsed row on a hit', async () => {
        const artifact = fixtureArtifact();
        const pool = buildFakePool([
            { rowCount: 1, rows: [insertedRow(artifact)] },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const found = await store.findArtifactByDocumentHash(
            artifact.documentHash,
            artifact.extractorVersion,
        );
        expect(found).not.toBeNull();
        expect(found?.artifactId).toBe(artifact.artifactId);
        expect(found?.docType).toBe('lab_pdf');
        expect(found?.status).toBe('pending_confirmation');
        expect(found?.createdAt).toBe('2026-05-05T12:00:00.000Z');
        expect(found?.confirmedAt).toBeNull();
        expect(found?.confirmedByUser).toBeNull();
    });

    it('throws on an unknown doc_type — defends against schema drift', async () => {
        const pool = buildFakePool([
            {
                rowCount: 1,
                rows: [{ ...insertedRow(fixtureArtifact()), doc_type: 'mystery' }],
            },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        await expect(
            store.findArtifactByDocumentHash('a'.repeat(64), 'v1.0.0'),
        ).rejects.toThrow(/unexpected doc_type/);
    });

    it('throws on an unknown status — defends against schema drift', async () => {
        const pool = buildFakePool([
            {
                rowCount: 1,
                rows: [{ ...insertedRow(fixtureArtifact()), status: 'mystery' }],
            },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        await expect(
            store.findArtifactByDocumentHash('a'.repeat(64), 'v1.0.0'),
        ).rejects.toThrow(/unexpected status/);
    });
});

describe('createExtractionArtifactStoreFromPool — insertArtifact', () => {
    it('passes JSON-serialized payloads to the INSERT', async () => {
        const artifact = fixtureArtifact();
        const pool = buildFakePool([
            { rowCount: 1, rows: [insertedRow(artifact)] },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const written = await store.insertArtifact(artifact);
        expect(written.artifactId).toBe(artifact.artifactId);
        const params = pool.calls[0]?.params ?? [];
        expect(params[0]).toBe(artifact.artifactId);
        expect(params[1]).toBe(artifact.documentUuid);
        expect(params[2]).toBe(artifact.pid);
        expect(params[3]).toBe('lab_pdf');
        expect(params[4]).toBe('v1.0.0');
        // schema_json, deltas_json, confidence_signal arrive as JSON
        // strings — Postgres' jsonb column round-trips them. We pass
        // strings (not objects) because `pg`'s default serializer
        // doesn't know to JSON.stringify a structured value bound to
        // a jsonb column otherwise.
        expect(typeof params[5]).toBe('string');
        expect(JSON.parse(params[5] as string)).toEqual(artifact.schemaJson);
        expect(typeof params[6]).toBe('string');
        expect(JSON.parse(params[6] as string)).toEqual(artifact.deltasJson);
        expect(typeof params[7]).toBe('string');
        expect(JSON.parse(params[7] as string)).toEqual(artifact.confidenceSignal);
        expect(params[8]).toBe('pending_confirmation');
        expect(params[9]).toBe(artifact.documentHash);
    });

    it('serializes null deltas/confidence as SQL null, not the string "null"', async () => {
        const artifact = fixtureArtifact({ deltasJson: null, confidenceSignal: null });
        const pool = buildFakePool([
            { rowCount: 1, rows: [insertedRow(artifact)] },
        ]);
        const store = createExtractionArtifactStoreFromPool(pool);
        await store.insertArtifact(artifact);
        const params = pool.calls[0]?.params ?? [];
        expect(params[6]).toBeNull();
        expect(params[7]).toBeNull();
    });

    it('throws when the insert returns no row', async () => {
        const pool = buildFakePool([{ rowCount: 0 }]);
        const store = createExtractionArtifactStoreFromPool(pool);
        await expect(store.insertArtifact(fixtureArtifact())).rejects.toThrow(/no row/);
    });
});

describe('createExtractionArtifactStoreFromPool — updateArtifactStatus', () => {
    it('updates status alone when no metadata is supplied', async () => {
        const artifact = fixtureArtifact();
        const updatedRow = { ...insertedRow(artifact), status: 'confirmed' };
        const pool = buildFakePool([{ rowCount: 1, rows: [updatedRow] }]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const updated = await store.updateArtifactStatus(artifact.artifactId, 'confirmed');
        expect(updated?.status).toBe('confirmed');
        const params = pool.calls[0]?.params ?? [];
        expect(params[0]).toBe(artifact.artifactId);
        expect(params[1]).toBe('confirmed');
        // Optional metadata params arrive as null so the SQL's
        // `COALESCE` keeps existing values.
        expect(params[2]).toBeNull();
        expect(params[3]).toBeNull();
        expect(params[4]).toBeNull();
        expect(params[5]).toBeNull();
    });

    it('passes confirmedAt + confirmedByUser through when supplied', async () => {
        const artifact = fixtureArtifact();
        const confirmedAt = '2026-05-06T09:00:00.000Z';
        const confirmedBy = '99999999-9999-9999-9999-999999999999';
        const updatedRow = {
            ...insertedRow(artifact),
            status: 'confirmed',
            confirmed_at: new Date(confirmedAt),
            confirmed_by_user: confirmedBy,
        };
        const pool = buildFakePool([{ rowCount: 1, rows: [updatedRow] }]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const updated = await store.updateArtifactStatus(artifact.artifactId, 'confirmed', {
            confirmedAt,
            confirmedByUser: confirmedBy,
        });
        expect(updated?.confirmedAt).toBe(confirmedAt);
        expect(updated?.confirmedByUser).toBe(confirmedBy);
        const params = pool.calls[0]?.params ?? [];
        expect(params[4]).toBe(confirmedAt);
        expect(params[5]).toBe(confirmedBy);
    });

    it('returns null when the row does not exist', async () => {
        const pool = buildFakePool([{ rowCount: 0 }]);
        const store = createExtractionArtifactStoreFromPool(pool);
        const updated = await store.updateArtifactStatus(
            '00000000-0000-0000-0000-000000000000',
            'failed',
        );
        expect(updated).toBeNull();
    });
});

describe('createPgExtractionArtifactStore — connection-string validation', () => {
    it('throws when the connection string is empty', () => {
        expect(() => createPgExtractionArtifactStore({ connectionString: '' })).toThrow();
        expect(() => createPgExtractionArtifactStore({ connectionString: '   ' })).toThrow();
    });
});

/**
 * Opt-in real-Postgres integration test. Skipped unless
 * `AGENT_TEST_DATABASE_URL` is set — locally, the dev-easy stack's
 * `agent-postgres` is reachable at `postgresql://agent:agent@127.0.0.1:8330/agent`
 * (see `docker/development-easy/docker-compose.yml`'s `WT_AGENT_PG_PORT`).
 *
 * What this test buys that the fake-pool tests don't: it proves the
 * advisory-lock semantics on a real Postgres — two concurrent claims
 * on the same documentUuid must serialize, and a claim on a
 * different documentUuid must run in parallel. Skipping by default
 * keeps `npm test` host-portable.
 */
const integrationDsn = process.env['AGENT_TEST_DATABASE_URL'] ?? '';
const integrationDescribe = integrationDsn.length > 0 ? describe : describe.skip;

integrationDescribe('createPgExtractionArtifactStore — real Postgres', () => {
    let store: ExtractionArtifactStore;
    let pool: pg.Pool;

    beforeAll(async () => {
        pool = new pg.Pool({ connectionString: integrationDsn });
        // Fresh table per test run keeps the suite hermetic.
        await pool.query('DROP TABLE IF EXISTS extraction_artifacts CASCADE');
        store = createPgExtractionArtifactStore({ connectionString: integrationDsn });
        await store.setup();
    }, 30_000);

    afterAll(async () => {
        await pool.query('DROP TABLE IF EXISTS extraction_artifacts CASCADE');
        await pool.end();
    });

    it('round-trips an artifact: insert → find-by-hash → update status', async () => {
        const artifact = fixtureArtifact({
            artifactId: randomUUID(),
            documentUuid: randomUUID(),
            documentHash: randomUUID().replace(/-/g, '') + 'a'.repeat(32),
        });
        const inserted = await store.insertArtifact(artifact);
        expect(inserted.artifactId).toBe(artifact.artifactId);
        expect(inserted.status).toBe('pending_confirmation');

        const found = await store.findArtifactByDocumentHash(
            artifact.documentHash,
            artifact.extractorVersion,
        );
        expect(found?.artifactId).toBe(artifact.artifactId);

        const updated = await store.updateArtifactStatus(
            artifact.artifactId,
            'confirmed',
            { confirmedAt: '2026-05-06T09:00:00.000Z' },
        );
        expect(updated?.status).toBe('confirmed');
        expect(updated?.confirmedAt).toBe('2026-05-06T09:00:00.000Z');
    });

    it('UNIQUE (document_hash, extractor_version) blocks a duplicate insert', async () => {
        const hash = randomUUID().replace(/-/g, '') + 'b'.repeat(32);
        const first = fixtureArtifact({
            artifactId: randomUUID(),
            documentUuid: randomUUID(),
            documentHash: hash,
        });
        const second = fixtureArtifact({
            artifactId: randomUUID(),
            documentUuid: randomUUID(),
            documentHash: hash,
        });
        await store.insertArtifact(first);
        await expect(store.insertArtifact(second)).rejects.toThrow(/unique|duplicate/i);
    });

    it('two concurrent claims on the same documentUuid serialize', async () => {
        const docUuid = randomUUID();
        const events: string[] = [];
        const firstHandle = await store.claimDocumentLock(docUuid);
        events.push('first-acquired');

        // A second store backed by an independent pool simulates a
        // separate process. The advisory lock is session-scoped, so
        // a second connection genuinely contends.
        const otherStore = createPgExtractionArtifactStore({
            connectionString: integrationDsn,
        });

        const secondAcquired = otherStore
            .claimDocumentLock(docUuid)
            .then((handle) => {
                events.push('second-acquired');
                return handle;
            });

        // Give the second claim a real chance to acquire (it must not).
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(events).toEqual(['first-acquired']);

        await firstHandle.release();
        events.push('first-released');

        const handle = await secondAcquired;
        expect(events).toEqual([
            'first-acquired',
            'first-released',
            'second-acquired',
        ]);
        await handle.release();
    }, 15_000);
});
