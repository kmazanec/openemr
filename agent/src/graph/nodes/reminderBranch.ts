import { traceable } from 'langsmith/traceable';

import { createLogger } from '../../observability/logger.js';
import type { Counters } from '../../observability/counters.js';
import type { AgentHttpClient } from '../../tools/agentHttp.js';
import { getReminderDetail } from '../../tools/getReminderDetail.js';
import type { ReminderDetail } from '../../tools/narrowResponseDecoders.js';
import { parseReminderKey } from '../followUps.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { Claim, ClaimLedger, DraftBriefing } from '../types.js';

/**
 * §4.6.5 reminder-detail drill-down branch.
 *
 * The graph routes here when the request envelope carries
 * `followUp.type === 'reminder_detail'`. This node bypasses the
 * synthesizer entirely — the whole point is that the clinician's
 * "When is X due?" answer comes from the reminder's source row plus
 * the rule's documented description, not from model inference.
 *
 * Failure modes (each pinned by a test):
 *  - Malformed reminderId → connector segment, empty ledger.
 *  - 404 (reminder not found / not this patient's) → "no record
 *    found" connector segment, empty ledger.
 *  - Detail fetch fails open (5xx / network) → "not available"
 *    connector segment, empty ledger.
 *  - Successful fetch → one deterministic claim (category
 *    `reminder`) + one prose segment.
 */

export interface ReminderBranchDeps {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

const logger = createLogger('graph:reminderBranch');

const CONNECTOR = (text: string): { draft: DraftBriefing; claimLedger: ClaimLedger } => ({
    draft: { segments: [{ text, claimIds: [] }] },
    claimLedger: { claims: [] },
});

/**
 * Render the deterministic prose. The `${itemTitle} is ${dueStatus}`
 * skeleton is what the verifier rule (matchesReminder) keys on, so
 * any wording change here must update the verifier in lockstep. Rule
 * description, when present, ships as a parenthetical so it doesn't
 * disturb the substring-match contract.
 */
const renderDetailText = (detail: ReminderDetail): string => {
    let text = `${detail.itemTitle} is ${detail.dueStatus}`;
    if (detail.createdAt !== null) {
        text = `${text}, created ${detail.createdAt}`;
    }
    if (detail.ruleDescription !== null) {
        text = `${text} (${detail.ruleDescription})`;
    }
    return `${text}.`;
};

const buildClaim = (detail: ReminderDetail): Claim => ({
    id: 'reminder-detail-1',
    text: renderDetailText(detail),
    category: 'reminder',
    sourceReferences: [{
        system: 'openemr',
        recordType: 'Task',
        recordId: detail.reminderId,
        field: null,
        recordedAt: detail.createdAt,
    }],
    safetyCritical: false,
});

export const createReminderBranch = (
    deps: ReminderBranchDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        const followUp = state.envelope.followUp;
        if (followUp?.type !== 'reminder_detail') {
            throw new Error('reminderBranch invoked without a reminder_detail follow-up');
        }

        const parsed = parseReminderKey(followUp.reminderId);
        if (parsed?.recordType !== 'Task') {
            logger.warn(
                { reminderId: followUp.reminderId, requestId: state.envelope.requestId },
                'reminder_detail follow-up has malformed reminderId',
            );
            return CONNECTOR(
                'The reminder reference for this follow-up was not in a recognizable format.',
            );
        }
        const recordIdNum = Number.parseInt(parsed.recordId, 10);
        if (!Number.isInteger(recordIdNum) || recordIdNum <= 0) {
            logger.warn(
                { reminderId: followUp.reminderId, requestId: state.envelope.requestId },
                'reminder_detail follow-up recordId is not a positive integer',
            );
            return CONNECTOR(
                'The reminder reference for this follow-up was not in a recognizable format.',
            );
        }

        const result = await getReminderDetail({
            client: deps.client,
            token: deps.token,
            siteId: deps.siteId,
            pid: state.envelope.patient.pid,
            reminderId: recordIdNum,
            openEmrBaseUrl: deps.openEmrBaseUrl,
            ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
        });

        if (result.kind === 'gap') {
            return CONNECTOR('Reminder detail is not available right now.');
        }
        if (result.detail === null) {
            return CONNECTOR('No reminder record found for this follow-up.');
        }

        const claim = buildClaim(result.detail);
        return {
            draft: {
                segments: [{ text: claim.text, claimIds: [claim.id] }],
            },
            claimLedger: { claims: [claim] },
        };
    };

    return traceable(impl, { name: 'reminderBranch', run_type: 'chain' });
};
