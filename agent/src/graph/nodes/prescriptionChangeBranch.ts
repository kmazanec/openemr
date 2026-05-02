import { traceable } from 'langsmith/traceable';

import { createLogger } from '../../observability/logger.js';
import { getPrescriptionProvenance } from '../../tools/getPrescriptionProvenance.js';
import type { AgentHttpClient } from '../../tools/agentHttp.js';
import type { Counters } from '../../observability/counters.js';
import type { PrescriptionProvenance } from '../../tools/narrowResponseDecoders.js';
import { parsePrescriptionKey } from '../followUps.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { Claim, ClaimLedger, DraftBriefing } from '../types.js';
import { computeHardStops, isStoppedCategory } from '../../verify/verifier.js';

/**
 * §4.3 UC3 prescription-change drill-down branch.
 *
 * The graph routes here when the request envelope carries
 * `followUp.type === 'prescription_change'`. This node bypasses the
 * synthesizer entirely — that is the *whole point*: USERS.md UC3
 * promises the prescriber + indication come from documented fields
 * rather than model inference, so we read the prescription's source
 * row, format the response deterministically, and let the verifier
 * gate the result against the same row.
 *
 * Failure modes (each pinned by a test):
 *  - Malformed prescriptionId → connector segment, empty ledger.
 *  - 404 (prescription not found / not this patient's) →
 *    "no record found" connector segment, empty ledger.
 *  - Provenance fetch fails open (5xx / network) → "not available"
 *    connector segment, empty ledger.
 *  - Successful fetch → one deterministic claim (category
 *    `prescription_change`) + one prose segment containing only fields
 *    that were non-null in the source row.
 */

export interface PrescriptionChangeBranchDeps {
    readonly client: AgentHttpClient;
    readonly token: string;
    readonly siteId: string;
    readonly openEmrBaseUrl: string;
    readonly counters?: Counters;
}

const logger = createLogger('graph:prescriptionChangeBranch');

const CONNECTOR = (text: string): { draft: DraftBriefing; claimLedger: ClaimLedger } => ({
    draft: { segments: [{ text, claimIds: [] }] },
    claimLedger: { claims: [] },
});

/**
 * Render the deterministic prose. Mentions only fields that are
 * non-null in the source row — the verifier rule then accepts the
 * omission of any null field. The text is the *exact* surface the
 * verifier compares against, so changes here must update the
 * verifier's `containsCI` checks in lockstep.
 */
const renderProvenanceText = (prov: PrescriptionProvenance): string => {
    const parts: string[] = [prov.drugName];
    const dose = prov.doseAdjustments[0]?.dose ?? null;
    if (dose !== null) parts.push(dose);
    let text = parts.join(' ');
    if (prov.prescribingDate !== null) {
        text = `${text}, started ${prov.prescribingDate}`;
    }
    if (prov.prescriber !== null) {
        text = `${text}, prescribed by ${prov.prescriber}`;
    }
    if (prov.indication !== null) {
        text = `${text} for ${prov.indication}`;
    }
    return `${text}.`;
};

const buildClaim = (prov: PrescriptionProvenance): Claim => ({
    id: 'rx-change-1',
    text: renderProvenanceText(prov),
    category: 'prescription_change',
    sourceReferences: [{
        system: 'openemr',
        recordType: 'MedicationRequest',
        recordId: prov.prescriptionId,
        field: null,
        recordedAt: prov.prescribingDate,
    }],
    safetyCritical: true,
});

export const createPrescriptionChangeBranch = (
    deps: PrescriptionChangeBranchDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        const followUp = state.envelope.followUp;
        if (followUp?.type !== 'prescription_change') {
            // Graph routing should never land here otherwise — surface
            // loudly so a wiring bug fails the test rather than silently
            // emits an empty draft.
            throw new Error('prescriptionChangeBranch invoked without a prescription_change follow-up');
        }

        const parsed = parsePrescriptionKey(followUp.prescriptionId);
        if (parsed?.recordType !== 'MedicationRequest') {
            logger.warn(
                { prescriptionId: followUp.prescriptionId, requestId: state.envelope.requestId },
                'prescription_change follow-up has malformed prescriptionId',
            );
            return CONNECTOR(
                'The prescription reference for this follow-up was not in a recognizable format.',
            );
        }
        const recordIdNum = Number.parseInt(parsed.recordId, 10);
        if (!Number.isInteger(recordIdNum) || recordIdNum <= 0) {
            logger.warn(
                { prescriptionId: followUp.prescriptionId, requestId: state.envelope.requestId },
                'prescription_change follow-up recordId is not a positive integer',
            );
            return CONNECTOR(
                'The prescription reference for this follow-up was not in a recognizable format.',
            );
        }

        // Match the verifier's safety policy: when allergies (or
        // prescriptions) are unavailable we cannot safely surface a
        // prescription detail — the verifier would drop the resulting
        // claim under the same hard-stop rule, so short-circuit
        // BEFORE the network call so the snapshot endpoint never sees
        // a request whose response we will never show. Reachable
        // today only if the snapshot type widens to allow a Gap on
        // those slots; pinned ahead of that change so the policy
        // doesn't depend on the current narrow shape.
        if (state.snapshot !== null) {
            const stops = computeHardStops(state.snapshot);
            if (isStoppedCategory('prescription_change', stops)) {
                return CONNECTOR(
                    'Prescription details are unavailable until allergy data is loaded.',
                );
            }
        }

        const result = await getPrescriptionProvenance({
            client: deps.client,
            token: deps.token,
            siteId: deps.siteId,
            pid: state.envelope.patient.pid,
            prescriptionId: recordIdNum,
            openEmrBaseUrl: deps.openEmrBaseUrl,
            ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
        });

        if (result.kind === 'gap') {
            return CONNECTOR('Prescription provenance is not available right now.');
        }
        if (result.provenance === null) {
            return CONNECTOR('No prescription record found for this prescription.');
        }

        const claim = buildClaim(result.provenance);
        return {
            draft: {
                segments: [{ text: claim.text, claimIds: [claim.id] }],
            },
            claimLedger: { claims: [claim] },
        };
    };

    return traceable(impl, { name: 'prescriptionChangeBranch', run_type: 'chain' });
};
