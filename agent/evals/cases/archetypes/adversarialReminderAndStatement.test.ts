import { describe, expect, it } from 'vitest';

import { verifyLedger } from '../../../src/verify/verifier.js';
import type { Claim, ClaimLedger } from '../../../src/graph/types.js';

import { loadFixture } from './_helpers.js';

/**
 * §4.6.7 adversarial cases for the new claim categories.
 *
 * Two failure modes the verifier rules pin:
 *
 *  - `matchesReminder` requires the claim text to contain BOTH the
 *    reminder's `itemTitle` AND its `dueStatus`. A claim that names
 *    the right item with the wrong urgency ("Mammogram is due"
 *    against an `overdue` reminder) is a *different statement* than
 *    "Mammogram is overdue" — it would mislead the clinician, so the
 *    verifier rejects it.
 *
 *  - `matchesMedicationStatement` requires the claim text to contain
 *    the medication's `name`. The rule is intentionally loose for
 *    name match, but a claim that fabricates an
 *    `informationSource` not present in the source row is exactly
 *    the kind of patient-reported-context the deterministic branch
 *    is supposed to prevent. We test that even with a name-only
 *    `matches` rule, fabricating fields that aren't in the source
 *    can't slip through when the synthesizer emits a claim that
 *    cites a fabricated record id.
 */

const sourceRefForReminder = (recordId: string) => ({
    system: 'openemr' as const,
    recordType: 'Task' as const,
    recordId,
    field: null,
    recordedAt: null,
});

const sourceRefForStatement = (recordId: string) => ({
    system: 'openemr' as const,
    recordType: 'MedicationStatement' as const,
    recordId,
    field: null,
    recordedAt: null,
});

describe('§4.6.7 adversarial — reminder claim with wrong dueStatus', () => {
    it('verifier rejects "is due" against an overdue reminder (right item, wrong urgency)', () => {
        // complex_elderly carries an OVERDUE mammogram reminder.
        const snapshot = loadFixture('complex_elderly');
        const reminders = 'kind' in snapshot.reminders ? [] : snapshot.reminders;
        const reminder = reminders[0];
        if (reminder === undefined) {
            throw new Error('fixture must carry a reminder for this test');
        }
        // Sanity: precondition — the reminder is overdue.
        expect(reminder.dueStatus.toLowerCase()).toBe('overdue');

        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'c-wrong-urgency',
                    // Right item, but says "due" instead of "overdue".
                    text: `${reminder.itemTitle} is due for screening`,
                    category: 'reminder',
                    sourceReferences: [sourceRefForReminder(reminder.source.recordId)],
                    safetyCritical: false,
                } satisfies Claim,
            ],
        };

        const verified = verifyLedger(snapshot, ledger);

        expect(verified.passed).toBe(false);
        expect(verified.accepted).toHaveLength(0);
        expect(verified.rejected).toHaveLength(1);
        expect(verified.rejected[0]?.reason).toBe(
            'claim-text-does-not-match-source-fields',
        );
    });

    it('verifier accepts "is overdue" against the same reminder (precondition for the negative case)', () => {
        const snapshot = loadFixture('complex_elderly');
        const reminders = 'kind' in snapshot.reminders ? [] : snapshot.reminders;
        const reminder = reminders[0];
        if (reminder === undefined) throw new Error('fixture must carry a reminder');

        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'c-correct',
                    text: `${reminder.itemTitle} is overdue`,
                    category: 'reminder',
                    sourceReferences: [sourceRefForReminder(reminder.source.recordId)],
                    safetyCritical: false,
                },
            ],
        };

        const verified = verifyLedger(snapshot, ledger);
        expect(verified.passed).toBe(true);
        expect(verified.accepted).toHaveLength(1);
    });
});

describe('§4.6.7 adversarial — medication statement claim citing a fabricated id', () => {
    it('verifier rejects a statement claim that names a real medication but cites an id NOT in the snapshot', () => {
        // complex_elderly carries an OTC Tylenol entry. The verifier's
        // matchesMedicationStatement rule is name-only, so a claim
        // that says "patient reports taking Tylenol" with the right
        // listId would be accepted. The adversarial twist: the model
        // has the right name but cites a *fabricated* recordId. The
        // verifier's resolution check (one layer up from
        // contentMatches) rejects unresolved refs. This test pins
        // that the resolution gate fires before the looser
        // matchesMedicationStatement rule has a chance to accept the
        // claim.
        const snapshot = loadFixture('complex_elderly');
        const statements = 'kind' in snapshot.medications ? [] : snapshot.medications;
        const stmt = statements[0];
        if (stmt === undefined) throw new Error('fixture must carry a medication statement');

        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'c-fabricated-id',
                    // Name is real, fabricated information source — the
                    // synthesizer invented "Family caregiver" rather
                    // than reading the source row.
                    text: `Family caregiver reports patient is taking ${stmt.name}`,
                    category: 'medication_statement',
                    // Fabricated recordId — does not exist in the
                    // snapshot. The verifier's resolution check
                    // catches this before any content check runs.
                    sourceReferences: [sourceRefForStatement('msmt-fabricated-99999')],
                    safetyCritical: false,
                },
            ],
        };

        const verified = verifyLedger(snapshot, ledger);

        expect(verified.passed).toBe(false);
        expect(verified.accepted).toHaveLength(0);
        expect(verified.rejected).toHaveLength(1);
        expect(verified.rejected[0]?.reason).toBe('source-record-not-in-snapshot');
    });

    it('verifier accepts a name-matching claim with a real listId (precondition)', () => {
        const snapshot = loadFixture('complex_elderly');
        const statements = 'kind' in snapshot.medications ? [] : snapshot.medications;
        const stmt = statements[0];
        if (stmt === undefined) throw new Error('fixture must carry a medication statement');

        const ledger: ClaimLedger = {
            claims: [
                {
                    id: 'c-correct',
                    text: `Patient reports taking ${stmt.name}`,
                    category: 'medication_statement',
                    sourceReferences: [sourceRefForStatement(stmt.source.recordId)],
                    safetyCritical: false,
                },
            ],
        };

        const verified = verifyLedger(snapshot, ledger);
        expect(verified.passed).toBe(true);
        expect(verified.accepted).toHaveLength(1);
    });
});
