import { traceable } from 'langsmith/traceable';

import { createLogger } from '../../observability/logger.js';
import type { Counters } from '../../observability/counters.js';
import type { AgentHttpClient } from '../../tools/agentHttp.js';
import { getMedicationStatementProvenance } from '../../tools/getMedicationStatementProvenance.js';
import type { MedicationStatementProvenance } from '../../tools/narrowResponseDecoders.js';
import { parseMedicationStatementKey } from '../followUps.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { Claim, ClaimLedger, DraftBriefing } from '../types.js';

/**
 * §4.6.6 medication-statement-detail drill-down branch.
 *
 * The graph routes here when the request envelope carries
 * `followUp.type === 'medication_statement_detail'`. This node
 * bypasses the synthesizer entirely — patient-reported entries are
 * the kind of content the model would happily fabricate ("the
 * patient says they take it twice a day"); the deterministic branch
 * sticks to dose / usage / information-source as documented.
 *
 * Failure modes (each pinned by a test):
 *  - Malformed listId → connector segment, empty ledger.
 *  - 404 → "no record found" connector segment, empty ledger.
 *  - 5xx / network → "not available" connector segment, empty ledger.
 *  - Successful fetch → one deterministic claim (category
 *    `medication_statement`) + one prose segment with only the
 *    fields the source row carried.
 */

export interface MedicationStatementBranchDeps {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

const logger = createLogger('graph:medicationStatementBranch');

const CONNECTOR = (text: string): { draft: DraftBriefing; claimLedger: ClaimLedger } => ({
    draft: { segments: [{ text, claimIds: [] }] },
    claimLedger: { claims: [] },
});

/**
 * Render the deterministic prose. The verifier's
 * `matchesMedicationStatement` rule asks only that the claim text
 * mention `name`, so this rendering is freer than the prescription
 * branch's — but we still mention only fields the source row
 * carried so the surface stays grounded.
 */
const renderProvenanceText = (prov: MedicationStatementProvenance): string => {
    const source = prov.informationSource ?? 'patient';
    const parts: string[] = [`${source} reports ${prov.name}`];
    if (prov.dose !== null) {
        parts.push(prov.dose);
    }
    let text = parts.join(' ');
    if (prov.usageCategory !== null) {
        text = `${text} (${prov.usageCategory})`;
    }
    if (prov.linkedPrescriptionId !== null) {
        text = `${text}; linked to clinic prescription ${prov.linkedPrescriptionId}`;
    }
    return `${text}.`;
};

const buildClaim = (prov: MedicationStatementProvenance): Claim => ({
    id: 'medstmt-detail-1',
    text: renderProvenanceText(prov),
    category: 'medication_statement',
    sourceReferences: [{
        system: 'openemr',
        recordType: 'MedicationStatement',
        recordId: prov.listId,
        field: null,
        recordedAt: prov.adherenceAssertedAt,
    }],
    safetyCritical: false,
});

export const createMedicationStatementBranch = (
    deps: MedicationStatementBranchDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        const followUp = state.envelope.followUp;
        if (followUp?.type !== 'medication_statement_detail') {
            throw new Error(
                'medicationStatementBranch invoked without a medication_statement_detail follow-up',
            );
        }

        const parsed = parseMedicationStatementKey(followUp.listId);
        if (parsed?.recordType !== 'MedicationStatement') {
            logger.warn(
                { listId: followUp.listId, requestId: state.envelope.requestId },
                'medication_statement_detail follow-up has malformed listId',
            );
            return CONNECTOR(
                'The medication reference for this follow-up was not in a recognizable format.',
            );
        }
        const recordIdNum = Number.parseInt(parsed.recordId, 10);
        if (!Number.isInteger(recordIdNum) || recordIdNum <= 0) {
            logger.warn(
                { listId: followUp.listId, requestId: state.envelope.requestId },
                'medication_statement_detail follow-up recordId is not a positive integer',
            );
            return CONNECTOR(
                'The medication reference for this follow-up was not in a recognizable format.',
            );
        }

        const result = await getMedicationStatementProvenance({
            client: deps.client,
            token: deps.token,
            siteId: deps.siteId,
            pid: state.envelope.patient.pid,
            listId: recordIdNum,
            openEmrBaseUrl: deps.openEmrBaseUrl,
            ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
        });

        if (result.kind === 'gap') {
            return CONNECTOR('Medication statement detail is not available right now.');
        }
        if (result.provenance === null) {
            return CONNECTOR('No medication statement record found for this follow-up.');
        }

        const claim = buildClaim(result.provenance);
        return {
            draft: {
                segments: [{ text: claim.text, claimIds: [claim.id] }],
            },
            claimLedger: { claims: [claim] },
        };
    };

    return traceable(impl, { name: 'medicationStatementBranch', run_type: 'chain' });
};
