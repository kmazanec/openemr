/**
 * §B.3 rasterize node tests.
 *
 * Stubs the Rasterizer and Spaces clients; uses real fixture PDFs + a
 * real PNG from `agent/evals/fixtures/document-extraction/source/` so
 * the page-count probe and image-passthrough branches exercise real
 * bytes. The fixtures are the same ones the §B.10 eval suite will
 * consume, keeping the per-MR pipeline gate and the nightly evals
 * agreed on what "a typical document" looks like.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
    ESTIMATED_DOLLARS_PER_PAGE,
    PER_DOCUMENT_DOLLAR_CAP,
    SIGNED_URL_TTL_SEC,
    rasterize,
    type RasterizeDeps,
} from '../../src/pipeline/nodes/rasterize.js';
import { initialPipelineState, type PipelineState } from '../../src/pipeline/state.js';
import { type Rasterizer } from '../../src/pipeline/rasterizer.js';
import { type SpacesClient } from '../../src/storage/spaces.js';

const requirePages = (
    out: Partial<PipelineState>,
): readonly { pageNum: number; key: string; signedUrl: string; expiresAt: string }[] => {
    expect(out.pages).toBeDefined();
    return out.pages as readonly {
        pageNum: number;
        key: string;
        signedUrl: string;
        expiresAt: string;
    }[];
};

const requireErrors = (
    out: Partial<PipelineState>,
): readonly { code: string; message: string; details?: Readonly<Record<string, unknown>> }[] => {
    expect(out.errors).toBeDefined();
    return out.errors as readonly {
        code: string;
        message: string;
        details?: Readonly<Record<string, unknown>>;
    }[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = resolve(__dirname, '../../evals/fixtures/document-extraction/source');

const readFixture = (relpath: string): Buffer => readFileSync(resolve(FIXTURE_ROOT, relpath));

const buildFakeSpaces = (
    stored: Map<string, Buffer>,
    role: 'openemr' | 'agent',
    canonicalContentType = 'application/pdf',
): SpacesClient => ({
    bucket: 'cdn.test.dev',
    putObject: vi.fn((input: { key: string; body: Buffer }) => {
        stored.set(input.key, input.body);
        return Promise.resolve();
    }),
    getObject: vi.fn((input: { key: string }) => {
        const buf = stored.get(input.key);
        if (buf === undefined) {
            return Promise.reject(new Error(`no fake object at ${input.key}`));
        }
        return Promise.resolve({ body: buf, contentType: canonicalContentType });
    }),
    deleteObject: vi.fn(() => Promise.resolve()),
    presignGetUrl: vi.fn((key: string) => Promise.resolve(`https://signed.test/${role}/${key}`)),
    presignPutUrl: vi.fn((key: string) =>
        Promise.resolve(`https://signed.test/${role}/put/${key}`),
    ),
    destroy: vi.fn(),
});

const fakeSpacesClient = (overrides: Partial<SpacesClient> = {}): SpacesClient => {
    const stored = new Map<string, Buffer>();
    return { ...buildFakeSpaces(stored, 'openemr'), ...overrides };
};

/**
 * Helper to seed a canonical object on the OpenEMR-side client. Each
 * test gets an isolated pair of fake clients sharing nothing.
 */
const seedCanonical = (
    pid: number,
    documentUuid: string,
    ext: string,
    bytes: Buffer,
): { openemr: SpacesClient; agent: SpacesClient; key: string } => {
    const stored = new Map<string, Buffer>();
    const key = `${pid}/${documentUuid}.${ext}`;
    stored.set(key, bytes);
    return {
        openemr: buildFakeSpaces(stored, 'openemr'),
        agent: buildFakeSpaces(new Map(), 'agent'),
        key,
    };
};

const stubRasterizer = (pageCount: number): Rasterizer => ({
    pageCount: vi.fn(() => Promise.resolve(pageCount)),
    rasterize: vi.fn(() => {
        const out: { pageNum: number; pngBytes: Buffer }[] = [];
        for (let i = 1; i <= pageCount; i += 1) {
            out.push({ pageNum: i, pngBytes: Buffer.from(`fake-png-page-${i}`) });
        }
        return Promise.resolve(out);
    }),
});

const baseState = (overrides: Partial<PipelineState> = {}): PipelineState => ({
    ...initialPipelineState({
        documentUuid: '11111111-1111-1111-1111-111111111111',
        docType: 'intake_form',
        pid: 42,
        triggerSource: 'panel',
    }),
    ...overrides,
});

