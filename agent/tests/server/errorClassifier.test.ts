import {
    APIConnectionError,
    APIConnectionTimeoutError,
    AuthenticationError,
    BadRequestError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
} from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { classifyBriefingError } from '../../src/server/errorClassifier.js';
import { SnapshotHttpError, SnapshotNetworkError } from '../../src/tools/snapshotClient.js';

const fakeAnthropic = (
    Cls: new (...args: never[]) => Error,
    status: number,
): Error => {
    // The SDK's error constructors take many positional arguments; for
    // classifier behavior we only care about the prototype chain. Build the
    // instance via Object.create so we don't depend on the SDK's internal
    // signature, which has shifted across versions.
    const proto: object = Cls.prototype as object;
    const err = Object.create(proto) as Error & { status?: number };
    err.message = `simulated ${Cls.name}`;
    err.status = status;
    return err;
};

describe('classifyBriefingError', () => {
    it('maps a 400 BadRequestError (e.g. billing) to model_unavailable', () => {
        // The actual case we hit in the wild — Anthropic returns 400 for
        // billing-related rejections, not 402. The user shouldn't see
        // "billing"; "AI service unavailable" is the right level of detail.
        expect(classifyBriefingError(fakeAnthropic(BadRequestError, 400))).toBe(
            'model_unavailable',
        );
    });

    it('maps a 401 AuthenticationError to model_unavailable', () => {
        expect(classifyBriefingError(fakeAnthropic(AuthenticationError, 401))).toBe(
            'model_unavailable',
        );
    });

    it('maps a 403 PermissionDeniedError to model_unavailable', () => {
        expect(classifyBriefingError(fakeAnthropic(PermissionDeniedError, 403))).toBe(
            'model_unavailable',
        );
    });

    it('maps a 500 InternalServerError to model_unavailable', () => {
        expect(classifyBriefingError(fakeAnthropic(InternalServerError, 500))).toBe(
            'model_unavailable',
        );
    });

    it('maps APIConnectionError (and its subclass timeout) to model_unavailable', () => {
        expect(classifyBriefingError(fakeAnthropic(APIConnectionError, 0))).toBe(
            'model_unavailable',
        );
        expect(classifyBriefingError(fakeAnthropic(APIConnectionTimeoutError, 0))).toBe(
            'model_unavailable',
        );
    });

    it('maps a 429 RateLimitError to model_rate_limited (its own bucket)', () => {
        // Rate-limit gets its own code so the UI message can suggest "try
        // again in a moment" instead of the generic "unavailable".
        expect(classifyBriefingError(fakeAnthropic(RateLimitError, 429))).toBe(
            'model_rate_limited',
        );
    });

    it('maps a SnapshotHttpError to chart_unavailable', () => {
        // Distinct from model failure — the operator action differs (check
        // OpenEMR snapshot endpoint vs check the LLM provider).
        expect(classifyBriefingError(new SnapshotHttpError(500, ''))).toBe(
            'chart_unavailable',
        );
    });

    it('maps a SnapshotNetworkError to chart_unavailable', () => {
        expect(classifyBriefingError(new SnapshotNetworkError('unreachable'))).toBe(
            'chart_unavailable',
        );
    });

    it('falls back to briefing_failed for unrecognized errors', () => {
        // Anything we haven't classified — including unexpected
        // synthesizer-level bugs — surfaces as the generic code so the UI
        // still renders a typed failure state.
        expect(classifyBriefingError(new TypeError('unexpected null'))).toBe(
            'briefing_failed',
        );
        expect(classifyBriefingError(new Error('plain'))).toBe('briefing_failed');
    });

    it('does not classify a 404 NotFoundError as model_unavailable (would mask real bugs)', () => {
        // 404 from Anthropic means we hit a wrong endpoint or the model name
        // is gone — that's a code-level bug, not a user-actionable outage.
        // Surface as briefing_failed so the operator notices.
        expect(classifyBriefingError(fakeAnthropic(NotFoundError, 404))).toBe(
            'briefing_failed',
        );
    });
});
