/**
 * Clinical Co-Pilot panel renderer (chat-thread shape).
 *
 * Opens a streaming POST to the agent proxy, parses SSE events, and
 * renders the resulting `assistantMessage` into a chat thread. Each
 * segment of an assistant message is one inline run of prose; per-claim
 * `[source]` chips link to the OpenEMR record where practical. Redacted
 * segments — segments whose claims were rejected by the verifier or
 * suppressed by a safety hard stop — are dropped from inline prose and
 * collapsed into a single "could not be verified" chip at the end of the
 * bubble. Clicking the chip opens a popover summarizing how many
 * statements were withheld so the renderer never asserts an unverified
 * fact while keeping the bubble readable.
 *
 * Failure-state policy:
 *   - Whole-stream errors render an error bubble using the typed error
 *     code from the agent's `errorClassifier.ts`.
 *   - Message-level `gaps` (allergies-unavailable, etc.) render as a
 *     yellow warning banner inside the assistant bubble.
 *   - Redactions stay visible — we never silently drop content.
 *
 * §4.5 free-text follow-up: the composer is enabled. Submit pushes a
 * user bubble into the thread and POSTs the same proxy endpoint with
 * `task: 'follow_up'` plus the typed question. The agent runs the same
 * §3.3 verification gate over the resulting claims, so the cited-prose
 * guarantee carries over.
 *
 * §4.6 resume: on cold load, the panel asks the agent for the most
 * recent conversation for this (clinician, patient) pair. If one exists
 * and was active within the resume window (12h, agent-side), we hydrate
 * the thread and adopt its conversationId so follow-ups append to that
 * row. Otherwise we mint nothing here and let the agent create a fresh
 * row when the default_briefing turn arrives.
 */