const silentLogger = pino({ level: 'silent' });

const buildDeps = (
    openemr: SpacesClient,
    agent: SpacesClient,
    rasterizer: Rasterizer,
    canonicalExt = 'pdf',
    nowOverride?: () => Date,
): RasterizeDeps => ({
    openemrSpaces: openemr,
    agentSpaces: agent,
    rasterizer,
    transientPrefix: 'transient',
    logger: silentLogger,
    canonicalExt,
    ...(nowOverride !== undefined ? { now: nowOverride } : {}),
});

describe('rasterize node — happy paths', () => {
    it('rasterizes a 3-page PDF, uploads each PNG to the transient prefix, and returns signed URLs', async () => {
        const documentUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const pid = 42;
        const pdfBytes = readFixture('intake-forms/p01-chen-intake-typed.pdf');
        const { openemr, agent } = seedCanonical(pid, documentUuid, 'pdf', pdfBytes);
        const rasterizer = stubRasterizer(3);
        const fixedNow = new Date('2026-05-05T12:00:00.000Z');

        const state = baseState({ documentUuid, pid });
        const deps = buildDeps(openemr, agent, rasterizer, 'pdf', () => fixedNow);
        const out = await rasterize(state, deps);

        expect(out.status).toBe('rasterized');
        expect(out.errors).toBeUndefined();
        const pages = requirePages(out);
        expect(pages).toHaveLength(3);
        expect(pages.map((p) => p.pageNum)).toEqual([1, 2, 3]);
        expect(pages.map((p) => p.key)).toEqual([
            `transient/${documentUuid}/page-1.png`,
            `transient/${documentUuid}/page-2.png`,
            `transient/${documentUuid}/page-3.png`,
        ]);
        // Signed URLs go through the agent-side client (read-only on transient prefix).
        for (const page of pages) {
            expect(page.signedUrl).toMatch(/^https:\/\/signed\.test\/agent\//);
            expect(page.expiresAt).toBe(
                new Date(fixedNow.getTime() + SIGNED_URL_TTL_SEC * 1_000).toISOString(),
            );
        }
        expect(openemr.putObject).toHaveBeenCalledTimes(3);
        expect(agent.presignGetUrl).toHaveBeenCalledTimes(3);
        for (const call of (agent.presignGetUrl as ReturnType<typeof vi.fn>).mock.calls) {
            expect(call[1]).toBeLessThanOrEqual(300);
        }
    });

    it('passes a single-page PNG through without re-uploading; signed URL targets the canonical key', async () => {
        const documentUuid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const pid = 7;
        const pngBytes = readFixture('intake-forms/p03-reyes-intake.png');
        const { openemr, agent, key } = seedCanonical(pid, documentUuid, 'png', pngBytes);
        const rasterizer = stubRasterizer(0);
        const state = baseState({ documentUuid, pid, docType: 'intake_form' });

        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer, 'png'));

        expect(out.status).toBe('rasterized');
        const pages = requirePages(out);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.pageNum).toBe(1);
        expect(pages[0]?.key).toBe(key);
        // The image branch must not call the rasterizer or re-upload anything.
        expect(rasterizer.pageCount).not.toHaveBeenCalled();
        expect(rasterizer.rasterize).not.toHaveBeenCalled();
        expect(openemr.putObject).not.toHaveBeenCalled();
    });
});

