import { createLogger } from '../../observability/logger.js';
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
}

export const createVerify = (
    deps: VerifyDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const logger = createLogger('verify');

    return async (state) => {
        if (state.snapshot === null) {
            throw new Error('Verify called before Retrieve populated the snapshot');
        }
        const ledger = state.claimLedger ?? { claims: [] };
        const verified: VerifiedLedger = verifyLedger(state.snapshot, ledger);

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