const __copilotPanel = (function () {
    'use strict';

    // The pure-function helpers (sourceLinkUrl, chipTooltipText,
    // claimGroupsToSections, etc.) defined inside this IIFE are
    // captured in the returned exports object at the bottom so
    // `tests/js/copilot-panel-claim-groups.test.js` can require them
    // from node. The DOM-touching bootstrap below short-circuits when
    // there's no document (i.e., when this file is loaded under
    // CommonJS for tests).
    const hasDom = typeof document !== 'undefined';
    const root = hasDom ? document.querySelector('.copilot-panel') : null;

    // Bootstrap variables — assigned only when the DOM is present.
    // Under CommonJS (tests), they stay null and the helpers below are
    // exported without the bootstrap ever running.
    let proxyUrl = null;
    let pid = NaN;
    let siteId = 'default';
    let statusEl = null;
    let threadEl = null;
    if (root) {
        proxyUrl = root.dataset.proxyUrl;
        pid = Number.parseInt(root.dataset.pid, 10);
        siteId = root.dataset.siteId || 'default';
        statusEl = root.querySelector('[data-role="status"]');
        threadEl = root.querySelector('[data-role="thread"]');
    }

    /**
     * `conversationId` is mutable: a placeholder until either a resume
     * lookup hands us an authoritative UUID (§4.6) or the agent mints
     * one and echoes it back in the `meta` event of the first stream
     * (§3.5). Either way, follow-up turns send the resolved id so the
     * agent appends to the same conversation.
     */
    let conversationId = `conv-${pid}-${Date.now()}`;
    const requestId = `req-${pid}-${Date.now()}`;

    /**
     * In-memory thread. The renderer reconciles to the DOM from this
     * array on every change so the DOM never holds state the model
     * doesn't reflect. Each entry is one bubble.
     *
     *   { role: 'assistant', message: AssistantMessage }
     *   { role: 'assistant', error: { code: string } }
     *   { role: 'assistant', progress: { stages: {…}[] }, requestId }
     *   { role: 'assistant', thinking: true, requestId }
     *   { role: 'user', text: string }
     *
     * The `progress` and `thinking` shapes are transient placeholder
     * bubbles shown while a turn is in flight. `progress` is the full
     * 4-stage pipeline — used only for the initial briefing turn,
     * where the doctor benefits from seeing the agent's full plan.
     * `thinking` is a single-line "Thinking…" indicator used for
     * follow-up turns, which complete in seconds and don't need the
     * stage breakdown. Either is replaced by the real assistant
     * bubble when the `assistantMessage` event lands. `requestId`
     * keys the placeholder so a fast second turn never lands its
     * progress events into the previous turn's bubble.
     */
    const thread = [];

    /**
     * Stage list we paint up-front so the doctor sees the full
     * pipeline before any progress event arrives. The server is the
     * source of truth — it pushes a `progress` SSE event with stage,
     * label, and status; we patch matching entries here. Stages the
     * server never reaches stay `pending` and the bubble is replaced
     * by the real assistant message before the doctor notices.
     */
    const PROGRESS_STAGES = [
        { stage: 'retrieve', label: 'Reading the chart', status: 'pending' },
        { stage: 'synthesize', label: 'Composing briefing', status: 'pending' },
        { stage: 'verify', label: 'Verifying citations', status: 'pending' },
        { stage: 'format', label: 'Finalizing', status: 'pending' },
    ];

    const newProgressEntry = (requestIdValue) => ({
        role: 'assistant',
        progress: { stages: PROGRESS_STAGES.map((s) => ({ ...s })) },
        requestId: requestIdValue,
    });

    const newThinkingEntry = (requestIdValue) => ({
        role: 'assistant',
        thinking: true,
        requestId: requestIdValue,
    });

    /**
     * Find the in-flight placeholder for a given requestId, regardless
     * of whether it's a `progress` (default_briefing) or `thinking`
     * (follow_up) bubble. Both shapes are replaced by the same
     * assistantMessage / error paths.
     */
    const findInflightIndex = (requestIdValue) => {
        for (let i = thread.length - 1; i >= 0; i--) {
            const entry = thread[i];
            if (!entry || entry.role !== 'assistant' || entry.requestId !== requestIdValue) continue;
            if (entry.progress || entry.thinking) {
                return i;
            }
        }
        return -1;
    };

    const findProgressIndex = (requestIdValue) => {
        for (let i = thread.length - 1; i >= 0; i--) {
            const entry = thread[i];
            if (entry && entry.role === 'assistant' && entry.progress && entry.requestId === requestIdValue) {
                return i;
            }
        }
        return -1;
    };

    const setStatus = (text, kind) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.dataset.kind = kind || 'info';
    };

    const escapeText = (s) => {
        const node = document.createElement('span');
        node.textContent = s == null ? '' : String(s);
        return node.innerHTML;
    };

    /**
     * Translate the W2 unified `SourceReference` shape into the W1
     * record-kind taxonomy the OpenEMR record-page URLs key off. The
     * agent ships every chart citation with `source_type='chart'` and a
     * `locator.field` like `medication.name` / `condition.code`; this
     * helper recovers the FHIR-shaped record type so the existing deep
     * links keep working without touching the agent contract.
     *
     * Returns null when the field doesn't map — `extracted_document` and
     * `guideline` chips are tooltip-only by design (Layer-1 / Layer-2
     * click-throughs defer to Phase F per `W2_ARCHITECTURE.md`
     * §"Click-to-source UI"), so they always land here.
     */
    const recordTypeForChartField = (field) => {
        if (typeof field !== 'string') return null;
        if (field.startsWith('patient.')) return 'Patient';
        if (field.startsWith('encounter.')) return 'Encounter';
        if (field.startsWith('appointment.')) return 'Appointment';
        if (field.startsWith('condition.')) return 'Condition';
        if (field.startsWith('medication.')) return 'MedicationRequest';
        if (field.startsWith('medicationStatement.')) return 'MedicationStatement';
        if (field.startsWith('allergy.')) return 'AllergyIntolerance';
        if (field.startsWith('observation.')) return 'Observation';
        if (field.startsWith('task.')) return 'Task';
        if (field.startsWith('documentReference.')) return 'DocumentReference';
        return null;
    };

    /**
     * Map a SourceReference to a stable record-view URL where there is
     * one. Chart refs (W1 carry-forward, per the D.2 plan and
     * `W2_ARCHITECTURE.md` §"Click-to-source UI" Layer 0) link to the
     * existing OpenEMR record pages; extracted-document and guideline
     * chips are tooltip-only in D — Layer 1 PDF.js bbox overlay and
     * Layer 2 section-snippet popover defer to Phase F.
     */
    const sourceLinkUrl = (source) => {
        if (!source || source.source_type !== 'chart') return null;
        const recordId = source.source_id;
        if (typeof recordId !== 'string' || recordId.length === 0) return null;
        const field = source.locator !== undefined && source.locator !== null
            ? source.locator.field
            : undefined;
        const recordType = recordTypeForChartField(field);
        switch (recordType) {
            case 'Patient':
                return `../../../../patient_file/summary/demographics.php?set_pid=${encodeURIComponent(recordId)}`;
            case 'Encounter':
                return `../../../../patient_file/encounter/encounter_top.php?set_encounter=${encodeURIComponent(recordId)}`;
            case 'Condition':
            case 'AllergyIntolerance':
            case 'MedicationRequest':
            case 'MedicationStatement':
                return `../../../../patient_file/summary/stats_full.php`;
            case 'Observation':
                return `../../../../patient_file/encounter/load_form.php?formname=procedure_order_results`;
            default:
                return null;
        }
    };

    /**
     * §C.6 publication labels keyed off the `source_id` prefix the
     * `agent/scripts/reindex-corpus.ts` reindexer mints (`uspstf::…`,
     * `ada::…`, etc.). Extending here is a one-line change when a new
     * publisher lands in the corpus. Falls through to `null` so the
     * tooltip degrades to "section only" rather than printing a raw
     * prefix the clinician shouldn't see.
     */
    const PUBLICATION_LABELS = {
        uspstf: 'USPSTF',
        ada: 'ADA',
        'acc-aha': 'ACC/AHA',
        'ags-beers': 'AGS Beers',
        cdc: 'CDC',
    };

    const publicationFromSourceId = (sourceId) => {
        if (typeof sourceId !== 'string') return null;
        const idx = sourceId.indexOf('::');
        if (idx <= 0) return null;
        const prefix = sourceId.slice(0, idx).toLowerCase();
        return PUBLICATION_LABELS[prefix] || null;
    };

    /**
     * Variant-aware chip tooltip text. The full Layer-1 PDF.js bbox
     * overlay and Layer-2 section-snippet popover defer to Phase F, so
     * extracted-document and guideline chips need a tooltip that's
     * informative in isolation:
     *
     *   - chart: "<RecordKind> <recordId>" (W1 carry-forward).
     *   - extracted_document: "page <N> · document <uuid-prefix>".
     *     `meta.document_uuid` may be absent (the extractor doesn't
     *     always emit it); fall through to the page reference.
     *   - guideline: "<publication> · <section>". Publication is
     *     derived from the `source_id` prefix; falls through to
     *     section only when the prefix is unknown.
     *
     * Reviewer note: the D.2 plan's tooltip wording referenced
     * `<doc_type>` and `<year>` fields that aren't on the unified
     * `SourceReference` today. Extending `meta` with optional
     * `doc_type`, `publication`, and `year` is a small follow-up patch;
     * for D.2 the tooltip uses what's already on the wire so the
     * unified citation contract stays untouched.
     */
    /**
     * Friendly label for the W1 record-type taxonomy. Strips FHIR
     * resource suffixes the clinician doesn't think in
     * (`MedicationRequest` → "Medication") so the chip's tooltip reads
     * the way the chart row reads.
     */
    const CHART_RECORD_LABELS = {
        Patient: 'Patient',
        Encounter: 'Encounter',
        Appointment: 'Appointment',
        Condition: 'Diagnosis',
        MedicationRequest: 'Medication',
        MedicationStatement: 'Medication',
        AllergyIntolerance: 'Allergy',
        Observation: 'Lab',
        Task: 'Task',
        DocumentReference: 'Document',
    };

    const chipTooltipText = (source) => {
        if (!source || typeof source !== 'object') return 'Source';
        switch (source.source_type) {
            case 'chart': {
                const recordType = recordTypeForChartField(
                    source.locator !== undefined && source.locator !== null
                        ? source.locator.field
                        : undefined,
                );
                const kindLabel = recordType !== null && CHART_RECORD_LABELS[recordType] !== undefined
                    ? CHART_RECORD_LABELS[recordType]
                    : 'Record';
                const id = typeof source.source_id === 'string' ? source.source_id : '';
                return `${kindLabel} ${id}`.trim();
            }
            case 'extracted_document': {
                const page = source.locator !== undefined && source.locator !== null
                    ? source.locator.page
                    : undefined;
                const uuid = source.meta !== undefined && source.meta !== null
                    ? source.meta.document_uuid
                    : undefined;
                const parts = [];
                if (typeof page === 'number') parts.push(`page ${page}`);
                if (typeof uuid === 'string' && uuid.length > 0) {
                    // Truncate the uuid to the leading 8 chars — long
                    // enough to disambiguate uploads in the same turn,
                    // short enough to read at a glance.
                    parts.push(`document ${uuid.slice(0, 8)}`);
                }
                return parts.length > 0 ? parts.join(' · ') : 'From document';
            }
            case 'guideline': {
                const publication = publicationFromSourceId(source.source_id);
                const section = source.locator !== undefined && source.locator !== null
                    ? source.locator.section
                    : undefined;
                const parts = [];
                if (publication !== null) parts.push(publication);
                if (typeof section === 'string' && section.length > 0) parts.push(section);
                return parts.length > 0 ? parts.join(' · ') : 'Evidence';
            }
            default:
                return 'Source';
        }
    };

    /**
     * Render a `[source]` chip as a button. The chip itself doesn't
     * navigate anywhere on click — instead it opens a popover with
     * the claim text, source identity, and a "View full record" link
     * (the link is the same URL the chip used to navigate to). This
     * gives the doctor in-place context for the citation rather than
     * yanking them off-page on every click.
     *
     * The triple-index (bubble/claim/source) lets the click handler
     * recover the exact `Claim` + `SourceReference` from the in-memory
     * `thread[]` without serializing the whole object into the DOM.
     */
    /**
     * Per-`source_type` chip-style modifier so the three section types
     * are visually scannable at a glance: chart chips keep the W1 blue
     * styling; extracted-document chips get a document-themed tone;
     * guideline chips get an evidence-themed tone. The CSS rules live
     * in `panel.css` keyed off these modifier classes.
     */
    const sourceVariantClass = (source) => {
        if (!source) return '';
        switch (source.source_type) {
            case 'extracted_document':
                return ' copilot-source--document';
            case 'guideline':
                return ' copilot-source--guideline';
            case 'chart':
            default:
                return '';
        }
    };

    const renderSourceChip = (source, indices) => {
        if (!source) {
            return '';
        }
        const tooltip = chipTooltipText(source);
        const variant = sourceVariantClass(source);
        const inert = sourceLinkUrl(source) === null ? ' copilot-source--inert' : '';
        return `<button type="button" class="copilot-source${variant}${inert}"
                        data-role="source-chip"
                        data-bubble-idx="${indices.bubble}"
                        data-segment-idx="${indices.segment}"
                        data-claim-idx="${indices.claim}"
                        data-source-idx="${indices.source}"
                        title="${escapeText(tooltip)}"
                        aria-label="Source: ${escapeText(tooltip)}">[source]</button>`;
    };

    /**
     * Render every source reference on every claim attached to a
     * segment. Each claim may carry multiple source references (a
     * cross-cited fact); we render one chip per ref so the clinician
     * can audit each provenance independently.
     */
    const renderSegmentChips = (claims, bubbleIdx, segmentIdx) => {
        if (!Array.isArray(claims) || claims.length === 0) return '';
        const chips = [];
        for (let claimIdx = 0; claimIdx < claims.length; claimIdx++) {
            const claim = claims[claimIdx];
            const refs = (claim && claim.sourceReferences) || [];
            for (let srcIdx = 0; srcIdx < refs.length; srcIdx++) {
                chips.push(
                    renderSourceChip(refs[srcIdx], {
                        bubble: bubbleIdx,
                        segment: segmentIdx,
                        claim: claimIdx,
                        source: srcIdx,
                    }),
                );
            }
        }
        return chips.join(' ');
    };

    const renderSegment = (segment, segmentIdx, bubbleIdx) => {
        if (!segment) return '';
        // Redacted segments are dropped from inline prose. Their
        // existence is surfaced by the bubble-level "could not be
        // verified" chip; rendering them here would re-introduce the
        // distracting in-line placeholders the chip exists to replace.
        if (segment.redacted) return '';
        // ISO dates the synthesizer leaves embedded in prose
        // (e.g. "started on 2024-03-15") get rewritten to
        // "March 15, 2024" so the doctor reads natural-language
        // dates. Applied AFTER escapeText so we operate on a string
        // that's already HTML-safe; we never feed dates through
        // attribute values or URLs.
        const text = formatDatesInText(escapeText(segment.text));
        const chips = renderSegmentChips(segment.claims, bubbleIdx, segmentIdx);
        return `<span class="copilot-segment">${text}${chips ? ' ' + chips : ''}</span>`;
    };

    /**
     * Bubble-level "could not be verified" chip. Replaces the inline
     * redacted segments with a single trailing affordance that opens
     * a popover summarizing how many statements were withheld. The
     * agent ships only the canonical placeholder text for redacted
     * segments (the original prose is never sent to the client by
     * design — see agent/src/graph/nodes/format.ts), so the popover
     * shows a count + explanation, not the withheld content.
     */
    const renderUnverifiedChip = (segments, bubbleIdx) => {
        if (!Array.isArray(segments)) return '';
        let count = 0;
        for (const seg of segments) {
            if (seg && seg.redacted) count++;
        }
        if (count === 0) return '';
        const label = count === 1
            ? '1 additional statement could not be verified'
            : `${count} additional statements could not be verified`;
        return `<button type="button" class="copilot-unverified"
                        data-role="unverified-chip"
                        data-bubble-idx="${bubbleIdx}"
                        data-count="${count}"
                        aria-label="${escapeText(label)}">${escapeText(label)}</button>`;
    };

    const renderGapsBanner = (gaps) => {
        if (!Array.isArray(gaps) || gaps.length === 0) return '';
        return gaps
            .map((g) => `<p class="copilot-gap" role="status">${escapeText(g.message || 'Section unavailable.')}</p>`)
            .join('');
    };

    /**
     * §C.6 / D.2 — project the format-node's `claimGroups` shape into an
     * ordered list of sections the renderer can iterate without any
     * per-shape branching. Empty buckets are *absent* from the input
     * (per format.ts), so omitting empty sections is a natural
     * consequence of "iterate over what's there".
     *
     * The section order is fixed: chart → documents → evidence. That
     * matches the W2 architecture's Format-node spec
     * (`W2_ARCHITECTURE.md` §"Format") which orders the panel as
     * "What's in the chart" / "From documents" / "Evidence".
     *
     * Pure function — exported via the CommonJS guard at the bottom of
     * this file so the Jest tests in `tests/js/copilot-panel-claim-groups.test.js`
     * can pin its behavior without spinning up a DOM.
     */
    const SECTION_HEADINGS = {
        chart: "What's in the chart",
        extractedDocument: 'From documents',
        guideline: 'Evidence',
    };

    const claimGroupsToSections = (claimGroups) => {
        if (!claimGroups || typeof claimGroups !== 'object') return [];
        const sections = [];
        if (claimGroups.chart && Array.isArray(claimGroups.chart.subsections)) {
            sections.push({
                kind: 'chart',
                heading: SECTION_HEADINGS.chart,
                subsections: claimGroups.chart.subsections,
            });
        }
        if (claimGroups.extractedDocument && Array.isArray(claimGroups.extractedDocument.cards)) {
            sections.push({
                kind: 'extractedDocument',
                heading: SECTION_HEADINGS.extractedDocument,
                cards: claimGroups.extractedDocument.cards,
            });
        }
        if (claimGroups.guideline && Array.isArray(claimGroups.guideline.claims)) {
            sections.push({
                kind: 'guideline',
                heading: SECTION_HEADINGS.guideline,
                claims: claimGroups.guideline.claims,
            });
        }
        return sections;
    };

    /**
     * §C.6 / D.2 — render one citation chip inside a section. Distinct
     * from the inline-segment chip (`renderSourceChip` above) on
     * purpose:
     *
     *   - chart → real `<a href>` to the OpenEMR record page (W1
     *     carry-forward; no popover).
     *   - extracted_document → inert button with the variant tooltip
     *     ("page N · document <uuid-prefix>"). The Layer-1 PDF.js bbox
     *     overlay defers to Phase F.
     *   - guideline → inert button with the variant tooltip
     *     ("<publication> · <section>"). The Layer-2 popover defers
     *     to Phase F.
     */
    const renderSectionChip = (source) => {
        if (!source) return '';
        const tooltip = chipTooltipText(source);
        const variant = sourceVariantClass(source);
        const url = sourceLinkUrl(source);
        if (typeof url === 'string' && url.length > 0) {
            return `<a class="copilot-source${variant}"
                       data-role="section-source-link"
                       href="${escapeText(url)}"
                       title="${escapeText(tooltip)}"
                       aria-label="Source: ${escapeText(tooltip)}">[source]</a>`;
        }
        return `<span class="copilot-source${variant} copilot-source--inert"
                      data-role="section-source-tooltip"
                      title="${escapeText(tooltip)}"
                      aria-label="Source: ${escapeText(tooltip)}">[source]</span>`;
    };

    const renderClaimWithChips = (claim) => {
        const text = formatDatesInText(escapeText(claim.text || ''));
        const refs = Array.isArray(claim.sourceReferences) ? claim.sourceReferences : [];
        const chips = refs.map((ref) => renderSectionChip(ref)).join(' ');
        return `<li class="copilot-claim-groups__claim">${text}${chips ? ' ' + chips : ''}</li>`;
    };

    const renderChartSubsection = (subsection) => {
        const heading = escapeText(titleCaseCategory(subsection.category));
        const claims = (subsection.claims || []).map(renderClaimWithChips).join('');
        return `<section class="copilot-claim-groups__chart-subsection"
                         data-category="${escapeText(subsection.category)}">
            <h4 class="copilot-claim-groups__subheading">${heading}</h4>
            <ul class="copilot-claim-groups__list">${claims}</ul>
        </section>`;
    };

    const renderDocumentCard = (card) => {
        const uuidLabel = typeof card.documentUuid === 'string' && card.documentUuid.length > 0
            ? `Document ${escapeText(card.documentUuid.slice(0, 8))}`
            : 'Document';
        const claims = (card.claims || []).map(renderClaimWithChips).join('');
        return `<section class="copilot-claim-groups__doc-card"
                         data-document-uuid="${escapeText(card.documentUuid || '')}">
            <h4 class="copilot-claim-groups__subheading">${uuidLabel}</h4>
            <ul class="copilot-claim-groups__list">${claims}</ul>
        </section>`;
    };

    /**
     * Render the C.6 panel-side projection of accepted claims grouped
     * by `source_type`. Empty `claimGroups` (e.g. a turn that produced
     * no accepted claims, or a follow-up that only emits redacted
     * segments) yields the empty string so the bubble doesn't grow an
     * unused header section.
     */
    const renderClaimGroups = (claimGroups) => {
        const sections = claimGroupsToSections(claimGroups);
        if (sections.length === 0) return '';
        const sectionHtml = sections.map((section) => {
            const heading = escapeText(section.heading);
            let body = '';
            if (section.kind === 'chart') {
                body = section.subsections.map(renderChartSubsection).join('');
            } else if (section.kind === 'extractedDocument') {
                body = section.cards.map(renderDocumentCard).join('');
            } else if (section.kind === 'guideline') {
                const claims = section.claims.map(renderClaimWithChips).join('');
                body = `<ul class="copilot-claim-groups__list">${claims}</ul>`;
            }
            return `<section class="copilot-claim-groups__section copilot-claim-groups__section--${section.kind}"
                             data-role="claim-group-section"
                             data-kind="${section.kind}">
                <h3 class="copilot-claim-groups__heading">${heading}</h3>
                ${body}
            </section>`;
        }).join('');
        return `<div class="copilot-claim-groups" data-role="claim-groups">${sectionHtml}</div>`;
    };

    /**
     * Map an SSE error code to a user-facing message. Codes are emitted
     * by the agent's `errorClassifier.ts`; the user never sees the raw
     * code or any provider name. Keep this map in sync with
     * `agent/src/server/errorClassifier.ts`.
     */
    const BRIEFING_ERROR_MESSAGES = {
        model_unavailable:
            'The AI service is temporarily unavailable. The chart loaded fine; please try again in a moment.',
        model_rate_limited:
            'The AI service is busy right now. Please try again in a moment.',
        chart_unavailable:
            'The patient chart could not be loaded. Please try again, or open the chart directly in OpenEMR.',
        invalid_envelope:
            'The briefing request was malformed. Reload the page and try again.',
        site_mismatch:
            'The briefing request did not match the active patient session. Reload the page and try again.',
        // Default for `briefing_failed` and any unrecognized code.
        briefing_failed:
            'The briefing could not be generated. Please try again, and ask an administrator to check the agent service if the problem persists.',
    };

    const messageForCode = (code) =>
        BRIEFING_ERROR_MESSAGES[code] || BRIEFING_ERROR_MESSAGES.briefing_failed;

    /**
     * §4.1 suggested follow-ups. Chips render below the assistant bubble
     * the message belongs to. Click handler POSTs the typed `followUp`
     * params back through the briefing endpoint (no `question` field).
     * The chip's `displayText` becomes the user-side message in the
     * thread so the UI reads as a normal back-and-forth.
     */
    const renderSuggestionsRail = (suggestions, bubbleIndex) => {
        if (!Array.isArray(suggestions) || suggestions.length === 0) return '';
        const chips = suggestions
            .map(
                (s, i) =>
                    `<button type="button" class="copilot-suggestion" data-role="suggestion" data-bubble="${bubbleIndex}" data-suggestion-index="${i}">${escapeText(s.displayText)}</button>`,
            )
            .join('');
        return `<div class="copilot-suggestions" data-role="suggestions">${chips}</div>`;
    };

    /**
     * In-flight progress bubble. Each stage row is a spinner
     * (active), checkmark (done), or neutral dot (pending). The
     * whole bubble is replaced by the real assistant bubble when
     * `assistantMessage` lands. Shape decisions:
     *
     *   - Render every stage up-front so the doctor sees what the
     *     agent will do, not just the current step.
     *   - Use semantic markers (✓, animated dot) rather than a raw
     *     percentage so the bubble degrades gracefully when reduced
     *     motion is on (the @keyframes are media-queried out in CSS).
     *   - role="status" + aria-live="polite" so screen readers
     *     announce stage transitions without yanking focus.
     */
    const renderBubble = (entry, index) => {
        if (!entry) return '';
        if (entry.role === 'assistant' && entry.error) {
            return `<article class="copilot-bubble copilot-bubble--assistant copilot-bubble--error" data-role="bubble" data-state="error">
                <p class="copilot-error" role="status">${escapeText(messageForCode(entry.error.code))}</p>
            </article>`;
        }
        if (entry.role === 'assistant' && entry.progress) {
            const stages = entry.progress.stages
                .map(
                    (s) => `<li class="copilot-progress__step copilot-progress__step--${s.status}"
                                data-stage="${escapeText(s.stage)}">
                                <span class="copilot-progress__marker" aria-hidden="true"></span>
                                <span class="copilot-progress__label">${escapeText(s.label)}</span>
                            </li>`,
                )
                .join('');
            return `<article class="copilot-bubble copilot-bubble--assistant copilot-bubble--progress"
                             data-role="bubble" data-state="progress">
                <ol class="copilot-progress" role="status" aria-live="polite">${stages}</ol>
            </article>`;
        }
        if (entry.role === 'assistant' && entry.thinking) {
            return `<article class="copilot-bubble copilot-bubble--assistant copilot-bubble--thinking"
                             data-role="bubble" data-state="thinking">
                <span class="copilot-thinking" role="status" aria-live="polite">
                    <span class="copilot-thinking__label">Thinking</span>
                    <span class="copilot-thinking__dots" aria-hidden="true">
                        <span class="copilot-thinking__dot"></span>
                        <span class="copilot-thinking__dot"></span>
                        <span class="copilot-thinking__dot"></span>
                    </span>
                </span>
            </article>`;
        }
        if (entry.role === 'assistant' && entry.message) {
            const messageSegments = entry.message.segments || [];
            const segments = messageSegments
                .map((segment, segIdx) => renderSegment(segment, segIdx, index))
                .filter((html) => html.length > 0)
                .join(' ');
            const unverified = renderUnverifiedChip(messageSegments, index);
            const gaps = renderGapsBanner(entry.message.gaps);
            const suggestions = renderSuggestionsRail(entry.message.suggestedFollowUps, index);
            const claimGroups = renderClaimGroups(entry.message.claimGroups);
            return `<article class="copilot-bubble copilot-bubble--assistant" data-role="bubble" data-state="rendered" data-bubble-index="${index}">
                ${gaps}
                <div class="copilot-bubble__body">${segments}${unverified ? ' ' + unverified : ''}</div>
                ${claimGroups}
                ${suggestions}
            </article>`;
        }
        if (entry.role === 'user' && entry.text) {
            return `<article class="copilot-bubble copilot-bubble--user" data-role="bubble">
                <div class="copilot-bubble__body">${escapeText(entry.text)}</div>
            </article>`;
        }
        return '';
    };

    const renderThread = () => {
        if (!threadEl) return;
        threadEl.innerHTML = thread.map((entry, i) => renderBubble(entry, i)).join('');
    };

    /**
     * Track the request in flight so `progress` events land on the
     * right placeholder bubble. The runner echoes the envelope's
     * `requestId` on every `progress` SSE frame (via the encoder in
     * `agent/src/server/briefingProgress.ts`); we match against this
     * id when patching the placeholder.
     *
     * Cleared in the `done`/`error`/`assistantMessage` paths so a
     * fresh turn starts with a clean slot.
     */
    let activeRequestId = null;

    const handleAssistantMessage = (data) => {
        if (!data || !data.message) return;
        // Replace the in-flight placeholder (progress bubble for the
        // initial briefing, thinking bubble for a follow-up) with the
        // real assistant message — keep the same array slot so the
        // chat doesn't visually jump.
        const idx = activeRequestId !== null ? findInflightIndex(activeRequestId) : -1;
        if (idx >= 0) {
            thread[idx] = { role: 'assistant', message: data.message };
        } else {
            thread.push({ role: 'assistant', message: data.message });
        }
        renderThread();
    };

    /**
     * Patch the in-flight progress bubble in response to a `progress`
     * SSE frame. `started` flips a stage to `active`; `completed`
     * flips it to `done`. Stages we don't recognize are ignored —
     * the panel doesn't fail closed on a future stage name.
     */
    const handleProgressEvent = (data) => {
        if (activeRequestId === null) return;
        const idx = findProgressIndex(activeRequestId);
        if (idx < 0) return;
        const entry = thread[idx];
        const stages = entry.progress.stages;
        const target = stages.find((s) => s.stage === data.stage);
        if (!target) return;
        if (typeof data.label === 'string' && data.label.length > 0) {
            target.label = data.label;
        }
        if (data.status === 'started') {
            target.status = 'active';
        } else if (data.status === 'completed') {
            target.status = 'done';
        }
        renderThread();
    };

    const renderFatalError = (code) => {
        setStatus('Briefing unavailable.', 'error');
        // Drop any in-flight placeholder (progress or thinking) for
        // this turn so the error bubble takes its place rather than
        // appending below a half-finished spinner.
        const idx = activeRequestId !== null ? findInflightIndex(activeRequestId) : -1;
        if (idx >= 0) {
            thread.splice(idx, 1);
        }
        thread.push({ role: 'assistant', error: { code: code || 'briefing_failed' } });
        activeRequestId = null;
        renderThread();
    };

    /**
     * Format a past timestamp as an English relative-time phrase, used
     * for the §4.6 resume status line ("Resumed conversation from
     * 2h ago"). Bounded units: minutes for <1h, hours for <24h, days
     * beyond that. We deliberately don't reach for `Intl.RelativeTimeFormat`
     * — its phrasing varies by locale config and the resume status is
     * one short EHR-domain phrase, not a localized UI surface.
     */
    const formatRelativeTime = (isoString) => {
        const then = Date.parse(isoString);
        if (Number.isNaN(then)) return 'earlier';
        const deltaMs = Date.now() - then;
        if (deltaMs < 60_000) return 'just now';
        const minutes = Math.floor(deltaMs / 60_000);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    const handleEvent = (data) => {
        if (!data || typeof data !== 'object' || !data.type) return;
        switch (data.type) {
            case 'meta':
                // Agent-minted conversationId becomes authoritative for
                // follow-ups. On resume this matches what we already set;
                // on a fresh briefing this is the first time we see the
                // canonical UUID.
                if (typeof data.conversationId === 'string' && data.conversationId.length > 0) {
                    conversationId = data.conversationId;
                }
                setStatus('Streaming briefing…', 'streaming');
                break;
            case 'progress':
                handleProgressEvent(data);
                break;
            case 'assistantMessage':
                handleAssistantMessage(data);
                activeRequestId = null;
                break;
            case 'done':
                setStatus('Briefing ready.', 'ready');
                activeRequestId = null;
                break;
            case 'error':
                renderFatalError(data.code);
                break;
        }
    };

    /**
     * Parse SSE chunks from a streaming fetch response. Hono framing is
     * `event: <name>\ndata: <json>\n\n` (sometimes with a trailing `id:`
     * line); we only care about the data payload, which carries `type`.
     */
    const parseSseStream = async (response) => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const dataLine = rawEvent
                    .split('\n')
                    .find((line) => line.startsWith('data: '));
                if (!dataLine) continue;
                try {
                    handleEvent(JSON.parse(dataLine.slice('data: '.length)));
                } catch (err) {
                    // Malformed payloads should not blow up the renderer.
                    // The fatal error path catches a permanently broken
                    // stream below.
                    console.error('copilot: failed to parse SSE payload', err);
                }
            }
        }
    };

    /**
     * Open an SSE stream against the agent proxy and render its events
     * into the thread. Shared between the initial briefing and §4.5
     * free-text follow-ups — the only difference between the two is the
     * envelope (`task` and the optional `question`).
     *
     * Pushes an in-flight placeholder before opening the stream so the
     * doctor sees activity immediately: the full 4-stage progress
     * bubble for `default_briefing` (the doctor benefits from seeing
     * the agent's whole pipeline on the first turn), and a compact
     * "Thinking…" bubble for follow-ups (which run in seconds and
     * don't need stage granularity). The server still emits stage
     * progress for follow-ups; we route those events at the renderer
     * (handleProgressEvent filters on `entry.progress`) so they're a
     * no-op against a thinking bubble. `activeRequestId` keys
     * placeholder lookups, and the `assistantMessage` / `error` paths
     * replace either shape.
     */
    const streamTurn = async ({ envelope, errorTag }) => {
        activeRequestId = envelope.requestId;
        const placeholder = envelope.task === 'follow_up'
            ? newThinkingEntry(envelope.requestId)
            : newProgressEntry(envelope.requestId);
        thread.push(placeholder);
        renderThread();
        try {
            const response = await fetch(`${proxyUrl}?action=briefing&pid=${encodeURIComponent(pid)}`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(envelope),
            });
            if (!response.ok) {
                renderFatalError(`http_${response.status}`);
                return;
            }
            await parseSseStream(response);
        } catch (err) {
            console.error(`copilot: ${errorTag} stream failed`, err);
            renderFatalError('network_error');
        }
    };

    /**
     * POST a §4.5 follow-up turn. `composerBusy` blocks concurrent
     * submissions against the same conversation thread while the
     * previous stream is still open.
     */
    let composerBusy = false;
    const submitFollowUp = async (question) => {
        if (composerBusy) return;
        composerBusy = true;
        thread.push({ role: 'user', text: question });
        renderThread();
        setStatus('Asking…', 'streaming');
        try {
            await streamTurn({
                envelope: {
                    conversationId,
                    requestId: `req-${pid}-${Date.now()}`,
                    siteId,
                    patient: { pid, uuid: '' },
                    task: 'follow_up',
                    question,
                },
                errorTag: 'follow-up',
            });
        } finally {
            composerBusy = false;
        }
    };

    /**
     * §4.1 chip click. POSTs the typed follow-up params (no `question`
     * field — the agent's transitional bridge stringifies the params
     * into a question for the free-text path until §4.2/§4.3/§4.4
     * replace the bridge with UC-specific graph branches). The chip's
     * `displayText` enters the thread as the user-side bubble so the UI
     * reads as a normal turn.
     */
    const submitTypedFollowUp = async (suggestion) => {
        if (composerBusy) return;
        if (!suggestion || !suggestion.params) return;
        composerBusy = true;
        thread.push({ role: 'user', text: suggestion.displayText });
        renderThread();
        setStatus('Asking…', 'streaming');
        try {
            await streamTurn({
                envelope: {
                    conversationId,
                    requestId: `req-${pid}-${Date.now()}`,
                    siteId,
                    patient: { pid, uuid: '' },
                    task: 'follow_up',
                    followUp: suggestion.params,
                },
                errorTag: 'follow-up-chip',
            });
        } finally {
            composerBusy = false;
        }
    };

    const wireSuggestionsClicks = () => {
        if (!threadEl) return;
        threadEl.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            const chip = target.closest('[data-role="suggestion"]');
            if (!chip) return;
            const bubbleIdx = Number.parseInt(chip.dataset.bubble || '', 10);
            const sIdx = Number.parseInt(chip.dataset.suggestionIndex || '', 10);
            if (!Number.isInteger(bubbleIdx) || !Number.isInteger(sIdx)) return;
            const entry = thread[bubbleIdx];
            if (!entry || entry.role !== 'assistant' || !entry.message) return;
            const suggestion = (entry.message.suggestedFollowUps || [])[sIdx];
            if (!suggestion) return;
            submitTypedFollowUp(suggestion);
        });
    };

    /**
     * Source-chip popover.
     *
     * One shared <div> appended lazily to <body> on first chip click.
     * The popover renders from in-memory claim data only — no fetch —
     * so a chip click is instant. Content: claim category, claim
     * text (with ISO dates rewritten to a human form), the cited
     * source identity, and a "View full record" link that hits the
     * same OpenEMR page the chip used to navigate to. When no link
     * is mapped for the recordType the link is rendered disabled with
     * a tooltip explaining why.
     *
     * Dismiss triggers: outside click, Escape, page scroll, viewport
     * resize, or clicking another chip. Returning focus to the
     * triggering chip on close keeps keyboard users on track.
     */
    let popoverEl = null;
    let popoverChip = null;

    const titleCaseCategory = (category) => {
        if (typeof category !== 'string' || category.length === 0) return 'Source';
        return category
            .split('_')
            .map((part) => (part.length === 0 ? '' : part[0].toUpperCase() + part.slice(1)))
            .join(' ');
    };

    const ensurePopover = () => {
        if (popoverEl !== null) return popoverEl;
        const el = document.createElement('div');
        el.className = 'copilot-source-popover';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'false');
        el.setAttribute('tabindex', '-1');
        el.hidden = true;
        document.body.appendChild(el);
        popoverEl = el;
        return el;
    };

    const closePopover = () => {
        if (popoverEl === null || popoverEl.hidden) return;
        popoverEl.hidden = true;
        popoverEl.innerHTML = '';
        const chipToFocus = popoverChip;
        popoverChip = null;
        if (chipToFocus instanceof HTMLElement) {
            chipToFocus.focus();
        }
    };

    /**
     * Place the popover below the chip when there's room, above it
     * otherwise. Horizontal position is clamped to the viewport so
     * the popover never floats off-screen on narrow windows.
     */
    const positionPopover = (chip) => {
        if (popoverEl === null) return;
        const rect = chip.getBoundingClientRect();
        const popRect = popoverEl.getBoundingClientRect();
        const margin = 8;
        const spaceBelow = window.innerHeight - rect.bottom;
        const placeAbove = spaceBelow < popRect.height + margin && rect.top > popRect.height + margin;
        const top = placeAbove
            ? rect.top - popRect.height - margin
            : rect.bottom + margin;
        const rawLeft = rect.left + rect.width / 2 - popRect.width / 2;
        const left = Math.max(
            margin,
            Math.min(window.innerWidth - popRect.width - margin, rawLeft),
        );
        popoverEl.style.top = `${top + window.scrollY}px`;
        popoverEl.style.left = `${left + window.scrollX}px`;
        popoverEl.dataset.placement = placeAbove ? 'above' : 'below';
    };

    /**
     * Popover body for the bubble-level "could not be verified" chip.
     * The agent does not ship the original prose for redacted segments
     * (fail-closed by design), so the body is a count + plain-English
     * explanation rather than a list of withheld claims.
     */
    const renderUnverifiedPopoverBody = (count) => {
        const heading = count === 1
            ? '1 statement was withheld'
            : `${count} statements were withheld`;
        return `<header class="copilot-source-popover__header">
                <span class="copilot-source-popover__category">Could not be verified</span>
                <button type="button" class="copilot-source-popover__close"
                        data-role="source-popover-close"
                        aria-label="Close">×</button>
            </header>
            <p class="copilot-source-popover__claim">${escapeText(heading)}</p>
            <p class="copilot-source-popover__record">The Co-Pilot drafted additional statements that could not be backed by a source in this chart, so they were withheld from the briefing. Open the chart to confirm anything you need.</p>`;
    };

    const openUnverifiedPopover = (chip, count) => {
        const el = ensurePopover();
        el.innerHTML = renderUnverifiedPopoverBody(count);
        el.hidden = false;
        popoverChip = chip;
        positionPopover(chip);
        window.requestAnimationFrame(() => {
            if (popoverEl !== null && !popoverEl.hidden) {
                popoverEl.focus();
            }
        });
    };

    const renderPopoverBody = (claim, ref) => {
        const category = titleCaseCategory(claim.category);
        const claimText = formatDatesInText(escapeText(claim.text || ''));
        const recordLine = escapeText(chipTooltipText(ref));
        const url = sourceLinkUrl(ref);
        const recordedAtRaw = ref && ref.meta !== undefined && ref.meta !== null
            ? ref.meta.record_recorded_at
            : undefined;
        const recordedAt = typeof recordedAtRaw === 'string' && recordedAtRaw.length > 0
            ? `<p class="copilot-source-popover__recorded">Recorded ${formatDatesInText(escapeText(recordedAtRaw))}</p>`
            : '';
        const linkRow = url
            ? `<a class="copilot-source-popover__link" href="${escapeText(url)}">View full record →</a>`
            : `<span class="copilot-source-popover__link copilot-source-popover__link--disabled"
                     title="${escapeText('No deep link available for this record type')}">No deep link available</span>`;
        return `<header class="copilot-source-popover__header">
                <span class="copilot-source-popover__category">${escapeText(category)}</span>
                <button type="button" class="copilot-source-popover__close"
                        data-role="source-popover-close"
                        aria-label="Close">×</button>
            </header>
            <p class="copilot-source-popover__claim">${claimText}</p>
            <p class="copilot-source-popover__record">${recordLine}</p>
            ${recordedAt}
            <div class="copilot-source-popover__footer">${linkRow}</div>`;
    };

    const openPopover = (chip, claim, ref) => {
        const el = ensurePopover();
        // Populate before measuring so getBoundingClientRect on the
        // popover reflects its real size.
        el.innerHTML = renderPopoverBody(claim, ref);
        el.hidden = false;
        popoverChip = chip;
        positionPopover(chip);
        // Defer focus to the next tick so screen readers settle
        // before we move focus into the dialog.
        window.requestAnimationFrame(() => {
            if (popoverEl !== null && !popoverEl.hidden) {
                popoverEl.focus();
            }
        });
    };

    const wireSourceChipClicks = () => {
        if (!threadEl) return;
        threadEl.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            const unverifiedChip = target.closest('[data-role="unverified-chip"]');
            if (unverifiedChip) {
                e.preventDefault();
                const count = Number.parseInt(unverifiedChip.dataset.count || '', 10);
                if (!Number.isInteger(count) || count <= 0) return;
                if (popoverChip === unverifiedChip && popoverEl !== null && !popoverEl.hidden) {
                    closePopover();
                    return;
                }
                openUnverifiedPopover(unverifiedChip, count);
                return;
            }
            const chip = target.closest('[data-role="source-chip"]');
            if (!chip) return;
            e.preventDefault();
            const bubbleIdx = Number.parseInt(chip.dataset.bubbleIdx || '', 10);
            const segmentIdx = Number.parseInt(chip.dataset.segmentIdx || '', 10);
            const claimIdx = Number.parseInt(chip.dataset.claimIdx || '', 10);
            const sourceIdx = Number.parseInt(chip.dataset.sourceIdx || '', 10);
            if (!Number.isInteger(bubbleIdx) || !Number.isInteger(segmentIdx)
                || !Number.isInteger(claimIdx) || !Number.isInteger(sourceIdx)) {
                return;
            }
            const entry = thread[bubbleIdx];
            if (!entry || entry.role !== 'assistant' || !entry.message) return;
            const segment = (entry.message.segments || [])[segmentIdx];
            if (!segment) return;
            const claim = (segment.claims || [])[claimIdx];
            if (!claim) return;
            const ref = (claim.sourceReferences || [])[sourceIdx];
            if (!ref) return;
            // Re-clicking the chip the popover is anchored to closes
            // it; clicking a different chip moves the popover there.
            if (popoverChip === chip && popoverEl !== null && !popoverEl.hidden) {
                closePopover();
                return;
            }
            openPopover(chip, claim, ref);
        });
        // The close button inside the popover lives outside the
        // thread's DOM subtree so we delegate from the popover itself.
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            if (target.closest('[data-role="source-popover-close"]')) {
                closePopover();
                return;
            }
            // Outside-click dismissal — but only if the popover is
            // open AND the click landed outside the popover and
            // outside any chip that owns it (chip clicks are handled
            // above).
            if (popoverEl === null || popoverEl.hidden) return;
            if (popoverEl.contains(target)) return;
            if (target.closest('[data-role="source-chip"]')) return;
            if (target.closest('[data-role="unverified-chip"]')) return;
            closePopover();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && popoverEl !== null && !popoverEl.hidden) {
                closePopover();
            }
        });
        // Scroll/resize repositioning would race with active layout;
        // simpler to dismiss so the popover doesn't float orphaned
        // mid-page after a scroll. {passive: true} avoids penalizing
        // scroll responsiveness.
        window.addEventListener('scroll', closePopover, { passive: true });
        window.addEventListener('resize', closePopover);
    };

    /**
     * Rewrite ISO `YYYY-MM-DD` dates inside an already-HTML-escaped
     * string into "March 15, 2024" form. Validates month 1–12 and
     * day 1–31 before reformatting so version strings like
     * "1234-56-78" pass through unchanged. Operates on text content
     * only — never invoked on URLs or HTML attribute values, since it
     * runs *after* `escapeText()` and is only spliced into element
     * bodies.
     *
     * Full ISO timestamps (`YYYY-MM-DDTHH:MM:SSZ`) are reformatted
     * whole — we feed the whole string to Date and render the date
     * portion in the same long form, dropping the time component.
     * Time-of-day in a clinical citation is rarely actionable for
     * the doctor and just adds noise.
     */
    const formatDatesInText = (html) => {
        if (typeof html !== 'string') return '';
        // Match ISO timestamp first (more specific) so the bare-date
        // pattern doesn't claim its prefix and leave the time tail
        // dangling. The non-capturing optional `T...` group makes
        // both shapes one expression with the same replacement
        // pipeline.
        const isoPattern = /\b(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g;
        return html.replace(isoPattern, (match, y, mo, d) => {
            const month = Number.parseInt(mo, 10);
            const day = Number.parseInt(d, 10);
            if (month < 1 || month > 12 || day < 1 || day > 31) return match;
            const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
            if (Number.isNaN(dt.getTime())) return match;
            try {
                return dt.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'UTC',
                });
            } catch (err) {
                return match;
            }
        });
    };

    const wireComposer = () => {
        const form = root.querySelector('[data-role="composer"]');
        if (!form) return;
        const input = form.querySelector('[data-role="input"]');
        const submit = form.querySelector('[data-role="submit"]');
        const setBusyUi = (busy) => {
            if (input) input.disabled = busy;
            if (submit) submit.disabled = busy;
        };
        // Enter submits; Shift+Enter inserts a newline. The IME-composing
        // guard (`isComposing`) is critical: without it, hitting Enter
        // to confirm a CJK candidate fires both an input commit and a
        // submit, sending an unintended message before the doctor
        // finishes typing. We don't bind to the form's submit event for
        // this — `requestSubmit()` triggers it, and the submit handler
        // below does the real work.
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                if (e.shiftKey) return;
                if (e.isComposing) return;
                e.preventDefault();
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit();
                } else {
                    // Older browsers without requestSubmit — synthesize
                    // a submit event so the existing handler still runs.
                    form.dispatchEvent(new Event('submit', { cancelable: true }));
                }
            });
        }
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!input) return;
            const question = String(input.value || '').trim();
            if (question.length === 0) return;
            input.value = '';
            setBusyUi(true);
            try {
                await submitFollowUp(question);
            } finally {
                setBusyUi(false);
                if (input) input.focus();
            }
        });
    };

    /**
     * §4.6: ask the agent for the most recent conversation on this
     * (clinician, patient) pair. Returns the parsed body on a 200,
     * `null` on a 404 (the documented "no resumable conversation"
     * signal), and `null` on any network/proxy failure — failed resume
     * is silently downgraded to "fresh briefing" so a transient blip
     * never blocks the panel from working.
     */
    const tryResume = async () => {
        try {
            const response = await fetch(
                `${proxyUrl}?action=latest_conversation&pid=${encodeURIComponent(pid)}`,
                {
                    method: 'GET',
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' },
                },
            );
            if (response.status === 404) return null;
            if (!response.ok) {
                console.warn('copilot: resume lookup failed', response.status);
                return null;
            }
            return await response.json();
        } catch (err) {
            console.warn('copilot: resume lookup errored', err);
            return null;
        }
    };

    /**
     * Hydrate `thread[]` from a resumed conversation payload. Assistant
     * turns keep their full AssistantMessage shape (segments + claims +
     * sources); user turns collapse to plain text. The order in which
     * the panel renders is the order the agent persisted, so we don't
     * need to sort here.
     */
    const hydrateFromResume = (payload) => {
        const items = Array.isArray(payload && payload.thread) ? payload.thread : [];
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item.role === 'assistant' && item.message) {
                thread.push({ role: 'assistant', message: item.message });
            } else if (item.role === 'user' && typeof item.text === 'string') {
                thread.push({ role: 'user', text: item.text });
            }
        }
        renderThread();
    };

    /**
     * §4.7 history sidebar.
     *
     * The sidebar lists this clinician's prior conversations on the
     * active patient, newest first, paged via an opaque cursor. Each
     * row shows a relative timestamp, a first-question snippet (or
     * "Briefing only" when the doc never asked a follow-up), and a
     * message-count badge. Clicking a row force-resumes that
     * conversation by re-hitting the resume endpoint with
     * `?conversation=<uuid>`; the agent verifies ownership server-side
     * before returning the thread, so a forged UUID in the DOM
     * cannot smuggle in another doctor's conversation.
     */
    const historyEl = root ? root.querySelector('[data-role="history-list"]') : null;
    const historyEmptyEl = root ? root.querySelector('[data-role="history-empty"]') : null;
    const historySentinelEl = root ? root.querySelector('[data-role="history-sentinel"]') : null;
    let historyNextBefore = null;
    let historyExhausted = false;
    let historyLoading = false;

    const truncateSnippet = (text, max = 80) => {
        if (typeof text !== 'string') return '';
        if (text.length <= max) return text;
        return text.slice(0, max - 1).trimEnd() + '…';
    };

    /**
     * Build a history row button. We use a <button> rather than a
     * <li>+click so keyboard activation (Enter/Space) and assistive
     * tech see the row as interactive. Wrapped in <li> for list
     * semantics.
     */
    const renderHistoryRow = (item) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copilot-history__row';
        button.dataset.convId = item.conversationId;

        const snippet = document.createElement('span');
        snippet.className = 'copilot-history__row-snippet';
        snippet.textContent = item.firstQuestion
            ? truncateSnippet(item.firstQuestion)
            : 'Briefing only';
        if (!item.firstQuestion) {
            snippet.style.fontStyle = 'italic';
            snippet.style.color = '#6b6e74';
        }

        const meta = document.createElement('span');
        meta.className = 'copilot-history__row-meta';
        const time = document.createElement('span');
        time.className = 'copilot-history__row-time';
        time.textContent = formatRelativeTime(item.updatedAt || '');
        const count = document.createElement('span');
        count.className = 'copilot-history__row-count';
        count.textContent = `${item.messageCount} ${item.messageCount === 1 ? 'turn' : 'turns'}`;
        meta.append(time, count);

        button.append(snippet, meta);
        button.addEventListener('click', () => {
            forceResume(item.conversationId).catch((err) => {
                console.warn('copilot: force-resume failed', err);
            });
        });
        li.append(button);
        return li;
    };

    const markActiveRow = (id) => {
        if (!historyEl) return;
        const rows = historyEl.querySelectorAll('.copilot-history__row');
        for (const row of rows) {
            row.dataset.active = row.dataset.convId === id ? 'true' : 'false';
        }
    };

    const refreshHistoryEmptyState = () => {
        if (!historyEl || !historyEmptyEl) return;
        const hasRows = historyEl.children.length > 0;
        historyEmptyEl.hidden = hasRows;
    };

    const loadHistoryPage = async () => {
        if (historyLoading || historyExhausted || !historyEl) return;
        historyLoading = true;
        try {
            const params = new URLSearchParams({
                action: 'conversation_history',
                pid: String(pid),
                limit: '50',
            });
            if (historyNextBefore) {
                params.set('before_updated_at', historyNextBefore.updatedAt);
                params.set('before_id', historyNextBefore.id);
            }
            const response = await fetch(`${proxyUrl}?${params.toString()}`, {
                method: 'GET',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) {
                console.warn('copilot: history fetch failed', response.status);
                historyExhausted = true;
                return;
            }
            const body = await response.json();
            const items = Array.isArray(body && body.items) ? body.items : [];
            for (const item of items) {
                if (!item || typeof item.conversationId !== 'string') continue;
                historyEl.append(renderHistoryRow(item));
            }
            historyNextBefore = body && body.nextBefore ? body.nextBefore : null;
            historyExhausted = historyNextBefore === null;
            if (historySentinelEl) {
                historySentinelEl.hidden = historyExhausted;
            }
            refreshHistoryEmptyState();
            // After a hydration, re-mark the row tied to the
            // currently-loaded conversation so the active highlight
            // survives infinite-scroll loads of older pages.
            markActiveRow(conversationId);
        } catch (err) {
            console.warn('copilot: history fetch errored', err);
            historyExhausted = true;
        } finally {
            historyLoading = false;
        }
    };

    /**
     * Force-resume: load a specific conversation by id (sidebar click).
     * Replaces the rendered thread, adopts the conversationId so
     * follow-ups append to that row, and updates the status line. On
     * any failure (forged id, ownership mismatch, network blip) we
     * leave the panel in its previous state — no destructive UI move.
     */
    const forceResume = async (id) => {
        const params = new URLSearchParams({
            action: 'latest_conversation',
            pid: String(pid),
            conversation: id,
        });
        const response = await fetch(`${proxyUrl}?${params.toString()}`, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            console.warn('copilot: force-resume rejected', response.status);
            return;
        }
        const payload = await response.json();
        if (!payload || typeof payload.conversationId !== 'string') return;
        conversationId = payload.conversationId;
        thread.length = 0;
        hydrateFromResume(payload);
        const relative = formatRelativeTime(payload.updatedAt || '');
        setStatus(`Resumed conversation from ${relative}.`, 'ready');
        markActiveRow(conversationId);
    };

    const wireHistoryInfiniteScroll = () => {
        if (!historySentinelEl || !historyEl) return;
        if (typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting && !historyLoading && !historyExhausted) {
                        loadHistoryPage().catch((err) => {
                            console.warn('copilot: pagination errored', err);
                        });
                    }
                }
            },
            { root: historyEl, rootMargin: '120px', threshold: 0 },
        );
        observer.observe(historySentinelEl);
    };

    const start = async () => {
        wireComposer();
        wireHistoryInfiniteScroll();
        wireSuggestionsClicks();
        wireSourceChipClicks();
        setStatus('Connecting to Co-Pilot…', 'connecting');

        // Resume lookup and history fetch are independent — fire them
        // in parallel so first paint shows both the resumed thread and
        // the populated sidebar.
        const [resumed] = await Promise.all([tryResume(), loadHistoryPage()]);
        if (resumed && typeof resumed.conversationId === 'string' && resumed.conversationId.length > 0) {
            conversationId = resumed.conversationId;
            hydrateFromResume(resumed);
            const relative = formatRelativeTime(resumed.updatedAt || '');
            setStatus(`Resumed conversation from ${relative}.`, 'ready');
            markActiveRow(conversationId);
            return;
        }

        await streamTurn({
            envelope: {
                conversationId,
                requestId,
                siteId,
                patient: { pid, uuid: '' },
                task: 'default_briefing',
            },
            errorTag: 'briefing',
        });
    };

    if (root) {
        start();
    }

    // Pure-function helpers — exported for `tests/js/copilot-panel-claim-groups.test.js`.
    // The browser ignores this object (the IIFE's return value is
    // assigned to `__copilotPanel` but never read in the page).
    return {
        sourceLinkUrl,
        chipTooltipText,
        claimGroupsToSections,
        recordTypeForChartField,
    };
})();

// CommonJS bridge for Jest. The browser-side `<script>` tag has no
// `module` global, so this branch is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = __copilotPanel;
}
