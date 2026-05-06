/**
 * §D.1 Jest tests for the Clinical Co-Pilot panel's document-upload
 * helpers. The panel runs as a plain `<script>` in the browser; the
 * helpers under test are exposed via the UMD-style `module.exports`
 * guard at the bottom of `panel.js` so node can require them without
 * a DOM.
 *
 * Coverage:
 *
 *   - `validateUploadShape` — size cap, allowed MIME set, missing-file.
 *   - `documentUploadUrl` — falls back to a sibling-path URL when the
 *     proxy URL is unavailable in the test environment (the IIFE
 *     captures `proxyUrl` at load time; under CommonJS it stays null).
 *   - `runUpload` — happy-path returns `{ok: true, documentUuid,
 *     docType}`; 4xx → `{ok: false, code: 'file_too_large'}`; transport
 *     failure → `{ok: false, code: 'upload_unavailable'}`; malformed
 *     2xx body → `{ok: false, code: 'upload_unavailable'}`.
 *   - `messageForUploadCode` / `messageForPipelineCode` — typed
 *     human-readable mapping covering all D.1-checklist codes plus an
 *     unknown-code fallback.
 *   - `PIPELINE_STATUS_TEXT` — the contract the SSE handler dispatches
 *     against; pin every documented stage so a typo in the panel's
 *     switch statement fails this test rather than the deployed app.
 */

const helpers = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

const {
    validateUploadShape,
    documentUploadUrl,
    extractEndpointUrl,
    runUpload,
    messageForUploadCode,
    messageForPipelineCode,
    PIPELINE_STATUS_TEXT,
    MAX_UPLOAD_BYTES,
    ALLOWED_UPLOAD_MIMES,
} = helpers;

const fakeFile = (overrides = {}) => ({
    name: 'cdc-cbc-2026-05-01.pdf',
    size: 1024,
    type: 'application/pdf',
    ...overrides,
});

describe('validateUploadShape — pre-network gate', () => {
    test('returns null for a valid PDF', () => {
        expect(validateUploadShape(fakeFile())).toBeNull();
    });

    test('accepts each MIME from the allowlist', () => {
        for (const mime of ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff']) {
            expect(validateUploadShape(fakeFile({ type: mime }))).toBeNull();
        }
    });

    test('refuses unsupported MIME with a typed code', () => {
        expect(validateUploadShape(fakeFile({ type: 'application/x-msdownload' })))
            .toBe('unsupported_media_type');
    });

    test('refuses files over the 10 MB cap', () => {
        expect(validateUploadShape(fakeFile({ size: MAX_UPLOAD_BYTES + 1 })))
            .toBe('file_too_large');
    });

    test('accepts a file exactly at the cap', () => {
        expect(validateUploadShape(fakeFile({ size: MAX_UPLOAD_BYTES }))).toBeNull();
    });

    test('refuses a missing file', () => {
        expect(validateUploadShape(null)).toBe('missing_file');
        expect(validateUploadShape(undefined)).toBe('missing_file');
    });

    test('exposes the allowlist as a Set so a future MIME addition is one entry', () => {
        expect(ALLOWED_UPLOAD_MIMES instanceof Set).toBe(true);
        expect(ALLOWED_UPLOAD_MIMES.size).toBe(4);
    });
});

describe('documentUploadUrl + extractEndpointUrl — sibling paths under the proxy', () => {
    test('documentUploadUrl falls back to a relative path when the proxy URL is null', () => {
        // Under the CommonJS test env there is no DOM root, so the IIFE
        // never assigns proxyUrl — the helper degrades to the
        // /document_upload.php fallback. This is what we want for
        // unit-test coverage; the in-browser path is exercised by
        // the Twig render test pinning the data-proxy-url attribute.
        expect(documentUploadUrl()).toBe('/document_upload.php');
    });

    test('extractEndpointUrl falls back to /extract.php when proxy URL is null', () => {
        // The B.8 trigger endpoint lives alongside agent.php and
        // document_upload.php. Same fallback shape so the panel never
        // posts to a stale URL when the data-proxy-url attribute is
        // missing.
        expect(extractEndpointUrl()).toBe('/extract.php');
    });
});

