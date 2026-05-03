import { describe, expect, it } from 'vitest';

import { buildPrecomputeApp, postSlot } from './_helpers.js';

/**
 * §5.5 case (3): re-running the precompute for an opted-in
 * practitioner produces the same rows and zero additional tokens.
 *
 * "Zero additional tokens" maps to "the briefing runner is invoked
 * zero additional times." The route's `existsForToday()` check
 * short-circuits before the runner is called, so the assertion is on
 * the runner invocation count rather than on a token counter.
 */
describe('UC5 morning prep — idempotent re-run', () => {
    it('skips every slot when existsForToday returns true (no runner calls, no record writes)', async () => {
        // Re-run scenario: every slot already has a row from yesterday's
        // run (or the same morning's earlier tick). The route should
        // never invoke the runner and never call record().
        const handle = await buildPrecomputeApp({ existsForToday: true });

        for (const slot of handle.day.slots) {
            const res = await postSlot(handle, slot);
            expect(res.status).toBe(200);
            expect(res.body).toContain('"outcome":"skipped_idempotent"');
        }

        expect(handle.state.existsCalls).toHaveLength(20);
        expect(handle.state.recorded).toHaveLength(0);
        expect(handle.runnerCallCount()).toBe(0);
    });
});
