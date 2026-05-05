import { Readable } from 'node:stream';

import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { type SpacesEnv } from '../config/spacesEnv.js';

/**
 * §B.2 DigitalOcean Spaces client wrapper.
 *
 * Two IAM identities are constructed at boot:
 *
 *   - **OpenEMR-side** (`createOpenEmrSpacesClient`): full read+write on
 *     the bucket. Used by the OpenEMR PHP side (when it needs to write
 *     canonical document bytes from a panel upload), and by the agent's
 *     pipeline when running locally / in tests where the OpenEMR-side
 *     route is not yet wired. Expected IAM policy:
 *
 *         { "Effect": "Allow",
 *           "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
 *           "Resource": "arn:aws:s3:::<bucket>/*" }
 *
 *   - **Agent-side** (`createAgentSpacesClient`): read-only on the
 *     transient prefix. The agent uses this identity to mint short-TTL
 *     signed-GET URLs for the vision call's image inputs. The agent
 *     never writes canonical document bytes. Expected IAM policy:
 *
 *         { "Effect": "Allow",
 *           "Action": ["s3:GetObject"],
 *           "Resource": "arn:aws:s3:::<bucket>/<transient-prefix>/*" }
 *
 * The wrapper enforces the read-only contract locally as defense in
 * depth: even if the IAM key is misconfigured at the cloud side, the
 * agent client refuses `putObject`, `deleteObject`, and `presignPutUrl`
 * before they ever hit the wire.
 *
 * TTL ceiling: signed URLs are capped at 5 minutes per `WEEK2-PRESEARCH.md`
 * §W2-4 (single-call, ≤5 min). The cap is enforced in `presignGetUrl`
 * and `presignPutUrl`.
 */

export const MAX_PRESIGN_TTL_SEC = 300;

export interface PutObjectInput {
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
}

export interface GetObjectResult {
    readonly body: Buffer;
    readonly contentType: string | null;
}

export interface SpacesClient {
    readonly bucket: string;
    readonly putObject: (input: PutObjectInput) => Promise<void>;
    readonly getObject: (input: { readonly key: string }) => Promise<GetObjectResult>;
    readonly deleteObject: (input: { readonly key: string }) => Promise<void>;
    readonly presignGetUrl: (key: string, ttlSec: number) => Promise<string>;
    readonly presignPutUrl: (
        key: string,
        ttlSec: number,
        options?: { readonly contentType?: string },
    ) => Promise<string>;
    readonly destroy: () => void;
}

export interface CreateSpacesClientOptions {
    readonly bucket: string;
    readonly s3Client: S3Client;
    /** Injectable signer — production calls `getSignedUrl` from the AWS SDK. */
    readonly presign?: (
        cmd: GetObjectCommand | PutObjectCommand,
        options: { readonly expiresIn: number },
    ) => Promise<string>;
}

const assertPresignTtl = (ttlSec: number): void => {
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
        throw new Error(`signed-URL TTL must be > 0 seconds (got ${ttlSec})`);
    }
    if (ttlSec > MAX_PRESIGN_TTL_SEC) {
        throw new Error(
            `signed-URL TTL must be ≤ ${MAX_PRESIGN_TTL_SEC} seconds (got ${ttlSec})`,
        );
    }
};

const streamToBuffer = async (body: unknown): Promise<Buffer> => {
    if (body === undefined || body === null) {
        throw new Error('Spaces getObject returned an empty body');
    }
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
        const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> })
            .transformToByteArray();
        return Buffer.from(bytes);
    }
    if (body instanceof Readable || typeof (body as Readable).pipe === 'function') {
        const stream = body as Readable;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        return Buffer.concat(chunks);
    }
    throw new Error('Spaces getObject returned an unsupported body type');
};