describe('runUpload — multipart round-trip with mocked fetch', () => {
    const happyResponse = () => ({
        ok: true,
        json: jest.fn().mockResolvedValue({
            document_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            doc_type_guess: 'lab_pdf',
            spaces_url: 's3://test-bucket/4242/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf',
            canonical_ext: 'pdf',
        }),
    });

    test('happy path returns ok=true with documentUuid + docType + canonicalExt', async () => {
        const fetchFn = jest.fn().mockResolvedValue(happyResponse());
        const result = await runUpload({
            fetchFn,
            url: '/upload',
            file: fakeFile(),
        });
        expect(result).toEqual({
            ok: true,
            documentUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            docType: 'lab_pdf',
            // canonical_ext flows from the upload response into the
            // extract.php envelope (B.8's `/v1/agent/extract` validates
            // it). Pinning it here keeps the wire-format contract
            // explicit between D.1's controller and the panel's caller.
            canonicalExt: 'pdf',
        });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [calledUrl, options] = fetchFn.mock.calls[0];
        expect(calledUrl).toBe('/upload');
        expect(options.method).toBe('POST');
        expect(options.credentials).toBe('same-origin');
        expect(options.body).toBeInstanceOf(FormData);
    });

    test('200 missing canonical_ext collapses to upload_unavailable', async () => {
        // Defensive: the controller always returns canonical_ext, but
        // an older deploy or a proxy stripping fields shouldn't surface
        // a truthy `ok` with an undefined `canonicalExt` to downstream
        // callers. Refuse loudly instead.
        const fetchFn = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                document_uuid: 'uuid-1',
                doc_type_guess: 'lab_pdf',
                // canonical_ext deliberately omitted
            }),
        });
        const result = await runUpload({ fetchFn, url: '/upload', file: fakeFile() });
        expect(result).toEqual({ ok: false, code: 'upload_unavailable' });
    });

    test('413 file_too_large surfaces typed code', async () => {
        const fetchFn = jest.fn().mockResolvedValue({
            ok: false,
            status: 413,
            json: jest.fn().mockResolvedValue({ error: 'file_too_large' }),
        });
        const result = await runUpload({ fetchFn, url: '/upload', file: fakeFile() });
        expect(result).toEqual({ ok: false, code: 'file_too_large' });
    });

    test('415 unsupported_media_type surfaces typed code', async () => {
        const fetchFn = jest.fn().mockResolvedValue({
            ok: false,
            status: 415,
            json: jest.fn().mockResolvedValue({ error: 'unsupported_media_type' }),
        });
        const result = await runUpload({ fetchFn, url: '/upload', file: fakeFile() });
        expect(result).toEqual({ ok: false, code: 'unsupported_media_type' });
    });

    test('503 with no body collapses to upload_unavailable', async () => {
        const fetchFn = jest.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: jest.fn().mockRejectedValue(new Error('not json')),
        });
        const result = await runUpload({ fetchFn, url: '/upload', file: fakeFile() });
        expect(result).toEqual({ ok: false, code: 'upload_unavailable' });
    });

    test('200 with malformed body collapses to upload_unavailable', async () => {
        const fetchFn = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ unexpected: 'shape' }),
        });
        const result = await runUpload({ fetchFn, url: '/upload', file: fakeFile() });
        expect(result).toEqual({ ok: false, code: 'upload_unavailable' });
    });

    test('transport failure surfaces upload_unavailable', async () => {
        // Silence the expected `console.error` from the production code
        // path so the test output stays clean. The console call itself
        // is part of the contract (we want the breadcrumb in the
        // browser); we just don't need to see it in the suite output.
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const fetchFn = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
            const result = await runUpload({ fetchFn, url: '/upload', file: fakeFile() });
            expect(result).toEqual({ ok: false, code: 'upload_unavailable' });
            expect(errorSpy).toHaveBeenCalledWith(
                'copilot: upload transport failed',
                expect.any(TypeError),
            );
        } finally {
            errorSpy.mockRestore();
        }
    });
});

describe('messageForUploadCode — typed human-readable mapping', () => {
    test('every documented upload code maps to a non-empty message', () => {
        const codes = [
            'file_too_large',
            'unsupported_media_type',
            'missing_pid',
            'missing_file',
            'upload_unavailable',
            'acl_denied',
        ];
        for (const code of codes) {
            const msg = messageForUploadCode(code);
            expect(typeof msg).toBe('string');
            expect(msg.length).toBeGreaterThan(0);
        }
    });

    test('unknown code falls through to the generic upload_unavailable text', () => {
        const generic = messageForUploadCode('upload_unavailable');
        expect(messageForUploadCode('something-the-server-invented')).toBe(generic);
    });

    test('size-cap message references the 10 MB limit', () => {
        expect(messageForUploadCode('file_too_large')).toMatch(/10 MB/);
    });
});

describe('messageForPipelineCode — typed pipeline.error mapping', () => {
    test('cost-cap-exceeded surfaces "Document too large…"', () => {
        expect(messageForPipelineCode('cost-cap-exceeded')).toMatch(/Document too large/);
    });

    test('patient_mismatch surfaces "does not appear to belong to this patient"', () => {
        expect(messageForPipelineCode('patient_mismatch'))
            .toMatch(/does not appear to belong to this patient/);
    });

    test('schema_invalid surfaces "Could not extract structured data"', () => {
        expect(messageForPipelineCode('schema_invalid'))
            .toMatch(/Could not extract structured data/);
    });

    test('every PipelineErrorCode from agent/src/pipeline/state.ts has an explicit message', () => {
        // Pin every code emitted by B.8's pipeline route. Any new code
        // added on the agent side without a matching entry here would
        // fall through to the generic pipeline_failed text — possibly
        // fine, but force the choice via a failing test rather than a
        // silent coverage gap.
        const codes = [
            'cost-cap-exceeded',
            'rasterize_failed',
            'storage-unreachable',
            'rate-limited',
            'schema_invalid',
            'patient_mismatch',
            'persist_failed',
        ];
        const generic = messageForPipelineCode('pipeline_failed');
        for (const code of codes) {
            const msg = messageForPipelineCode(code);
            expect(typeof msg).toBe('string');
            expect(msg.length).toBeGreaterThan(0);
            expect(msg).not.toBe(generic);
        }
    });

    test('unknown pipeline code falls through to the generic pipeline_failed text', () => {
        const generic = messageForPipelineCode('pipeline_failed');
        expect(messageForPipelineCode('mystery-code')).toBe(generic);
    });
});

describe('PIPELINE_STATUS_TEXT — SSE-frame status-line contract', () => {
    test('start frame says "Extracting document…"', () => {
        expect(PIPELINE_STATUS_TEXT['pipeline.start']).toBe('Extracting document…');
    });

    test('vision.complete pivots to "drafting briefing…"', () => {
        expect(PIPELINE_STATUS_TEXT['pipeline.vision.complete'])
            .toBe('Document evidence available, drafting briefing…');
    });

    test('every key in the map is a documented stage', () => {
        const expectedKeys = new Set([
            'pipeline.start',
            'pipeline.rasterize.complete',
            'pipeline.vision.complete',
            'pipeline.persist.complete',
        ]);
        const actualKeys = new Set(Object.keys(PIPELINE_STATUS_TEXT));
        expect(actualKeys).toEqual(expectedKeys);
    });
});
