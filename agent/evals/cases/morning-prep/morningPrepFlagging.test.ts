import { describe, expect, it } from 'vitest';

import { buildPrecomputeApp, postSlot } from './_helpers.js';

/**
 * §5.5 case (1): synthetic 20-patient day, opted-in. Asserts the
 * right subset is flagged.
 *
 * The fake runner echoes each slot's `expectedArchetypeFlags` back
 * through the `assistantMessage` event; the route concatenates that
 * with `gaps[].reason` (empty here) into `flags[]`. The eval pins
 * three things:
 *
 *   1. Every slot writes a row (20 of them).
 *   2. Per-slot flag content matches the fixture's expectation.
 *   3. The flagged-vs-unflagged split is the §5.5 contract:
 *      8 flagged (3 + 3 + 2) and 12 unflagged (4 + 4 + 4).
 *
 * The opt-out + settings-flip cases live in PHPUnit (they exercise
 * the PHP-side `MorningPrepGate` / `findEnabledPractitioners`
 * filter that runs *before* the agent service is hit).
 */
describe('UC5 morning prep — 20-patient day with opted-in practitioner', () => {
    it('flags the right subset and writes one row per slot', async () => {
        const handle = await buildPrecomputeApp({ existsForToday: false });

        for (const slot of handle.day.slots) {
            const res = await postSlot(handle, slot);
            expect(res.status).toBe(200);
        }

        expect(handle.runnerCallCount()).toBe(20);
        expect(handle.state.recorded).toHaveLength(20);

        const recordedById = new Map(
            handle.state.recorded.map((r) => [r.key.appointmentId, r] as const),
        );

        for (const slot of handle.day.slots) {
            const row = recordedById.get(slot.appointmentId);
            expect(row, `row for ${slot.appointmentId}`).toBeDefined();
            expect(row?.key.practitionerUuid).toBe(slot.practitionerUuid);
            expect(row?.flags).toEqual(slot.expectedArchetypeFlags);
        }

        const flaggedRows = handle.state.recorded.filter((r) => r.flags.length > 0);
        const unflaggedRows = handle.state.recorded.filter((r) => r.flags.length === 0);
        expect(flaggedRows).toHaveLength(8);
        expect(unflaggedRows).toHaveLength(12);

        const flaggedArchetypes = handle.day.slots
            .filter((s) => s.expectedArchetypeFlags.length > 0)
            .map((s) => s.archetype);
        expect(new Set(flaggedArchetypes)).toEqual(
            new Set([
                'diabetic_uncontrolled',
                'complex_elderly',
                'recent_ed_visit',
            ]),
        );
    });
});
