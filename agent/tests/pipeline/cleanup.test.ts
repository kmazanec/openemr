/**
 * §B.7 cleanup node tests. Pin the two safety invariants:
 *   1. Only delete keys under the configured transient prefix
 *      (image-passthrough canonical keys must survive).
 *   2. Cleanup never fails the pipeline — a delete failure is logged
 *      and the lifecycle policy is the backstop.
 */

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { cleanup, type CleanupDeps } from '../../src/pipeline/nodes/cleanup.js';
import {
    initialPipelineState,
    type PipelineState,
} from '../../src/pipeline/state.js';
import { type SpacesClient } from '../../src/storage/spaces.js';

const noopLogger = pino({ level: 'silent' });

const stubSpaces = (overrides: Partial<SpacesClient> = {}): SpacesClient => ({
    bucket: 'cdn.test.dev',
    putObject: vi.fn(),
    getObject: vi.fn(),
    deleteObject: vi.fn(() => Promise.resolve()),
    presignGetUrl: vi.fn(),
    presignPutUrl: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
});

const buildState = (
    pages: readonly { pageNum: number; key: string; signedUrl: string; expiresAt: string }[],
    status: PipelineState['status'] = 'persisted',
): PipelineState => ({
    ...initialPipelineState({
        documentUuid: 'doc-1',
        docType: 'lab_pdf',
        pid: 1,
        triggerSource: 'panel',
    }),
    pages,
    status,
});

const buildDeps = (overrides: Partial<CleanupDeps> = {}): CleanupDeps => ({
    openemrSpaces: stubSpaces(),
    transientPrefix: 'transient',
    logger: noopLogger,
    ...overrides,
});

describe('cleanup', () => {
    it('deletes every transient-prefixed PNG', async () => {
        const deletes: string[] = [];
        const spaces = stubSpaces({
            deleteObject: vi.fn((input: { key: string }) => {
                deletes.push(input.key);
                return Promise.resolve();
            }),
        });
        const state = buildState([
            { pageNum: 1, key: 'transient/doc-1/page-1.png', signedUrl: 'x', expiresAt: 'x' },
            { pageNum: 2, key: 'transient/doc-1/page-2.png', signedUrl: 'x', expiresAt: 'x' },
        ]);
        await cleanup(state, buildDeps({ openemrSpaces: spaces }));
        expect(deletes).toEqual(['transient/doc-1/page-1.png', 'transient/doc-1/page-2.png']);
    });

    it('skips canonical-key passthrough (e.g. PNG-canonical doc rasterized image-passthrough)', async () => {
        const deletes: string[] = [];
        const spaces = stubSpaces({
            deleteObject: vi.fn((input: { key: string }) => {
                deletes.push(input.key);
                return Promise.resolve();
            }),
        });
        const state = buildState([
            // Canonical key → not under transient prefix. Must survive.
            { pageNum: 1, key: '4242/doc-1.png', signedUrl: 'x', expiresAt: 'x' },
        ]);
        await cleanup(state, buildDeps({ openemrSpaces: spaces }));
        expect(deletes).toEqual([]);
    });

    it('runs on the failed-short-circuit path (e.g. patient mismatch leaves transients in place)', async () => {
        const deletes: string[] = [];
        const spaces = stubSpaces({
            deleteObject: vi.fn((input: { key: string }) => {
                deletes.push(input.key);
                return Promise.resolve();
            }),
        });
        const state = buildState(
            [
                { pageNum: 1, key: 'transient/doc-1/page-1.png', signedUrl: 'x', expiresAt: 'x' },
            ],
            'failed',
        );
        await cleanup(state, buildDeps({ openemrSpaces: spaces }));
        expect(deletes).toEqual(['transient/doc-1/page-1.png']);
    });

    it('a delete failure is logged but does not throw', async () => {
        const spaces = stubSpaces({
            deleteObject: vi.fn(() => Promise.reject(new Error('S3 boom'))),
        });
        const state = buildState([
            { pageNum: 1, key: 'transient/doc-1/page-1.png', signedUrl: 'x', expiresAt: 'x' },
            { pageNum: 2, key: 'transient/doc-1/page-2.png', signedUrl: 'x', expiresAt: 'x' },
        ]);
        await expect(cleanup(state, buildDeps({ openemrSpaces: spaces }))).resolves.toEqual({});
    });

    it('no transient pages → no-op', async () => {
        const spaces = stubSpaces();
        const state = buildState([]);
        await cleanup(state, buildDeps({ openemrSpaces: spaces }));
        expect(spaces.deleteObject).not.toHaveBeenCalled();
    });

    it('handles trailing-slash transient prefix correctly', async () => {
        const deletes: string[] = [];
        const spaces = stubSpaces({
            deleteObject: vi.fn((input: { key: string }) => {
                deletes.push(input.key);
                return Promise.resolve();
            }),
        });
        const state = buildState([
            { pageNum: 1, key: 'transient/doc-1/page-1.png', signedUrl: 'x', expiresAt: 'x' },
        ]);
        await cleanup(state, buildDeps({ openemrSpaces: spaces, transientPrefix: 'transient/' }));
        expect(deletes).toEqual(['transient/doc-1/page-1.png']);
    });
});
