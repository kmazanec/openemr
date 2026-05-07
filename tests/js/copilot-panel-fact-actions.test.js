/**
 * F.5a accept/reject panel helper tests.
 *
 * Coverage:
 *
 *   - `factTypeForClaimCategory` — maps claim.category → factType the
 *     accept_fact route expects, with the documented mismatch on
 *     `diagnosis → past_medical_history` (until the synthesizer
 *     schema gains a family_history slot).
 *   - `docPromotionTargetForClaim` — pulls (artifactId, fieldPath,
 *     factType) off a claim's primary extracted_document source ref,
 *     returning null when the claim has no doc primary or has a
 *     non-promotable category.
 *   - `postAcceptFact` / `postReject` — typed result envelopes with
 *     network/malformed/error code handling, and the happy path.
 *   - `messageForFactActionCode` — known codes resolve to clinician-
 *     facing strings; unknown codes fall back to a generic message.
 *
 * `renderFactActions` and the click-handler / toast / chip-swap
 * surfaces touch the DOM, which isn't available in the node-only Jest
 * environment used by the rest of this suite. Those are exercised by
 * the render-test layer in `tests/Tests/Isolated/Common/Twig/` and by
 * end-to-end behavior; structural invariants of the helper logic are
 * pinned here.
 */

const helpers = require('../../interface/modules/custom_modules/oe-module-clinical-copilot/public/js/panel.js');

const {
    factTypeForClaimCategory,
    docPromotionTargetForClaim,
    postAcceptFact,
    postReject,
    messageForFactActionCode,
} = helpers;

describe('factTypeForClaimCategory', () => {
    test.each([
        ['lab', 'lab'],
        ['allergy', 'allergy'],
        ['medication_statement', 'medication_statement'],
        ['diagnosis', 'past_medical_history'],
    ])('%s → %s', (input, expected) => {
        expect(factTypeForClaimCategory(input)).toBe(expected);
    });

    test.each([
        ['identity'],
        ['appointment'],
        ['encounter'],
        ['prescription'],
        ['prescription_change'],
        ['reminder'],
        [undefined],
        [null],
        [''],
    ])('non-promotable category %s → null', (input) => {
        expect(factTypeForClaimCategory(input)).toBeNull();
    });
});

describe('docPromotionTargetForClaim', () => {
    const labClaim = (overrides = {}) => ({
        id: 'cl-1',
        text: 'HbA1c 5.7 %',
        category: 'lab',
        sourceReferences: [
            {
                source_type: 'extracted_document',
                source_id: 'artifact-7',
                locator: { field: 'results.0', page: 1, bbox: [0, 0, 1, 1] },
                quote: 'HbA1c 5.7 %',
            },
        ],
        safetyCritical: false,
        ...overrides,
    });

    test('happy path — returns artifactId, fieldPath, factType', () => {
        expect(docPromotionTargetForClaim(labClaim())).toEqual({
            artifactId: 'artifact-7',
            fieldPath: 'results.0',
            factType: 'lab',
        });
    });

    test('null when claim has no extracted_document primary', () => {
        const claim = labClaim({
            sourceReferences: [
                { source_type: 'chart', source_id: 'rx-1', locator: { field: 'medication.name' }, quote: '' },
            ],
        });
        expect(docPromotionTargetForClaim(claim)).toBeNull();
    });

    test('null when category is not promotable', () => {
        const claim = labClaim({ category: 'reminder' });
        expect(docPromotionTargetForClaim(claim)).toBeNull();
    });

    test('null when source_id is empty', () => {
        const claim = labClaim();
        claim.sourceReferences[0].source_id = '';
        expect(docPromotionTargetForClaim(claim)).toBeNull();
    });

    test('null when locator.field is missing', () => {
        const claim = labClaim();
        claim.sourceReferences[0].locator = {};
        expect(docPromotionTargetForClaim(claim)).toBeNull();
    });

    test('null when claim is null/undefined', () => {
        expect(docPromotionTargetForClaim(null)).toBeNull();
        expect(docPromotionTargetForClaim(undefined)).toBeNull();
    });
});

describe('postAcceptFact', () => {
    test('happy path — returns ok=true with parsed body', async () => {
        const fetchFn = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        chartRecordUuid: 'chart-1',
                        idempotentHit: false,
                    }),
            }),
        );
        const result = await postAcceptFact({
            fetchFn,
            url: '/agent.php?action=accept_fact',
            body: { artifactId: 'a', fieldPath: 'b', factType: 'lab' },
        });
        expect(result.ok).toBe(true);
        expect(result.body.chartRecordUuid).toBe('chart-1');
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const callArgs = fetchFn.mock.calls[0];
        expect(callArgs[1].method).toBe('POST');
        expect(callArgs[1].credentials).toBe('same-origin');
        expect(JSON.parse(callArgs[1].body)).toEqual({
            artifactId: 'a',
            fieldPath: 'b',
            factType: 'lab',
        });
    });

    test('non-2xx with typed error code → ok=false with code', async () => {
        const fetchFn = jest.fn(() =>
            Promise.resolve({
                ok: false,
                status: 501,
                json: () => Promise.resolve({ error: 'not_yet_implemented' }),
            }),
        );
        const result = await postAcceptFact({
            fetchFn,
            url: '/agent.php?action=accept_fact',
            body: {},
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('not_yet_implemented');
        expect(result.status).toBe(501);
    });

    test('network failure → ok=false with code=network_error', async () => {
        const fetchFn = jest.fn(() => Promise.reject(new Error('boom')));
        const result = await postAcceptFact({
            fetchFn,
            url: '/agent.php?action=accept_fact',
            body: {},
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('network_error');
    });

    test('malformed JSON → ok=false with code=malformed_response', async () => {
        const fetchFn = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.reject(new Error('parse failure')),
            }),
        );
        const result = await postAcceptFact({
            fetchFn,
            url: '/agent.php?action=accept_fact',
            body: {},
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('malformed_response');
    });
});

describe('postReject', () => {
    test('happy path', async () => {
        const fetchFn = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        disposition: { status: 'rejected' },
                    }),
            }),
        );
        const result = await postReject({
            fetchFn,
            url: '/agent.php?action=dispositions',
            body: { artifactId: 'a', fieldPath: 'b', status: 'rejected' },
        });
        expect(result.ok).toBe(true);
        expect(result.body.disposition.status).toBe('rejected');
    });

    test('non-2xx → typed error code', async () => {
        const fetchFn = jest.fn(() =>
            Promise.resolve({
                ok: false,
                status: 503,
                json: () => Promise.resolve({ error: 'dispositions_unavailable' }),
            }),
        );
        const result = await postReject({
            fetchFn,
            url: '/agent.php?action=dispositions',
            body: {},
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('dispositions_unavailable');
    });
});

describe('messageForFactActionCode', () => {
    test.each([
        ['not_yet_implemented'],
        ['promote_failed'],
        ['network_error'],
        ['unknown'],
    ])('returns a non-empty message for known code %s', (code) => {
        const msg = messageForFactActionCode(code);
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(0);
    });

    test('falls back to generic for unrecognized code', () => {
        expect(messageForFactActionCode('totally_made_up')).toBe(
            messageForFactActionCode('unknown'),
        );
    });
});
