import { Readable } from 'node:stream';

import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { parseSpacesEnv } from '../../src/config/spacesEnv.js';
import {
    type SpacesClient,
    createAgentSpacesClient,
    createOpenEmrSpacesClient,
    createSpacesClient,
    keyForCanonical,
    keyForTransientPage,
} from '../../src/storage/spaces.js';

interface FakeS3Client {
    readonly send: ReturnType<typeof vi.fn>;
    readonly destroy: () => void;
}

const fakeS3 = (sendImpl: (cmd: unknown) => unknown = () => ({})): FakeS3Client => ({
    send: vi.fn(sendImpl),
    destroy: vi.fn(),
});

const validEnv = (): Record<string, string> => ({
    SPACES_BUCKET: 'cdn.biograph.dev',
    SPACES_REGION: 'nyc3',
    SPACES_OPENEMR_KEY: 'oe-key',
    SPACES_OPENEMR_SECRET: 'oe-secret',
    SPACES_AGENT_KEY: 'agent-key',
    SPACES_AGENT_SECRET: 'agent-secret',
    SPACES_TRANSIENT_PREFIX: 'transient',
});

const buildClient = (
    s3: FakeS3Client,
    presignFn: (cmd: unknown, opts: { expiresIn: number }) => Promise<string> = () =>
        Promise.resolve('https://signed.example/url'),
): SpacesClient =>
    createSpacesClient({
        bucket: 'cdn.biograph.dev',
        s3Client: s3 as unknown as S3Client,
        presign: presignFn,
    });

describe('keyForCanonical', () => {
    it('shapes the canonical key as <pid>/<documentUuid>.<ext>', () => {
        const key = keyForCanonical(42, '11111111-1111-1111-1111-111111111111', 'pdf');
        expect(key).toBe('42/11111111-1111-1111-1111-111111111111.pdf');
    });

    it('strips a leading dot from the extension if a caller passes one', () => {
        const key = keyForCanonical(7, 'doc-uuid', '.png');
        expect(key).toBe('7/doc-uuid.png');
    });

    it('rejects empty extensions — every canonical object has a meaningful suffix', () => {
        expect(() => keyForCanonical(7, 'doc-uuid', '')).toThrow(/extension/i);
    });

    it('rejects non-positive pids — chart ids are 1-based', () => {
        expect(() => keyForCanonical(0, 'doc-uuid', 'pdf')).toThrow(/pid/);
        expect(() => keyForCanonical(-1, 'doc-uuid', 'pdf')).toThrow(/pid/);
    });
});

describe('keyForTransientPage', () => {
    it('shapes the transient key as <prefix>/<documentUuid>/page-<n>.png', () => {
        const key = keyForTransientPage(
            'transient',
            '22222222-2222-2222-2222-222222222222',
            3,
        );
        expect(key).toBe('transient/22222222-2222-2222-2222-222222222222/page-3.png');
    });

    it('zero-pads is not applied — page numbers go raw so the lifecycle policy can match prefixes literally', () => {
        const key = keyForTransientPage('transient', 'd', 17);
        expect(key).toBe('transient/d/page-17.png');
    });

    it('rejects non-positive page numbers — pages are 1-based', () => {
        expect(() => keyForTransientPage('transient', 'd', 0)).toThrow(/page/);
    });
});

describe('createSpacesClient — putObject', () => {
    it('issues a PutObjectCommand with the bucket, key, body, and content-type', async () => {
        const s3 = fakeS3();
        const client = buildClient(s3);
        const body = Buffer.from('hello');
        await client.putObject({ key: 'p/x.png', body, contentType: 'image/png' });
        expect(s3.send).toHaveBeenCalledTimes(1);
        const cmd = s3.send.mock.calls[0]?.[0] as PutObjectCommand;
        expect(cmd).toBeInstanceOf(PutObjectCommand);
        expect(cmd.input.Bucket).toBe('cdn.biograph.dev');
        expect(cmd.input.Key).toBe('p/x.png');
        expect(cmd.input.Body).toBe(body);
        expect(cmd.input.ContentType).toBe('image/png');
    });
});

describe('createSpacesClient — getObject', () => {
    it('returns a Buffer assembled from the object body stream', async () => {
        const stream = Readable.from([Buffer.from('hel'), Buffer.from('lo')]);
        const s3 = fakeS3(() => ({ Body: stream, ContentType: 'application/pdf' }));
        const client = buildClient(s3);
        const result = await client.getObject({ key: 'p/y.pdf' });
        expect(result.body.toString('utf8')).toBe('hello');
        expect(result.contentType).toBe('application/pdf');
    });

    it('throws when the SDK response has no Body — Spaces is not behaving like S3', async () => {
        const s3 = fakeS3(() => ({ Body: undefined }));
        const client = buildClient(s3);
        await expect(client.getObject({ key: 'p/y.pdf' })).rejects.toThrow(/empty body/i);
    });
});

