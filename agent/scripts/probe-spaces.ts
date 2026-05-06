/**
 * One-off diagnostic: prove the Spaces PUT actually lands and the
 * presigned GET actually works against the same key. Boots the same
 * `createOpenEmrSpacesClient` / `createAgentSpacesClient` factories
 * the pipeline uses, so any divergence between PUT and GET would
 * show up here too.
 *
 * Usage (inside the agent container):
 *     docker compose exec agent npx tsx scripts/probe-spaces.ts
 */
import { parseSpacesEnv } from '../src/config/spacesEnv.js';
import {
    createAgentSpacesClient,
    createOpenEmrSpacesClient,
    keyForTransientPage,
} from '../src/storage/spaces.js';

const main = async (): Promise<void> => {
    const env = parseSpacesEnv();
    console.log('env:', {
        bucket: env.bucket,
        region: env.region,
        endpoint: env.endpoint,
        transientPrefix: env.transientPrefix,
    });

    const openemr = createOpenEmrSpacesClient(env);
    const agent = createAgentSpacesClient(env);

    const documentUuid = `probe-${Date.now()}`;
    const key = keyForTransientPage(env.transientPrefix, documentUuid, 1);
    console.log('key:', key);

    const tinyPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=',
        'base64',
    );

    console.log('PUT...');
    await openemr.putObject({ key, body: tinyPng, contentType: 'image/png' });
    console.log('PUT ok');

    console.log('GET via openemr client...');
    const got = await openemr.getObject({ key });
    console.log('GET ok, contentType=', got.contentType, 'bytes=', got.body.length);

    console.log('presign via agent client...');
    const url = await agent.presignGetUrl(key, 300);
    console.log('signed URL:', url);

    console.log('fetch signed URL...');
    const res = await fetch(url);
    console.log('status=', res.status, 'content-type=', res.headers.get('content-type'));
    if (!res.ok) {
        console.log('body:', await res.text());
    } else {
        const buf = Buffer.from(await res.arrayBuffer());
        console.log('bytes=', buf.length, 'matches=', buf.equals(tinyPng));
    }

    console.log('cleanup...');
    await openemr.deleteObject({ key });
    console.log('done');

    openemr.destroy();
    agent.destroy();
};

main().catch((err) => {
    console.error('probe failed:', err);
    process.exit(1);
});
