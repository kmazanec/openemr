import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { VerifiedLedger } from '../types.js';

/**
 * §3.2 stub. Phase 3.3 fills this in:
 *   - claim ledger schema with required `sourceReferences[]`
 *   - deterministic checks per category
 *   - reject claims without source references; strip from response
 *   - hard clinical rules: missing allergies / meds → fail closed
 *   - unverified claims logged in full to a separate Postgres table
 *
 * Today: pass every claim through untouched and report `passed: true`
 * so the graph runs end-to-end on synthetic happy-path data. This is a
 * trust-but-verify node; the trust window closes at §3.3 — do not let
 * production code skip past this stub before that lands.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async signature is the LangGraph node contract; stub body has no awaits yet (Phase 3.3 fills in deterministic checks).
export const verify = async (state: BriefingState): Promise<BriefingStateUpdate> => {
    const ledger = state.claimLedger;
    const claims = ledger?.claims ?? [];
    const verified: VerifiedLedger = {
        passed: true,
        accepted: claims,
        rejected: [],
        safetyHardStops: [],
    };
    return { verified };
};