describe('rasterize node — cost cap', () => {
    it('refuses with cost-cap-exceeded when page count × per-page estimate exceeds the $1.00 cap', async () => {
        const documentUuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        const pid = 12;
        // 500 × $0.005 = $2.50 ⇒ exceeds the $1.00 cap.
        const oversizedPageCount =
            Math.ceil(PER_DOCUMENT_DOLLAR_CAP / ESTIMATED_DOLLARS_PER_PAGE) + 50;
        const { openemr, agent } = seedCanonical(
            pid,
            documentUuid,
            'pdf',
            Buffer.from('synthetic-not-real-pdf-bytes'),
        );
        const rasterizer = stubRasterizer(oversizedPageCount);
        const state = baseState({ documentUuid, pid });
        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer));

        expect(out.status).toBe('failed');
        const errors = requireErrors(out);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.code).toBe('cost-cap-exceeded');
        expect(errors[0]?.details).toMatchObject({
            pageCount: oversizedPageCount,
            cap: PER_DOCUMENT_DOLLAR_CAP,
        });
        // Crucially: rasterize itself never runs (we refuse pre-flight).
        expect(rasterizer.rasterize).not.toHaveBeenCalled();
        expect(openemr.putObject).not.toHaveBeenCalled();
        expect(agent.presignGetUrl).not.toHaveBeenCalled();
    });

    it('does not trip the cap at the boundary — exactly 200 pages stays inside the cap', async () => {
        const documentUuid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
        const pid = 13;
        const boundaryPageCount = Math.floor(PER_DOCUMENT_DOLLAR_CAP / ESTIMATED_DOLLARS_PER_PAGE);
        const { openemr, agent } = seedCanonical(
            pid,
            documentUuid,
            'pdf',
            Buffer.from('synthetic-pdf'),
        );
        const rasterizer = stubRasterizer(boundaryPageCount);
        const state = baseState({ documentUuid, pid });
        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer));

        expect(out.status).toBe('rasterized');
        expect(out.pages).toHaveLength(boundaryPageCount);
    });
});

describe('rasterize node — failure isolation', () => {
    it('returns failed/storage-unreachable when the canonical object cannot be fetched', async () => {
        const documentUuid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
        const pid = 99;
        const openemr = fakeSpacesClient({
            getObject: vi.fn(() => Promise.reject(new Error('Spaces 503'))),
        });
        const agent = fakeSpacesClient();
        const rasterizer = stubRasterizer(2);
        const state = baseState({ documentUuid, pid });
        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer));

        expect(out.status).toBe('failed');
        expect(requireErrors(out)[0]?.code).toBe('storage-unreachable');
    });

    it('returns failed/storage-unreachable when transient upload fails after the page count probe', async () => {
        const documentUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        const pid = 21;
        const { openemr, agent } = seedCanonical(
            pid,
            documentUuid,
            'pdf',
            Buffer.from('synthetic-pdf'),
        );
        // Override putObject after seeding so the canonical fetch still succeeds.
        const putMock = openemr.putObject as ReturnType<typeof vi.fn>;
        putMock.mockRejectedValueOnce(new Error('upload fail'));
        const rasterizer = stubRasterizer(2);
        const state = baseState({ documentUuid, pid });
        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer));

        expect(out.status).toBe('failed');
        expect(requireErrors(out)[0]?.code).toBe('storage-unreachable');
    });

    it('returns failed/rasterize_failed when the rasterizer throws on a structurally invalid PDF', async () => {
        const documentUuid = '99999999-9999-9999-9999-999999999999';
        const pid = 33;
        const { openemr, agent } = seedCanonical(
            pid,
            documentUuid,
            'pdf',
            Buffer.from('not-actually-a-pdf'),
        );
        const rasterizer: Rasterizer = {
            pageCount: vi.fn(() => Promise.reject(new Error('PDF parse error'))),
            rasterize: vi.fn(() => Promise.resolve([])),
        };
        const state = baseState({ documentUuid, pid });
        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer));

        expect(out.status).toBe('failed');
        expect(requireErrors(out)[0]?.code).toBe('rasterize_failed');
    });

    it('refuses unsupported canonical extensions', async () => {
        const documentUuid = '88888888-8888-8888-8888-888888888888';
        const pid = 34;
        const { openemr, agent } = seedCanonical(
            pid,
            documentUuid,
            'docx',
            Buffer.from('not-a-pdf-or-image'),
        );
        const rasterizer = stubRasterizer(0);
        const state = baseState({ documentUuid, pid });
        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer, 'docx'));

        expect(out.status).toBe('failed');
        expect(requireErrors(out)[0]?.code).toBe('rasterize_failed');
        expect(rasterizer.pageCount).not.toHaveBeenCalled();
    });

    it('rejects PDFs reporting zero pages', async () => {
        const documentUuid = '77777777-7777-7777-7777-777777777777';
        const pid = 35;
        const { openemr, agent } = seedCanonical(
            pid,
            documentUuid,
            'pdf',
            Buffer.from('synthetic-pdf'),
        );
        const rasterizer = stubRasterizer(0);
        const state = baseState({ documentUuid, pid });
        const out = await rasterize(state, buildDeps(openemr, agent, rasterizer));

        expect(out.status).toBe('failed');
        expect(requireErrors(out)[0]?.code).toBe('rasterize_failed');
    });
});
