import type { Logger } from 'pino';

import type { PendingUpload, RequestEnvelope } from '../graph/types.js';
import type { ExtractionArtifactStore } from '../state/extractionArtifacts.js';
import type { AgentHttpClient } from '../tools/agentHttp.js';
import { getChartDocuments } from '../tools/getChartDocuments.js';

/**
 * Discover Clinical-Copilot-categorized documents on the patient's
 * chart that haven't been extracted yet, and splice them onto
 * `envelope.pendingUploads` so the supervisor's existing
 * `kickoffExtraction` routing fires for them just like it does for
 * documents uploaded through the chat panel.
 *
 * The bug this fixes: a clinician uploads an intake form via
 * OpenEMR's legacy Documents UI, then asks the agent about it. Without
 * this enrichment the agent has no signal that the document exists
 * and answers "the chart does not contain that information." With
 * the enrichment the supervisor sees a `pendingUploads` entry,
 * routes to `kickoffExtraction`, and the synthesizer can answer from
 * the resulting `extracted_document` snippets.
 *
 * Behavior:
 *   - **Fail open**: if the chart-documents endpoint 5xx's or
 *     network-fails, return the envelope unchanged. The briefing
 *     still works for chart-only questions; the lost behavior is
 *     just chart-doc discovery this turn.
 *   - **Postgres lookup over `extraction_artifacts`**: the agent
 *     filters here (not on the PHP side) because OpenEMR's MySQL has
 *     no view into the agent's Postgres. Each side stays responsible
 *     for its own DB.
 *   - **Chat-upload precedence**: a `documentUuid` already present
 *     in `envelope.pendingUploads` is left alone — the chat-panel's
 *     upload path stays the load-bearing one, and any chart-side row
 *     for the same uuid is dropped to avoid duplicate kickoff calls.
 *   - **No-op when nothing to add**: if every chart document is
 *     already extracted (or already in `pendingUploads`), the
 *     envelope is returned unchanged.
 */

/** Window we look back for already-extracted artifacts. Matches the value the briefing's `documentEvidenceRetriever` uses by default — anything older than this is unlikely to be the document the clinician is asking about, and limits the Postgres scan. */
const EXTRACTED_ARTIFACT_LOOKBACK_DAYS = 365;

export interface EnrichPendingUploadsDeps {
    readonly httpClient: AgentHttpClient;
    readonly extractionArtifactStore: ExtractionArtifactStore;
    readonly openEmrBaseUrl: string;
    readonly logger: Logger;
}

export interface EnrichPendingUploadsInput {
    readonly envelope: RequestEnvelope;
    readonly token: string;
}

export const enrichPendingUploadsWithChartDocuments = async (
    deps: EnrichPendingUploadsDeps,
    input: EnrichPendingUploadsInput,
): Promise<RequestEnvelope> => {
    const { envelope, token } = input;
    const existingUuids = new Set(
        (envelope.pendingUploads ?? []).map((u) => u.documentUuid),
    );

    const chartDocsResult = await getChartDocuments({
        client: deps.httpClient,
        token,
        siteId: envelope.siteId,
        pid: envelope.patient.pid,
        openEmrBaseUrl: deps.openEmrBaseUrl,
        ...(envelope.conversationId !== undefined && envelope.conversationId.length > 0
            ? { conversationId: envelope.conversationId }
            : {}),
    });
    if (chartDocsResult.kind !== 'ok') {
        // Fail open — chart-doc discovery is best-effort. Briefing
        // proceeds with the un-enriched envelope.
        deps.logger.warn(
            { reason: chartDocsResult.reason, message: chartDocsResult.message },
            'chart-documents discovery unavailable — proceeding without enrichment',
        );
        return envelope;
    }

    if (chartDocsResult.documents.length === 0) {
        return envelope;
    }

    // Drop chart docs whose uuid is already on the envelope (chat-
    // upload precedence) before paying for the Postgres lookup.
    const candidates = chartDocsResult.documents.filter(
        (d) => !existingUuids.has(d.documentUuid),
    );
    if (candidates.length === 0) {
        return envelope;
    }

    // Look up already-extracted artifacts for this patient and drop
    // any chart doc whose uuid we've already processed. The store's
    // `searchArtifacts` is patient-scoped, status-filtered, and
    // `since`-bounded — those are the same constraints the
    // documentEvidenceRetriever uses, so the two views stay
    // consistent.
    const since = new Date(Date.now() - EXTRACTED_ARTIFACT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const extractedUuids = new Set<string>();
    try {
        const artifacts = await deps.extractionArtifactStore.searchArtifacts({
            pid: envelope.patient.pid,
            since,
        });
        for (const a of artifacts) {
            extractedUuids.add(a.documentUuid);
        }
    } catch (err) {
        // Postgres outage on this lookup — treat as "nothing
        // extracted" and let the supervisor re-extract any chart
        // docs. Worst case: a brief duplicate kickoff next turn,
        // which the pipeline's `claimDocumentLock` will collapse on
        // the agent side. The briefing still works.
        deps.logger.warn(
            { err: (err as Error).message },
            'extraction_artifacts lookup failed — chart docs will be re-presented to the supervisor',
        );
    }

    const newUploads: PendingUpload[] = [];
    for (const doc of candidates) {
        if (extractedUuids.has(doc.documentUuid)) continue;
        newUploads.push({
            documentUuid: doc.documentUuid,
            docType: doc.docType,
            canonicalExt: doc.canonicalExt,
        });
    }

    if (newUploads.length === 0) {
        return envelope;
    }

    deps.logger.info(
        {
            patientPid: envelope.patient.pid,
            chartDocsDiscovered: chartDocsResult.documents.length,
            newPendingUploads: newUploads.length,
        },
        'enriched envelope with chart-side documents',
    );

    return {
        ...envelope,
        pendingUploads: [...(envelope.pendingUploads ?? []), ...newUploads],
    };
};