export const createSpacesClient = (opts: CreateSpacesClientOptions): SpacesClient => {
    const { bucket, s3Client } = opts;
    const presign =
        opts.presign ??
        ((cmd: GetObjectCommand | PutObjectCommand, o: { readonly expiresIn: number }) =>
            // The SDK's `getSignedUrl` expects an `S3Client`; the cmd is
            // either GetObjectCommand or PutObjectCommand which both
            // accept the same signer signature.
            getSignedUrl(s3Client, cmd, { expiresIn: o.expiresIn }));

    const client: SpacesClient = {
        bucket,
        putObject: async ({ key, body, contentType }: PutObjectInput): Promise<void> => {
            await s3Client.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: body,
                    ContentType: contentType,
                }),
            );
        },
        getObject: async ({ key }: { readonly key: string }): Promise<GetObjectResult> => {
            const out = await s3Client.send(
                new GetObjectCommand({ Bucket: bucket, Key: key }),
            );
            const buf = await streamToBuffer((out as { Body?: unknown }).Body);
            const contentType = (out as { ContentType?: string }).ContentType ?? null;
            return { body: buf, contentType };
        },
        deleteObject: async ({ key }: { readonly key: string }): Promise<void> => {
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },
        presignGetUrl: async (key: string, ttlSec: number): Promise<string> => {
            assertPresignTtl(ttlSec);
            const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
            return presign(cmd, { expiresIn: ttlSec });
        },
        presignPutUrl: async (
            key: string,
            ttlSec: number,
            options?: { readonly contentType?: string },
        ): Promise<string> => {
            assertPresignTtl(ttlSec);
            const cmd = new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                ...(options?.contentType !== undefined
                    ? { ContentType: options.contentType }
                    : {}),
            });
            return presign(cmd, { expiresIn: ttlSec });
        },
        destroy: (): void => {
            s3Client.destroy();
        },
    };
    return Object.freeze(client);
};

const buildS3Client = (env: SpacesEnv, role: 'openemr' | 'agent'): S3Client => {
    const creds = role === 'openemr' ? env.openemr : env.agent;
    return new S3Client({
        region: env.region,
        endpoint: env.endpoint,
        forcePathStyle: false,
        credentials: {
            accessKeyId: creds.accessKey,
            secretAccessKey: creds.secretKey,
        },
    });
};

export const createOpenEmrSpacesClient = (env: SpacesEnv): SpacesClient =>
    createSpacesClient({ bucket: env.bucket, s3Client: buildS3Client(env, 'openemr') });

const readOnlyError = (op: string): Error =>
    new Error(`agent Spaces client is read-only; ${op} is not permitted`);

export const createAgentSpacesClient = (env: SpacesEnv): SpacesClient => {
    const inner = createSpacesClient({
        bucket: env.bucket,
        s3Client: buildS3Client(env, 'agent'),
    });
    const readonly: SpacesClient = {
        bucket: inner.bucket,
        getObject: inner.getObject,
        presignGetUrl: inner.presignGetUrl,
        putObject: (): Promise<void> => Promise.reject(readOnlyError('putObject')),
        deleteObject: (): Promise<void> => Promise.reject(readOnlyError('deleteObject')),
        presignPutUrl: (): Promise<string> => Promise.reject(readOnlyError('presignPutUrl')),
        destroy: inner.destroy,
    };
    return Object.freeze(readonly);
};

export const keyForCanonical = (pid: number, documentUuid: string, ext: string): string => {
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`pid must be a positive integer (got ${pid})`);
    }
    const trimmed = ext.replace(/^\.+/, '').trim();
    if (trimmed.length === 0) {
        throw new Error('extension must be non-empty');
    }
    return `${pid}/${documentUuid}.${trimmed}`;
};

export const keyForTransientPage = (
    transientPrefix: string,
    documentUuid: string,
    pageNum: number,
): string => {
    if (!Number.isInteger(pageNum) || pageNum <= 0) {
        throw new Error(`page number must be a positive integer (got ${pageNum})`);
    }
    return `${transientPrefix}/${documentUuid}/page-${pageNum}.png`;
};