describe('createSpacesClient — deleteObject', () => {
    it('issues a DeleteObjectCommand with the bucket + key', async () => {
        const s3 = fakeS3();
        const client = buildClient(s3);
        await client.deleteObject({ key: 'transient/u/page-1.png' });
        const cmd = s3.send.mock.calls[0]?.[0] as DeleteObjectCommand;
        expect(cmd).toBeInstanceOf(DeleteObjectCommand);
        expect(cmd.input.Key).toBe('transient/u/page-1.png');
    });
});

describe('createSpacesClient — presignGetUrl', () => {
    it('passes a GetObjectCommand and the TTL to the signer', async () => {
        const s3 = fakeS3();
        const presign = vi.fn(() => Promise.resolve('https://signed.example/get'));
        const client = buildClient(s3, presign);
        const url = await client.presignGetUrl('p/y.pdf', 300);
        expect(url).toBe('https://signed.example/get');
        expect(presign).toHaveBeenCalledTimes(1);
        const [cmd, opts] = presign.mock.calls[0] as unknown as [
            GetObjectCommand,
            { expiresIn: number },
        ];
        expect(cmd).toBeInstanceOf(GetObjectCommand);
        expect(cmd.input.Key).toBe('p/y.pdf');
        expect(opts.expiresIn).toBe(300);
    });

    it('rejects a TTL > 5 minutes — vision payloads must be short-TTL per W2-4', async () => {
        const client = buildClient(fakeS3());
        await expect(client.presignGetUrl('p/y.pdf', 301)).rejects.toThrow(/300/);
    });

    it('rejects a non-positive TTL', async () => {
        const client = buildClient(fakeS3());
        await expect(client.presignGetUrl('p/y.pdf', 0)).rejects.toThrow(/ttl/i);
        await expect(client.presignGetUrl('p/y.pdf', -1)).rejects.toThrow(/ttl/i);
    });
});

describe('createSpacesClient — presignPutUrl', () => {
    it('passes a PutObjectCommand and the TTL to the signer', async () => {
        const presign = vi.fn(() => Promise.resolve('https://signed.example/put'));
        const client = buildClient(fakeS3(), presign);
        const url = await client.presignPutUrl('p/y.pdf', 60, { contentType: 'application/pdf' });
        expect(url).toBe('https://signed.example/put');
        const [cmd, opts] = presign.mock.calls[0] as unknown as [
            PutObjectCommand,
            { expiresIn: number },
        ];
        expect(cmd).toBeInstanceOf(PutObjectCommand);
        expect(cmd.input.Key).toBe('p/y.pdf');
        expect(cmd.input.ContentType).toBe('application/pdf');
        expect(opts.expiresIn).toBe(60);
    });

    it('rejects a TTL > 5 minutes', async () => {
        const client = buildClient(fakeS3());
        await expect(client.presignPutUrl('p/y.pdf', 600)).rejects.toThrow(/300/);
    });
});

describe('createOpenEmrSpacesClient + createAgentSpacesClient — IAM identities', () => {
    it('builds an OpenEMR client using the openemr credentials', () => {
        const env = parseSpacesEnv(validEnv());
        const built = createOpenEmrSpacesClient(env);
        expect(built.bucket).toBe('cdn.biograph.dev');
        // Underlying SDK identity is not exposed; the smoke check is
        // that the wrapper is constructed and its bucket matches env.
        built.destroy();
    });

    it('builds an agent (read-only) client whose write methods are disabled', async () => {
        const env = parseSpacesEnv(validEnv());
        const built = createAgentSpacesClient(env);
        await expect(
            built.putObject({ key: 'k', body: Buffer.alloc(0), contentType: 'image/png' }),
        ).rejects.toThrow(/read-only/i);
        await expect(built.deleteObject({ key: 'k' })).rejects.toThrow(/read-only/i);
        await expect(built.presignPutUrl('k', 60)).rejects.toThrow(/read-only/i);
        built.destroy();
    });

    it('agent client can presign GETs (its single capability)', async () => {
        const env = parseSpacesEnv(validEnv());
        const built = createAgentSpacesClient(env);
        // We only verify the method exists and rejects bad TTLs (the
        // signature check is the same code path the unit tests above
        // already cover).
        await expect(built.presignGetUrl('k', 0)).rejects.toThrow();
        built.destroy();
    });
});

describe('Spaces integration round-trip (skipped without credentials)', () => {
    const hasCreds =
        typeof process.env['SPACES_BUCKET'] === 'string' &&
        process.env['SPACES_BUCKET'].length > 0;
    const t = hasCreds ? it : it.skip;
    t('round-trips a small object through real Spaces', async () => {
        const env = parseSpacesEnv(process.env);
        const oeClient = createOpenEmrSpacesClient(env);
        const key = `tests/integration/${Date.now()}-roundtrip.txt`;
        try {
            await oeClient.putObject({
                key,
                body: Buffer.from('roundtrip'),
                contentType: 'text/plain',
            });
            const got = await oeClient.getObject({ key });
            expect(got.body.toString('utf8')).toBe('roundtrip');
        } finally {
            await oeClient.deleteObject({ key }).catch(() => undefined);
            oeClient.destroy();
        }
    });
});
