import type { Counters } from '../../observability/counters.js';
import { createNoopCounters } from '../../observability/counters.js';
import { createLogger } from '../../observability/logger.js';
import { setRunMetadata } from '../../observability/traceMetadata.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import {
    type UnverifiedClaimsLog,
    type UnverifiedClaimRecord,
} from '../../verify/unverifiedClaimsLog.js';
import { verifyLedger } from '../../verify/verifier.js';
import type { VerifiedLedger } from '../types.js';

/**
 * §3.3 verification gate. Runs the deterministic checks in
 * `verifyLedger`, and ships every dropped claim to the engineering
 * unverified-claims log so a future contributor can replay why a claim
 * was rejected.
 *
 * The log sink is injected so production wiring uses the Postgres
 * recorder while tests use the null sink. Failures inside the recorder
 * never block the response: the verifier's structured rejection list
 * still reaches `Persist`, and the recorder logs and swallows
 * (instrumentation should never widen the user-facing failure surface).
 */
export interface VerifyDeps {
    readonly unverifiedClaimsLog: UnverifiedClaimsLog;
    /**
     * §6.1 cost-projection counters. Verification pass/fail rate +
     * prompt-injection counts get recorded here. Optional so existing
     * tests can skip wiring it.
     */
    readonly counters?: Counters;
}

/**
 * §6.1: a "prompt injection failure" is a model output that names a
 * source record id which doesn't exist in the chart snapshot — that's
 * the canonical signal that the model invented a citation rather than
 * grounding a claim. We do *not* count claims rejected for missing
 * source-references (those are sloppy outputs, not injection).
 */
const PROMPT_INJECTION_REASON = 'source-record-not-in-snapshot' as const;

const countPromptInjections = (verified: VerifiedLedger): number =>
    verified.rejected.filter((r) => r.reason === PROMPT_INJECTION_REASON).length;

export const createVerify = (
    deps: VerifyDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const logger = createLogger('verify');
    const counters = deps.counters ?? createNoopCounters();

    return async (state) => {
        if (state.snapshot === null) {
            throw new Error('Verify called before Retrieve populated the snapshot');
        }
        const ledger = state.claimLedger ?? { claims: [] };
        const verified: VerifiedLedger = verifyLedger(state.snapshot, ledger);

        const promptInjections = countPromptInjections(verified);
        const passed = verified.rejected.length === 0 && verified.safetyHardStops.length === 0;
        counters.recordVerification({
            passed,
            accepted: verified.accepted.length,
            rejected: verified.rejected.length,
            promptInjections,
        });
        setRunMetadata({
            verification_passed: passed,
            claims_accepted: verified.accepted.length,
            claims_rejected: verified.rejected.length,
            safety_hard_stops: verified.safetyHardStops.length,
            prompt_injection_failures: promptInjections,
        });

        if (verified.rejected.length > 0) {
            const records: UnverifiedClaimRecord[] = verified.rejected.map((r) => ({
                context: {
                    requestId: state.envelope.requestId,
                    conversationId: state.envelope.conversationId,
                },
                claim: r.claim,
                reason: r.reason,
            }));
            try {
                await deps.unverifiedClaimsLog.record(records);
            } catch (err: unknown) {
                // Engineering instrumentation — a failed write must not
                // widen the user-facing failure surface. The dropped
                // claim is still surfaced through `verified.rejected`,
                // and the formatter has already discarded it.
                logger.error(
                    { err, requestId: state.envelope.requestId, count: records.length },
                    'failed to record unverified claims; continuing',
                );
            }
            logger.info(
                {
                    requestId: state.envelope.requestId,
                    accepted: verified.accepted.length,
                    rejected: verified.rejected.length,
                    hardStops: verified.safetyHardStops,
                },
                'verification gate dropped claims',
            );
        }

        return { verified };
    };
};
