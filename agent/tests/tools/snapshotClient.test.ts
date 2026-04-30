import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SnapshotHttpError,
    SnapshotNetworkError,
    createSnapshotClient,
    type SnapshotClient,
} from '../../src/tools/snapshotClient.js';

const TEST_BASE_URL = 'http://openemr.test';
const TEST_TOKEN = 'fake-bearer-token-for-tests';
const TEST_PID = 42;

describe('createSnapshotClient', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let client: SnapshotClient;

    beforeEach(() => {
        fetchMock = vi.fn();
        client = createSnapshotClient({
            baseUrl: TEST_BASE_URL,
            fetchImpl: fetchMock as unknown as typeof fetch,
            // No retry delay so tests stay fast.
            retryDelayMs: 0,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('GETs the snapshot endpoint with the bearer token and the requested categories', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ patient: {}, diagnoses: [], allergies: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        await client.fetchSnapshot({
            pid: TEST_PID,
            categories: ['diagnosis', 'allergy'],
            token: TEST_TOKEN,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const call = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(call[0]).toBe(
            `${TEST_BASE_URL}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot.php?pid=42&categories=diagnosis%2Callergy`,
        );
        expect(call[1]).toMatchObject({
            method: 'GET',
            headers: {
                authorization: `Bearer ${TEST_TOKEN}`,
                accept: 'application/json',
            },
        });
    });

    it('returns the parsed JSON body on success', async () => {
        const body = { patient: { pid: TEST_PID }, diagnoses: [{ code: 'E11.9' }] };
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const out = await client.fetchSnapshot({
            pid: TEST_PID,
            categories: ['diagnosis'],
            token: TEST_TOKEN,
        });

        expect(out).toEqual(body);
    });

    it('retries once on a 503 then returns the second response', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('overloaded', { status: 503 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ patient: {} }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );

        const out = await client.fetchSnapshot({
            pid: TEST_PID,
            categories: ['diagnosis'],
            token: TEST_TOKEN,
        });

        expect(out).toEqual({ patient: {} });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries once on a network error then returns the second response', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ patient: {} }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );

        const out = await client.fetchSnapshot({
            pid: TEST_PID,
            categories: ['diagnosis'],
            token: TEST_TOKEN,
        });

        expect(out).toEqual({ patient: {} });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws SnapshotHttpError after retrying once on a persistent 503', async () => {
        fetchMock.mockResolvedValue(new Response('overloaded', { status: 503 }));

        await expect(
            client.fetchSnapshot({
                pid: TEST_PID,
                categories: ['diagnosis'],
                token: TEST_TOKEN,
            }),
        ).rejects.toBeInstanceOf(SnapshotHttpError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws SnapshotHttpError immediately on a 401 (no retry on auth errors)', async () => {
        fetchMock.mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }));

        await expect(
            client.fetchSnapshot({
                pid: TEST_PID,
                categories: ['diagnosis'],
                token: TEST_TOKEN,
            }),
        ).rejects.toMatchObject({
            name: 'SnapshotHttpError',
            status: 401,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws SnapshotHttpError immediately on a 403 (no retry on auth errors)', async () => {
        fetchMock.mockResolvedValueOnce(new Response('{"error":"forbidden"}', { status: 403 }));

        await expect(
            client.fetchSnapshot({
                pid: TEST_PID,
                categories: ['diagnosis'],
                token: TEST_TOKEN,
            }),
        ).rejects.toMatchObject({
            name: 'SnapshotHttpError',
            status: 403,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws SnapshotHttpError immediately on a 404 (no retry on client errors)', async () => {
        fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

        await expect(
            client.fetchSnapshot({
                pid: TEST_PID,
                categories: ['diagnosis'],
                token: TEST_TOKEN,
            }),
        ).rejects.toMatchObject({
            name: 'SnapshotHttpError',
            status: 404,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws SnapshotNetworkError when both attempts fail with network errors', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));

        await expect(
            client.fetchSnapshot({
                pid: TEST_PID,
                categories: ['diagnosis'],
                token: TEST_TOKEN,
            }),
        ).rejects.toBeInstanceOf(SnapshotNetworkError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects an empty categories list at the call site', async () => {
        await expect(
            client.fetchSnapshot({ pid: TEST_PID, categories: [], token: TEST_TOKEN }),
        ).rejects.toThrow(/categories.*required/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a non-positive pid at the call site', async () => {
        await expect(
            client.fetchSnapshot({ pid: 0, categories: ['diagnosis'], token: TEST_TOKEN }),
        ).rejects.toThrow(/pid.*positive/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
