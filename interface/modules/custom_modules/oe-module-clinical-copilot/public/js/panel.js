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
     * Re-pin the OpenEMR session cookie to this tab's PHP-assigned
     * session ID before any same-origin fetch to the agent proxy.
     *
     * OpenEMR supports parallel logins per browser by allowing JS to
     * rewrite the session cookie (cookie_httponly is intentionally
     * false on the core session). When another tab in the same browser
     * mints a new session ID — common after a SMART OAuth round-trip,
     * a second login, or even an iframe reload — that new ID is what
     * `document.cookie` carries. Without `top.restoreSession()` first,
     * our `fetch()` sends the foreign session ID, lands on a session
     * with no `site_id` set, and `interface/globals.php` 400s with
     * "Site ID is missing from session data!". Every other AJAX
     * endpoint in the codebase calls `top.restoreSession()` before
     * posting (see `library/js/utility.js`, `ajtooltip.js`, etc.) —
     * we do the same.
     *
     * Defensive: `top` is reachable only when the panel iframe is
     * same-origin with `main_v2.php` (the standard mount path). If
     * `top.restoreSession` isn't available (e.g. opened standalone for
     * tests or in a way that breaks the chain), we skip silently —
     * the fetch may still succeed if the cookie happens to match.
     */
    const restoreTopSession = () => {
        try {
            if (typeof window !== 'undefined'
                && window.top
                && typeof window.top.restoreSession === 'function') {
                window.top.restoreSession();
            }
        } catch {
            // Cross-origin access throws on a sealed `top` reference;
            // a missing helper is benign — no-op and continue.
        }
    };

    const proxyFetch = (url, init) => {
        restoreTopSession();
        return fetch(url, init);
    };

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
     * The section order is fixed: documents → evidence. The
     * "What's in the chart" section the format node also emits is
     * deliberately *not* projected into the renderer — it duplicates
     * facts the doctor already gets from the inline-prose chart
     * citations and adds visual noise. The bucket still ships on the
     * wire (so the verifier and any future consumer keep working);
     * we just don't paint it. Inline chart `[source]` chips that link
     * to the OpenEMR record page (W1 carry-forward) are unchanged.
     *
     * Pure function — exported via the CommonJS guard at the bottom of
     * this file so the Jest tests in `tests/js/copilot-panel-claim-groups.test.js`
     * can pin its behavior without spinning up a DOM.
     */
    const SECTION_HEADINGS = {
        extractedDocument: 'From documents',
        recommendation: 'Recommendations',
        guideline: 'Evidence',
    };

    const claimGroupsToSections = (claimGroups) => {
        if (!claimGroups || typeof claimGroups !== 'object') return [];
        const sections = [];
        if (claimGroups.extractedDocument && Array.isArray(claimGroups.extractedDocument.cards)) {
            sections.push({
                kind: 'extractedDocument',
                heading: SECTION_HEADINGS.extractedDocument,
                cards: claimGroups.extractedDocument.cards,
            });
        }
        if (claimGroups.recommendation && Array.isArray(claimGroups.recommendation.claims)) {
            sections.push({
                kind: 'recommendation',
                heading: SECTION_HEADINGS.recommendation,
                claims: claimGroups.recommendation.claims,
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
     *   - extracted_document → button with the viewer args encoded on
     *     `data-*` attributes; the click handler in
     *     `wireSourceChipClicks` opens the F.4 side-by-side document
     *     viewer for the cited document/page/bbox. Section chips
     *     don't carry the bubble/segment/claim indices the inline
     *     chips use, so we embed `(documentUuid, page, bbox, mime)`
     *     directly on the chip's data-* attributes — viewerArgsFromSource
     *     would need a thread lookup we don't have here.
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
        if (source.source_type === 'extracted_document') {
            const args = viewerArgsFromSource(source);
            if (args !== null) {
                // The chip becomes a real <button>: same look as the
                // inert variant, but `data-role="section-document-chip"`
                // routes through the click handler that opens the
                // viewer pane. data-* attributes carry the viewer args
                // so the handler doesn't need to look up the source
                // reference from `thread[]`.
                const bboxAttr = Array.isArray(args.bbox) ? JSON.stringify(args.bbox) : '';
                return `<button type="button" class="copilot-source${variant}"
                                data-role="section-document-chip"
                                data-document-uuid="${escapeText(args.documentUuid)}"
                                data-page="${args.page !== null ? String(args.page) : ''}"
                                data-bbox="${escapeText(bboxAttr)}"
                                data-mime="${escapeText(args.mime || '')}"
                                title="${escapeText(tooltip)}"
                                aria-label="Source: ${escapeText(tooltip)}">[source]</button>`;
            }
        }
        if (source.source_type === 'guideline') {
            const card = guidelineCardFromSource(source);
            if (card !== null && (card.publication !== null || card.title !== null || card.url !== null)) {
                // Emit a clickable chip carrying the snippet metadata
                // on data-* attributes, so the click handler can build
                // the drawer card without a thread[] lookup. Mirrors
                // the section-document-chip pattern above.
                return `<button type="button" class="copilot-source${variant}"
                                data-role="section-guideline-chip"
                                data-publication="${escapeText(card.publication || '')}"
                                data-title="${escapeText(card.title || '')}"
                                data-year="${card.year !== null ? String(card.year) : ''}"
                                data-section="${escapeText(card.section || '')}"
                                data-url="${escapeText(card.url || '')}"
                                data-quote="${escapeText(card.quote || '')}"
                                title="${escapeText(tooltip)}"
                                aria-label="Source: ${escapeText(tooltip)}">[source]</button>`;
            }
        }
        return `<span class="copilot-source${variant} copilot-source--inert"
                      data-role="section-source-tooltip"
                      title="${escapeText(tooltip)}"
                      aria-label="Source: ${escapeText(tooltip)}">[source]</span>`;
    };

    /**
     * F.5a — map a claim's verifier `category` to the `factType` the
     * `accept_fact` route expects on its body. Mostly 1:1; `diagnosis`
     * claims from extracted documents map to `past_medical_history`
     * (since both ride the same chart-side widget). F.5e adds the
     * dedicated `family_history` slot to `ClaimCategory`, so the
     * synthesizer can now disambiguate hereditary-history claims from
     * the patient's own past-medical-history — those map straight to
     * `family_history`. Returns `null` for categories the panel does
     * not promote (identity, appointment, encounter, etc.) — callers
     * skip the action-button render in that case.
     */
    const factTypeForClaimCategory = (category) => {
        switch (category) {
            case 'lab':
                return 'lab';
            case 'allergy':
                return 'allergy';
            case 'medication_statement':
                return 'medication_statement';
            case 'diagnosis':
                return 'past_medical_history';
            case 'family_history':
                return 'family_history';
            default:
                return null;
        }
    };

    /**
     * F.5a — pull the `(artifactId, fieldPath)` pair off the claim's
     * primary `extracted_document` source reference. The agent emits
     * the artifactId as `source_id` and the in-artifact path as
     * `locator.field`; both are required by the `accept_fact` body.
     * Returns `null` when the claim has no extracted_document
     * primary, in which case the action buttons don't render.
     */
    const docPromotionTargetForClaim = (claim) => {
        if (!claim) return null;
        const refs = Array.isArray(claim.sourceReferences) ? claim.sourceReferences : [];
        const primary = refs.find((r) => r && r.source_type === 'extracted_document');
        if (!primary) return null;
        const artifactId = typeof primary.source_id === 'string' ? primary.source_id : '';
        const fieldPath = primary.locator && typeof primary.locator.field === 'string'
            ? primary.locator.field
            : '';
        if (artifactId.length === 0 || fieldPath.length === 0) return null;
        const factType = factTypeForClaimCategory(claim.category);
        if (factType === null) return null;
        return { artifactId, fieldPath, factType };
    };

    /**
     * F.5a — accept/reject button group rendered inline-right of each
     * extracted-document fact. The two buttons carry the data-* attrs
     * the click handler needs to POST `?action=accept_fact` (chart
     * write + disposition round-trip) or `/v1/agent/dispositions`
     * (reject; disposition only). Per F.0 the layout is inline-right
     * + ephemeral toast + animated chip swap, so the buttons themselves
     * are unstyled-by-default and the click handler owns the post-
     * submit class shuffling.
     */
    const renderFactActions = (target) => {
        if (target === null) return '';
        return `<span class="copilot-fact-actions" data-role="fact-actions"
                       data-artifact-id="${escapeText(target.artifactId)}"
                       data-field-path="${escapeText(target.fieldPath)}"
                       data-fact-type="${escapeText(target.factType)}">
            <button type="button" class="copilot-fact-actions__btn copilot-fact-actions__btn--accept"
                    data-role="fact-accept">Accept</button>
            <button type="button" class="copilot-fact-actions__btn copilot-fact-actions__btn--reject"
                    data-role="fact-reject">Reject</button>
        </span>`;
    };

    const renderClaimWithChips = (claim, options = {}) => {
        const text = formatDatesInText(escapeText(claim.text || ''));
        const refs = Array.isArray(claim.sourceReferences) ? claim.sourceReferences : [];
        const chips = refs.map((ref) => renderSectionChip(ref)).join(' ');
        const actions = options.withActions === true
            ? renderFactActions(docPromotionTargetForClaim(claim))
            : '';
        return `<li class="copilot-claim-groups__claim">${text}${chips ? ' ' + chips : ''}${actions}</li>`;
    };

    const renderDocumentCard = (card) => {
        const uuidLabel = typeof card.documentUuid === 'string' && card.documentUuid.length > 0
            ? `Document ${escapeText(card.documentUuid.slice(0, 8))}`
            : 'Document';
        const claims = (card.claims || [])
            .map((claim) => renderClaimWithChips(claim, { withActions: true }))
            .join('');
        return `<section class="copilot-claim-groups__doc-card"
                         data-document-uuid="${escapeText(card.documentUuid || '')}">
            <h4 class="copilot-claim-groups__subheading">${uuidLabel}</h4>
            <ul class="copilot-claim-groups__list">${claims}</ul>
        </section>`;
    };

    /**
     * Trend-chart renderer.
     *
     * Renders the optional `trendChart` slot on an assistant message as
     * an inline SVG line chart (one per bubble — the wire shape is a
     * single value, not an array, so the "single chart" cap is
     * structural).
     *
     * Why hand-rolled SVG instead of Chart.js / D3:
     *
     *   - Zero new asset: no script tag, no CDN, no version bump.
     *   - Pure-string output: testable from node alongside the other
     *     pure helpers in this file (jest tests `require()` panel.js).
     *   - No instance lifecycle to manage when the bubble re-renders
     *     (the panel re-paints the whole thread on each event); a
     *     library would need teardown/destroy plumbing on every paint.
     *   - The chart is intentionally simple: a single line over time,
     *     up to 24 points, optional reference-range band. A 200-line
     *     SVG generator is the right shape for it.
     *
     * If we later need axes-with-labels, hover tooltips, or
     * multi-series overlays, swapping this for Chart.js is a self-
     * contained change — the wire contract (`AssistantMessageTrendChart`)
     * is renderer-agnostic.
     */

    const TREND_CHART_WIDTH = 480;
    const TREND_CHART_HEIGHT = 160;
    const TREND_CHART_PAD = { top: 16, right: 16, bottom: 28, left: 40 };

    /**
     * SVG-attribute escaper. The DOM-touching `escapeText` above uses
     * `document.createElement` (browser-only); the chart renderer runs
     * inside the same browser-only `renderBubble` call but its output
     * is also exercised from node by `tests/js/copilot-panel-trend-chart.test.js`,
     * which has no DOM. This escape covers the five XML-special chars
     * that matter for SVG attributes and text content; the chart never
     * embeds untrusted HTML, so this minimal set is sufficient.
     */
    const escapeSvg = (s) => {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    /**
     * Format an ISO-8601 timestamp as a short date label for the chart
     * x-axis (`Jan 14`, `Mar '24` for cross-year ranges). Falls back to
     * the first 10 chars of the input if `Date` parsing fails so a
     * malformed observedAt doesn't blank the axis.
     */
    const formatTrendDate = (iso, includeYear) => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return typeof iso === 'string' ? iso.slice(0, 10) : '';
        }
        const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
        const day = d.getUTCDate();
        if (includeYear) {
            // Two-digit year keeps the label compact.
            const yy = String(d.getUTCFullYear()).slice(-2);
            return `${month} '${yy}`;
        }
        return `${month} ${String(day)}`;
    };

    /**
     * Parse a reference-range string like "<5.7" / ">100" / "70-180"
     * into a numeric band the renderer can shade behind the line. Returns
     * null when the format isn't one of the three the lab adapter emits
     * — falling through is the right default so an unparsable range
     * doesn't put a misleading band on the chart. The chart still renders
     * the line; only the band overlay is suppressed.
     */
    const parseTrendRange = (raw) => {
        if (typeof raw !== 'string') return null;
        const s = raw.trim();
        if (s === '') return null;
        const ltMatch = s.match(/^<\s*(-?\d+(?:\.\d+)?)$/);
        if (ltMatch) {
            const hi = Number(ltMatch[1]);
            if (Number.isFinite(hi)) return { lo: -Infinity, hi };
        }
        const gtMatch = s.match(/^>\s*(-?\d+(?:\.\d+)?)$/);
        if (gtMatch) {
            const lo = Number(gtMatch[1]);
            if (Number.isFinite(lo)) return { lo, hi: Infinity };
        }
        const rangeMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/);
        if (rangeMatch) {
            const lo = Number(rangeMatch[1]);
            const hi = Number(rangeMatch[2]);
            if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
                return { lo, hi };
            }
        }
        return null;
    };

    /**
     * Project the chart data into pixel coordinates and emit the SVG
     * string. Pure (no DOM) — the caller embeds the result in the
     * bubble HTML. The body assumes the contract guaranteed by
     * `decideTrendChart` server-side: ≥2 numeric points, all with a
     * non-empty `observedAt`, sorted ascending.
     */
    const renderTrendChartSvg = (chart) => {
        const points = Array.isArray(chart.points) ? chart.points : [];
        if (points.length < 2) return '';

        const xs = points.map((p) => {
            const t = Date.parse(p.observedAt);
            return Number.isFinite(t) ? t : 0;
        });
        const ys = points.map((p) => Number(p.value));
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const xSpan = xMax - xMin || 1;

        const range = parseTrendRange(chart.referenceRange);
        // Pad the y-axis so the line never touches the chart edges.
        // Include any finite range bound so the band is fully visible.
        const yCandidates = ys.slice();
        if (range !== null) {
            if (Number.isFinite(range.lo)) yCandidates.push(range.lo);
            if (Number.isFinite(range.hi)) yCandidates.push(range.hi);
        }
        const yMinRaw = Math.min(...yCandidates);
        const yMaxRaw = Math.max(...yCandidates);
        const ySpanRaw = yMaxRaw - yMinRaw || Math.max(Math.abs(yMaxRaw), 1) * 0.1;
        const yPad = ySpanRaw * 0.12;
        const yMin = yMinRaw - yPad;
        const yMax = yMaxRaw + yPad;
        const ySpan = yMax - yMin || 1;

        const W = TREND_CHART_WIDTH;
        const H = TREND_CHART_HEIGHT;
        const P = TREND_CHART_PAD;
        const plotW = W - P.left - P.right;
        const plotH = H - P.top - P.bottom;

        const xPx = (x) => P.left + ((x - xMin) / xSpan) * plotW;
        const yPx = (y) => P.top + (1 - (y - yMin) / ySpan) * plotH;

        // Range band — clamp infinite bounds to the chart edges so a
        // "<5.7" range still paints a visible "normal" zone above the
        // x-axis.
        let bandSvg = '';
        if (range !== null) {
            const bandHi = Number.isFinite(range.hi) ? Math.min(range.hi, yMax) : yMax;
            const bandLo = Number.isFinite(range.lo) ? Math.max(range.lo, yMin) : yMin;
            if (bandHi > bandLo) {
                const yTop = yPx(bandHi);
                const yBottom = yPx(bandLo);
                bandSvg = `<rect class="copilot-trend__band"
                                 x="${String(P.left)}"
                                 y="${String(yTop)}"
                                 width="${String(plotW)}"
                                 height="${String(yBottom - yTop)}"
                                 data-role="trend-band"></rect>`;
            }
        }

        // Path for the line.
        const linePath = points
            .map((p, i) => {
                const cmd = i === 0 ? 'M' : 'L';
                return `${cmd}${String(xPx(xs[i]))},${String(yPx(ys[i]))}`;
            })
            .join(' ');

        // Dots for each observation. `abnormal` flips a CSS modifier
        // class so the renderer styles out-of-range points distinctly
        // without re-parsing the reference range here.
        const dots = points
            .map((p, i) => {
                const cls = p.abnormal
                    ? 'copilot-trend__dot copilot-trend__dot--abnormal'
                    : 'copilot-trend__dot';
                return `<circle class="${cls}"
                                cx="${String(xPx(xs[i]))}"
                                cy="${String(yPx(ys[i]))}"
                                r="3.5"
                                data-role="trend-dot"
                                data-value="${escapeSvg(String(p.value))}"
                                data-observed-at="${escapeSvg(p.observedAt)}">
                            <title>${escapeSvg(String(p.value))}${chart.unit ? ' ' + escapeSvg(chart.unit) : ''} on ${escapeSvg(p.observedAt.slice(0, 10))}</title>
                        </circle>`;
            })
            .join('');

        // Y-axis: just the min and max labels — keeps the chart tidy
        // inside a chat bubble. The dot tooltips carry the precise
        // values per point.
        const yLabel = (val) => {
            const rounded = Math.abs(val) >= 100 ? Math.round(val) : Math.round(val * 10) / 10;
            return String(rounded);
        };
        const yAxis = `
            <text class="copilot-trend__axis-label"
                  x="${String(P.left - 6)}"
                  y="${String(yPx(yMaxRaw))}"
                  text-anchor="end"
                  dominant-baseline="middle">${escapeSvg(yLabel(yMaxRaw))}</text>
            <text class="copilot-trend__axis-label"
                  x="${String(P.left - 6)}"
                  y="${String(yPx(yMinRaw))}"
                  text-anchor="end"
                  dominant-baseline="middle">${escapeSvg(yLabel(yMinRaw))}</text>`;

        // X-axis: first and last point dates only. If the series spans
        // multiple calendar years, switch to the year-tagged label so
        // the reader sees the time scale.
        const firstYear = new Date(points[0].observedAt).getUTCFullYear();
        const lastYear = new Date(points[points.length - 1].observedAt).getUTCFullYear();
        const includeYear = Number.isFinite(firstYear)
            && Number.isFinite(lastYear)
            && firstYear !== lastYear;
        const xAxis = `
            <text class="copilot-trend__axis-label"
                  x="${String(P.left)}"
                  y="${String(H - 8)}"
                  text-anchor="start">${escapeSvg(formatTrendDate(points[0].observedAt, includeYear))}</text>
            <text class="copilot-trend__axis-label"
                  x="${String(W - P.right)}"
                  y="${String(H - 8)}"
                  text-anchor="end">${escapeSvg(formatTrendDate(points[points.length - 1].observedAt, includeYear))}</text>`;

        return `<svg class="copilot-trend__svg"
                     viewBox="0 0 ${String(W)} ${String(H)}"
                     role="img"
                     aria-label="${escapeSvg(chart.analyte)} trend"
                     data-role="trend-svg">
            ${bandSvg}
            <path class="copilot-trend__line" d="${linePath}" data-role="trend-line"></path>
            ${dots}
            ${yAxis}
            ${xAxis}
        </svg>`;
    };

    /**
     * Caption above the chart. Reason-driven so the user sees *why*
     * the chart is here (and we don't ship a chart with no context).
     * `follow_up_lab_question` covers both trend-style ("How is A1c
     * trending?") and plain-lookup ("What's her A1c?") questions, so
     * "history" reads naturally for both — the chart is showing the
     * patient's recorded values for that analyte regardless of how
     * the doctor phrased the question.
     */
    const trendChartCaption = (chart) => {
        const analyte = String(chart.analyte || '');
        const unit = chart.unit ? ` (${chart.unit})` : '';
        if (chart.reason === 'fresh_lab_with_history') {
            return `${analyte}${unit} — new value in context`;
        }
        return `${analyte}${unit} — recent values`;
    };

    const renderTrendChart = (chart) => {
        if (!chart || typeof chart !== 'object') return '';
        const points = Array.isArray(chart.points) ? chart.points : [];
        if (points.length < 2) return '';
        const svg = renderTrendChartSvg(chart);
        if (svg === '') return '';
        const caption = trendChartCaption(chart);
        return `<figure class="copilot-trend"
                       data-role="trend-chart"
                       data-reason="${escapeSvg(chart.reason || '')}">
            <figcaption class="copilot-trend__caption">${escapeSvg(caption)}</figcaption>
            ${svg}
        </figure>`;
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
            if (section.kind === 'extractedDocument') {
                body = section.cards.map(renderDocumentCard).join('');
            } else if (section.kind === 'guideline' || section.kind === 'recommendation') {
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
     * §D.1 typed messages for `pipeline.error` SSE frames. Keys mirror
     * the `PipelineErrorCode` union in `agent/src/pipeline/state.ts` plus
     * the failure modes in the D.1 plan checkbox. Anything unrecognized
     * falls through to a generic "extraction failed" so an unknown code
     * never leaks raw to the user.
     */
    const PIPELINE_ERROR_MESSAGES = {
        'cost-cap-exceeded':
            'Document too large for automatic extraction.',
        patient_mismatch:
            'This document does not appear to belong to this patient.',
        schema_invalid:
            'Could not extract structured data from this document.',
        rasterize_failed:
            'Could not read the document. Please try a different file.',
        'storage-unreachable':
            'Document storage is temporarily unavailable. Please try again in a moment.',
        'rate-limited':
            'The extraction service is busy right now. Please try again in a moment.',
        persist_failed:
            'Document was extracted but could not be saved. Please try again.',
        pipeline_failed:
            'Document extraction failed. Please try again, and ask an administrator to check the agent service if the problem persists.',
    };

    const messageForPipelineCode = (code) =>
        PIPELINE_ERROR_MESSAGES[code] || PIPELINE_ERROR_MESSAGES.pipeline_failed;

    /**
     * §D.1 typed messages for browser-side upload failures (the network
     * round-trip to `document_upload.php`, before the pipeline ever
     * runs). Keyed off the JSON `error` body the controller emits in
     * `DocumentUploadController.php`.
     */
    const UPLOAD_ERROR_MESSAGES = {
        file_too_large: 'File is too large. Please choose a file under 10 MB.',
        unsupported_media_type: 'Unsupported file type. Use PDF, PNG, JPEG, or TIFF.',
        missing_pid: 'No active patient. Please reload the chart and try again.',
        missing_file: 'No file was selected.',
        upload_unavailable:
            'Could not upload the file. Please try again, and ask an administrator to check the agent service if the problem persists.',
        acl_denied: 'You do not have permission to upload documents.',
    };

    const messageForUploadCode = (code) =>
        UPLOAD_ERROR_MESSAGES[code] || UPLOAD_ERROR_MESSAGES.upload_unavailable;

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
            const narration = entry.narration
                ? `<p class="copilot-narration" data-role="narration">${escapeText(entry.narration)}</p>`
                : '';
            return `<article class="copilot-bubble copilot-bubble--assistant copilot-bubble--progress"
                             data-role="bubble" data-state="progress">
                ${narration}
                <ol class="copilot-progress" role="status" aria-live="polite">${stages}</ol>
            </article>`;
        }
        if (entry.role === 'assistant' && entry.thinking) {
            // The supervisor's narration ("Pulling prior lipid panels
            // to compare.") replaces the static "Thinking" caption
            // when present so the doctor sees the agent's actual
            // intent for this step. The animated dots stay regardless
            // — they're the "still working" affordance.
            const label = entry.narration
                ? escapeText(entry.narration)
                : 'Thinking';
            return `<article class="copilot-bubble copilot-bubble--assistant copilot-bubble--thinking"
                             data-role="bubble" data-state="thinking">
                <span class="copilot-thinking" role="status" aria-live="polite">
                    <span class="copilot-thinking__label">${label}</span>
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
            const trendChart = renderTrendChart(entry.message.trendChart);
            return `<article class="copilot-bubble copilot-bubble--assistant" data-role="bubble" data-state="rendered" data-bubble-index="${index}">
                ${gaps}
                <div class="copilot-bubble__body">${segments}${unverified ? ' ' + unverified : ''}</div>
                ${trendChart}
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

    /**
     * §D.1 status-line text for pipeline progress frames. The
     * `pipeline.*` events are emitted by the B.8 agent route; the
     * panel's job is to keep the doctor oriented while the extraction
     * runs. Map keys deliberately match the dotted SSE `type` from
     * the plan so a future stage rename is one entry, not a search.
     */
    const PIPELINE_STATUS_TEXT = {
        'pipeline.start': 'Extracting document…',
        'pipeline.rasterize.complete': 'Reading the document…',
        'pipeline.vision.complete': 'Document evidence available, drafting briefing…',
        'pipeline.persist.complete': 'Document evidence available, drafting briefing…',
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
            case 'supervisorNarration':
                // Model-decided one-sentence description of what the
                // supervisor is about to do (e.g. "Pulling prior lipid
                // panels to compare."). Two surfaces:
                //   1. The in-flight bubble's caption — the doctor's
                //      actual line of sight during a turn — so the
                //      static "Thinking" placeholder is replaced with
                //      the agent's real next step. We patch the
                //      bubble for the active request and re-render.
                //   2. The panel header's status subtitle, as a
                //      secondary affordance for screen-readers /
                //      moments when the bubble has scrolled.
                if (typeof data.text === 'string' && data.text.length > 0) {
                    if (activeRequestId !== null) {
                        const idx = findInflightIndex(activeRequestId);
                        if (idx >= 0) {
                            thread[idx] = { ...thread[idx], narration: data.text };
                            renderThread();
                        }
                    }
                    setStatus(data.text, 'streaming');
                }
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
            case 'pipelineEvent':
                // Agent-side wrapping introduced when the supervisor
                // owns the upload flow: the briefing runner forwards
                // pipeline events through `{type:'pipelineEvent',
                // event:{...}}` so the wire vocabulary doesn't collide
                // with conversation-level events. Unwrap and re-dispatch
                // through the same switch — but mark `wrappedBySupervisor`
                // on the inner event so handlers know the supervisor is
                // in the loop and will narrate the failure inside the
                // chat bubble. That avoids duplicating a `pipeline.error`
                // into both a toast AND the assistant turn's narration.
                if (data.event && typeof data.event === 'object') {
                    handleEvent({ ...data.event, wrappedBySupervisor: true });
                }
                break;
            case 'pipeline.start':
            case 'pipeline.rasterize.complete':
            case 'pipeline.vision.complete':
            case 'pipeline.persist.complete':
                setStatus(PIPELINE_STATUS_TEXT[data.type], 'streaming');
                break;
            case 'pipeline.exit':
                // The pipeline finished; the supervisor's next step
                // (drafting the briefing) keeps the conversation
                // streaming, so we don't clear the status here — the
                // existing `progress` / `done` frames take over.
                break;
            case 'pipeline.error':
                // On the legacy autosweep / extract.php path the toast
                // is the only failure surface. On the supervisor-driven
                // panel path the supervisor synthesizes a narrated
                // assistant turn that names the failure mode honestly,
                // so the toast becomes a confusing duplicate. Suppress
                // it when the event was unwrapped from a `pipelineEvent`
                // frame.
                if (!data.wrappedBySupervisor) {
                    showUploadToast(messageForPipelineCode(data.code));
                }
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
            const response = await proxyFetch(`${proxyUrl}?action=briefing&pid=${encodeURIComponent(pid)}`, {
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
     * Suggested-follow-up chip click. Posts the chip's `displayText` as
     * the `question` field so a tapped chip is identical on the wire to
     * a typed question — the agent sees one shape, not two.
     */
    const submitTypedFollowUp = async (suggestion) => {
        if (composerBusy) return;
        if (!suggestion || typeof suggestion.displayText !== 'string' || suggestion.displayText.length === 0) return;
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
                    question: suggestion.displayText,
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

    /**
     * F.4 — side-by-side document viewer state.
     *
     * The viewer pane is a sibling `<aside>` of `.copilot-main` in the
     * panel template, hidden by default. On the first extracted_document
     * chip click we un-hide the pane and call
     * `documentViewer.openDocument(...)` to mount the rendered document.
     * Subsequent clicks on a different extracted_document chip swap the
     * document/page/bbox in place by calling `openDocument` again
     * against the same mount element. Clicks on a non-extracted chip,
     * the close button, or Escape close the pane and clear the mount.
     *
     * The viewer module is loaded as a separate `<script>` tag in
     * `panel.html.twig` and exposes itself via the global
     * `__copilotDocumentViewer`. We resolve the global lazily so the
     * panel JS can be required from node tests (where the global is
     * absent) without throwing at module init.
     */
    let viewerPaneEl = null;
    let viewerMountEl = null;
    let viewerCloseEl = null;
    let viewerActiveChip = null;
    let viewerScrimEl = null;

    const documentViewerImpl = () => {
        if (typeof globalThis === 'undefined') return null;
        const impl = globalThis.__copilotDocumentViewer;
        return (impl !== undefined && impl !== null) ? impl : null;
    };

    const documentViewUrlBase = () => {
        if (root === null) return null;
        const url = root.dataset.documentViewUrl;
        return (typeof url === 'string' && url.length > 0) ? url : null;
    };

    const ensureViewerEls = () => {
        if (root === null) return null;
        if (viewerPaneEl !== null) return viewerPaneEl;
        viewerPaneEl = root.querySelector('[data-role="document-viewer-pane"]');
        viewerMountEl = root.querySelector('[data-role="document-viewer"]');
        viewerCloseEl = root.querySelector('[data-role="document-viewer-close"]');
        return viewerPaneEl;
    };

    /**
     * Lazily create the scrim element on first viewer open. The scrim
     * sits behind the drawer and dims the rest of the panel; clicking
     * it closes the drawer. Created lazily (rather than baked into
     * the template) so panels that never open the viewer don't
     * render an unused element.
     */
    const ensureViewerScrim = () => {
        if (viewerScrimEl !== null) return viewerScrimEl;
        if (root === null) return null;
        const el = root.ownerDocument.createElement('div');
        el.className = 'copilot-doc-viewer-scrim';
        el.dataset.role = 'document-viewer-scrim';
        el.hidden = true;
        el.addEventListener('click', () => closeDocumentViewer());
        root.ownerDocument.body.appendChild(el);
        viewerScrimEl = el;
        return el;
    };

    /**
     * Close the drawer with a slide-out + scrim-fade animation.
     * Removes the `--open` modifier classes (which run the CSS
     * transitions in reverse), then re-applies `hidden` on
     * `transitionend` so the drawer can't intercept clicks while it
     * is animating away.
     */
    const closeDocumentViewer = () => {
        if (viewerPaneEl === null) return;
        const impl = documentViewerImpl();
        if (impl !== null && viewerMountEl !== null) {
            impl.closeViewer(viewerMountEl);
        }
        viewerActiveChip = null;
        viewerPaneEl.classList.remove('copilot-doc-viewer--open');
        if (viewerScrimEl !== null) {
            viewerScrimEl.classList.remove('copilot-doc-viewer-scrim--open');
        }
        const onSlideOutDone = () => {
            viewerPaneEl.removeEventListener('transitionend', onSlideOutDone);
            viewerPaneEl.hidden = true;
            if (viewerScrimEl !== null) viewerScrimEl.hidden = true;
        };
        viewerPaneEl.addEventListener('transitionend', onSlideOutDone);
    };

    /**
     * Extract the (`documentUuid`, `page`, `bbox`, `mime`) tuple from
     * the source reference. The architecture's `SourceReference` shape
     * locks `meta.document_uuid` and `meta.mime_type` as the canonical
     * carriers; pipeline-side they're populated when the extraction
     * artifact is registered, so any extracted_document chip in the
     * panel either has them or the chip click cannot resolve to a
     * fetchable document. Returning null short-circuits the click.
     */
    const viewerArgsFromSource = (source) => {
        if (!source || source.source_type !== 'extracted_document') return null;
        const meta = (source.meta !== undefined && source.meta !== null) ? source.meta : {};
        const locator = (source.locator !== undefined && source.locator !== null) ? source.locator : {};
        const documentUuid = typeof meta.document_uuid === 'string' ? meta.document_uuid : null;
        if (documentUuid === null || documentUuid.length === 0) return null;
        const page = typeof locator.page === 'number' ? locator.page : null;
        const bbox = Array.isArray(locator.bbox) ? locator.bbox : null;
        const mime = typeof meta.mime_type === 'string' ? meta.mime_type : null;
        return { documentUuid, page, bbox, mime };
    };

    /**
     * Mount the side-by-side viewer for a `(documentUuid, page, bbox,
     * mime)` tuple. Both the inline-source-chip path and the section-
     * chip path land here — they each derive their own `args` shape
     * and hand it off; viewer state (active chip, pane visibility)
     * stays in this function.
     */
    const openDocumentWithArgs = (chip, args) => {
        if (root === null) return;
        if (ensureViewerEls() === null || viewerMountEl === null) return;
        const impl = documentViewerImpl();
        if (impl === null) return;
        const urlBase = documentViewUrlBase();
        if (urlBase === null) return;
        const scrim = ensureViewerScrim();
        viewerPaneEl.hidden = false;
        if (scrim !== null) scrim.hidden = false;
        viewerActiveChip = chip;
        // Add the `--open` modifier classes on the next frame so the
        // browser registers the initial `translateX(100%)` style
        // before transitioning to `translateX(0)`. Without the
        // requestAnimationFrame, the browser may collapse both into
        // a single frame and skip the animation.
        const win = root.ownerDocument.defaultView;
        win.requestAnimationFrame(() => {
            viewerPaneEl.classList.add('copilot-doc-viewer--open');
            if (scrim !== null) scrim.classList.add('copilot-doc-viewer-scrim--open');
        });
        // Fire-and-forget — the openDocument promise mounts the new
        // content; if it rejects, the placeholder card already inside
        // the mount communicates the failure to the user.
        impl.openDocument(viewerMountEl, { ...args, urlBase }).catch(() => {
            /* mount placeholder already rendered; no further action. */
        });
    };

    const openDocumentForChip = (chip, source) => {
        const args = viewerArgsFromSource(source);
        if (args === null) return;
        openDocumentWithArgs(chip, args);
    };

    const wireDocumentViewerControls = () => {
        if (root === null) return;
        if (ensureViewerEls() === null) return;
        if (viewerCloseEl !== null) {
            viewerCloseEl.addEventListener('click', (e) => {
                e.preventDefault();
                closeDocumentViewer();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (viewerPaneEl === null || viewerPaneEl.hidden) return;
            closeDocumentViewer();
        });
    };

    /**
     * Guideline source drawer. Same slide-in/scrim UX as the document
     * viewer above, but renders the cited evidence-corpus snippet
     * (publication, section, quote, link to publisher) directly from
     * the source ref's `meta` — no fetch needed because the verifier
     * already enriched the ref with the matched EvidenceSnippet's
     * metadata.
     *
     * State machine mirrors the document viewer: one shared pane,
     * lazily-created scrim, `viewerActiveChip`-style tracking so a
     * second click on the same chip closes the drawer.
     */
    let guidelinePaneEl = null;
    let guidelineMountEl = null;
    let guidelineCloseEl = null;
    let guidelineActiveChip = null;
    let guidelineScrimEl = null;

    const ensureGuidelineEls = () => {
        if (root === null) return null;
        if (guidelinePaneEl !== null) return guidelinePaneEl;
        guidelinePaneEl = root.querySelector('[data-role="guideline-viewer-pane"]');
        guidelineMountEl = root.querySelector('[data-role="guideline-viewer"]');
        guidelineCloseEl = root.querySelector('[data-role="guideline-viewer-close"]');
        return guidelinePaneEl;
    };

    const ensureGuidelineScrim = () => {
        if (guidelineScrimEl !== null) return guidelineScrimEl;
        if (root === null) return null;
        const el = root.ownerDocument.createElement('div');
        el.className = 'copilot-doc-viewer-scrim';
        el.dataset.role = 'guideline-viewer-scrim';
        el.hidden = true;
        el.addEventListener('click', () => closeGuidelineDrawer());
        root.ownerDocument.body.appendChild(el);
        guidelineScrimEl = el;
        return el;
    };

    const closeGuidelineDrawer = () => {
        if (guidelinePaneEl === null) return;
        if (guidelineMountEl !== null) {
            guidelineMountEl.innerHTML = '';
        }
        guidelineActiveChip = null;
        guidelinePaneEl.classList.remove('copilot-doc-viewer--open');
        if (guidelineScrimEl !== null) {
            guidelineScrimEl.classList.remove('copilot-doc-viewer-scrim--open');
        }
        const onSlideOutDone = () => {
            guidelinePaneEl.removeEventListener('transitionend', onSlideOutDone);
            guidelinePaneEl.hidden = true;
            if (guidelineScrimEl !== null) guidelineScrimEl.hidden = true;
        };
        guidelinePaneEl.addEventListener('transitionend', onSlideOutDone);
    };

    /**
     * Pull the renderable card fields off a guideline source reference.
     * The verifier copies `publication`, `title`, `year`, `section`,
     * and `url` from the matched EvidenceSnippet onto `meta`; section
     * chips encode the same fields directly on data-* attributes at
     * render time. Returns null when the ref isn't a guideline or
     * when the publication slot is missing (older snapshots before the
     * meta enrichment landed).
     */
    const guidelineCardFromSource = (source) => {
        if (!source || source.source_type !== 'guideline') return null;
        const meta = (source.meta !== undefined && source.meta !== null) ? source.meta : {};
        const locator = (source.locator !== undefined && source.locator !== null) ? source.locator : {};
        const publication = typeof meta.publication === 'string' ? meta.publication : null;
        const title = typeof meta.title === 'string' ? meta.title : null;
        const year = typeof meta.year === 'number' ? meta.year : null;
        const section = typeof meta.section === 'string'
            ? meta.section
            : (typeof locator.section === 'string' ? locator.section : null);
        const url = typeof meta.url === 'string' ? meta.url : null;
        const quote = typeof source.quote === 'string' ? source.quote : '';
        return { publication, title, year, section, url, quote };
    };

    /**
     * URL-safety filter for the publisher link. The agent's Zod
     * `meta.url` schema already restricts to valid URLs, but the panel
     * is the last hop before the click reaches the user's browser, so
     * we narrow further: only `http(s):` schemes are allowed to escape
     * into an `href`. Anything else (data:, javascript:, file:) collapses
     * to null and renders a "no link available" stub instead.
     */
    const safeGuidelineUrl = (url) => {
        if (typeof url !== 'string' || url.length === 0) return null;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
            return parsed.toString();
        } catch {
            return null;
        }
    };

    const renderGuidelineCard = (card, claimText) => {
        const publication = card.publication !== null && card.publication.length > 0
            ? `<span class="copilot-guideline-viewer__publication">${escapeText(card.publication)}${card.year !== null ? ` · ${escapeText(String(card.year))}` : ''}</span>`
            : '';
        const title = card.title !== null && card.title.length > 0
            ? `<h3 class="copilot-guideline-viewer__title">${escapeText(card.title)}</h3>`
            : '';
        const section = card.section !== null && card.section.length > 0
            ? `<p class="copilot-guideline-viewer__section">${escapeText(card.section)}</p>`
            : '';
        const url = safeGuidelineUrl(card.url);
        const linkRow = url !== null
            ? `<a class="copilot-guideline-viewer__link"
                  href="${escapeText(url)}"
                  target="_blank"
                  rel="noopener noreferrer">View on publisher →</a>`
            : `<span class="copilot-guideline-viewer__nolink"
                     title="No public link is associated with this source.">No public link available</span>`;
        const claimBlock = typeof claimText === 'string' && claimText.length > 0
            ? `<div class="copilot-guideline-viewer__claim-block">
                <p class="copilot-guideline-viewer__claim-label">Cited in this answer</p>
                <p class="copilot-guideline-viewer__claim">${formatDatesInText(escapeText(claimText))}</p>
            </div>`
            : '';
        const quote = card.quote.length > 0
            ? `<blockquote class="copilot-guideline-viewer__quote">${formatDatesInText(escapeText(card.quote))}</blockquote>`
            : '';
        return `<div class="copilot-guideline-viewer__body">
            <div class="copilot-guideline-viewer__header-block">
                ${publication}
                ${title}
                ${section}
            </div>
            ${quote}
            ${claimBlock}
            ${linkRow}
        </div>`;
    };

    const openGuidelineDrawer = (chip, card, claimText) => {
        if (root === null) return;
        if (ensureGuidelineEls() === null || guidelineMountEl === null) return;
        const scrim = ensureGuidelineScrim();
        guidelineMountEl.innerHTML = renderGuidelineCard(card, claimText);
        guidelinePaneEl.hidden = false;
        if (scrim !== null) scrim.hidden = false;
        guidelineActiveChip = chip;
        const win = root.ownerDocument.defaultView;
        win.requestAnimationFrame(() => {
            guidelinePaneEl.classList.add('copilot-doc-viewer--open');
            if (scrim !== null) scrim.classList.add('copilot-doc-viewer-scrim--open');
        });
    };

    const wireGuidelineViewerControls = () => {
        if (root === null) return;
        if (ensureGuidelineEls() === null) return;
        if (guidelineCloseEl !== null) {
            guidelineCloseEl.addEventListener('click', (e) => {
                e.preventDefault();
                closeGuidelineDrawer();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (guidelinePaneEl === null || guidelinePaneEl.hidden) return;
            closeGuidelineDrawer();
        });
    };

    /**
     * Decode a section-guideline-chip's data-* attributes into a card
     * shape. Section chips don't carry bubble/segment/claim indices,
     * so we encode publication / title / year / section / url / quote
     * on the chip at render time and rebuild the card here.
     */
    const sectionGuidelineCardArgs = (chip) => {
        const publication = typeof chip.dataset.publication === 'string' && chip.dataset.publication.length > 0
            ? chip.dataset.publication
            : null;
        const title = typeof chip.dataset.title === 'string' && chip.dataset.title.length > 0
            ? chip.dataset.title
            : null;
        const yearRaw = chip.dataset.year;
        const year = (typeof yearRaw === 'string' && yearRaw.length > 0)
            ? Number.parseInt(yearRaw, 10)
            : null;
        const section = typeof chip.dataset.section === 'string' && chip.dataset.section.length > 0
            ? chip.dataset.section
            : null;
        const url = typeof chip.dataset.url === 'string' && chip.dataset.url.length > 0
            ? chip.dataset.url
            : null;
        const quote = typeof chip.dataset.quote === 'string' ? chip.dataset.quote : '';
        return {
            publication,
            title,
            year: Number.isInteger(year) ? year : null,
            section,
            url,
            quote,
        };
    };

    /**
     * Decode a section-document-chip's data-* attributes back into the
     * shape `documentViewer.openDocument` expects. Section chips don't
     * carry the bubble/segment/claim indices the inline chips use, so
     * we encode the viewer args on the chip itself at render time and
     * read them back here. Returns null when any required attribute
     * is missing or malformed (a defensive parse for `data-bbox`'s
     * JSON contents).
     */
    const sectionChipViewerArgs = (chip) => {
        const documentUuid = chip.dataset.documentUuid;
        if (typeof documentUuid !== 'string' || documentUuid.length === 0) return null;
        const pageRaw = chip.dataset.page;
        const page = (typeof pageRaw === 'string' && pageRaw.length > 0)
            ? Number.parseInt(pageRaw, 10)
            : null;
        let bbox = null;
        const bboxRaw = chip.dataset.bbox;
        if (typeof bboxRaw === 'string' && bboxRaw.length > 0) {
            try {
                const parsed = JSON.parse(bboxRaw);
                if (Array.isArray(parsed) && parsed.length === 4
                    && parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
                    bbox = parsed;
                }
            } catch {
                bbox = null;
            }
        }
        const mime = typeof chip.dataset.mime === 'string' && chip.dataset.mime.length > 0
            ? chip.dataset.mime
            : null;
        return {
            documentUuid,
            page: Number.isInteger(page) ? page : null,
            bbox,
            mime,
        };
    };

    const wireSourceChipClicks = () => {
        if (!threadEl) return;
        threadEl.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            // F.5a accept/reject buttons. Render-side puts them on each
            // extracted-document fact in the "From documents" section;
            // we delegate from `threadEl` so a click on the button (or
            // its child) routes through the same listener as the chip
            // clicks below. Order matters: this must run BEFORE the
            // chip dispatch — neither button is a chip, so they would
            // fall through, but the explicit check is cheaper than a
            // closest() chain that hits nothing.
            const acceptBtn = target.closest('[data-role="fact-accept"]');
            if (acceptBtn) {
                e.preventDefault();
                handleFactAccept(acceptBtn);
                return;
            }
            const rejectBtn = target.closest('[data-role="fact-reject"]');
            if (rejectBtn) {
                e.preventDefault();
                handleFactReject(rejectBtn);
                return;
            }
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
            // Section-chip dispatch (the "From documents" / "Evidence"
            // chips in the rolled-up section, distinct from the inline-
            // prose chips handled below). For an extracted_document
            // section chip, the viewer args are encoded on the chip's
            // data-* attributes at render time, so we don't need to
            // resolve a SourceReference from `thread[]` here.
            const sectionDocChip = target.closest('[data-role="section-document-chip"]');
            if (sectionDocChip) {
                e.preventDefault();
                const viewerOpen = viewerPaneEl !== null && !viewerPaneEl.hidden;
                if (viewerOpen && viewerActiveChip === sectionDocChip) {
                    closeDocumentViewer();
                    return;
                }
                const args = sectionChipViewerArgs(sectionDocChip);
                if (args === null) return;
                if (popoverEl !== null && !popoverEl.hidden) {
                    closePopover();
                }
                if (guidelinePaneEl !== null && !guidelinePaneEl.hidden) {
                    closeGuidelineDrawer();
                }
                openDocumentWithArgs(sectionDocChip, args);
                return;
            }
            const sectionGuidelineChip = target.closest('[data-role="section-guideline-chip"]');
            if (sectionGuidelineChip) {
                e.preventDefault();
                const guidelineOpen = guidelinePaneEl !== null && !guidelinePaneEl.hidden;
                if (guidelineOpen && guidelineActiveChip === sectionGuidelineChip) {
                    closeGuidelineDrawer();
                    return;
                }
                if (popoverEl !== null && !popoverEl.hidden) {
                    closePopover();
                }
                if (viewerPaneEl !== null && !viewerPaneEl.hidden) {
                    closeDocumentViewer();
                }
                const card = sectionGuidelineCardArgs(sectionGuidelineChip);
                openGuidelineDrawer(sectionGuidelineChip, card, '');
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
            // F.4 Layer-1 dispatch on source_type:
            //   - extracted_document → open the side-by-side viewer.
            //     A second click on the *same* extracted_document chip
            //     closes the pane; a click on a *different* one swaps
            //     the document/page/bbox in place via openDocument.
            //   - guideline → open the guideline source drawer (same
            //     UX as the document drawer; renders the cited
            //     evidence-corpus snippet directly from ref.meta).
            //   - chart → fall through to the popover. Any open
            //     viewer pane closes so the chip's popover isn't
            //     half-occluded by the side-by-side layout.
            const viewerOpen = viewerPaneEl !== null && !viewerPaneEl.hidden;
            const guidelineOpen = guidelinePaneEl !== null && !guidelinePaneEl.hidden;
            if (ref.source_type === 'extracted_document') {
                if (viewerOpen && viewerActiveChip === chip) {
                    closeDocumentViewer();
                    return;
                }
                if (popoverEl !== null && !popoverEl.hidden) {
                    closePopover();
                }
                if (guidelineOpen) {
                    closeGuidelineDrawer();
                }
                openDocumentForChip(chip, ref);
                return;
            }
            if (ref.source_type === 'guideline') {
                if (guidelineOpen && guidelineActiveChip === chip) {
                    closeGuidelineDrawer();
                    return;
                }
                if (popoverEl !== null && !popoverEl.hidden) {
                    closePopover();
                }
                if (viewerOpen) {
                    closeDocumentViewer();
                }
                const card = guidelineCardFromSource(ref);
                if (card === null) return;
                openGuidelineDrawer(chip, card, claim.text || '');
                return;
            }
            if (viewerOpen) {
                closeDocumentViewer();
            }
            if (guidelineOpen) {
                closeGuidelineDrawer();
            }
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

    /**
     * §D.1 upload toast.
     *
     * One reusable element, populated in place — both the upload-side
     * failure paths (controller 4xx/5xx, transport errors) and the
     * pipeline-side `pipeline.error` SSE frames render here. Keeping a
     * single toast region (rather than mint-on-error) means the doctor
     * never sees a stack of stale messages and the JS doesn't have to
     * race a fade-out animation against a fast follow-up failure.
     */
    const toastEl = root ? root.querySelector('[data-role="upload-toast"]') : null;

    const showUploadToast = (message) => {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.hidden = false;
    };

    const clearUploadToast = () => {
        if (!toastEl) return;
        toastEl.hidden = true;
        toastEl.textContent = '';
    };

    /**
     * §D.1 client-side upload-shape gate. Mirrors the server-side
     * controller's allowlist + 10 MB cap so the doctor learns about a
     * bad attachment immediately rather than after a wasted round-trip.
     * The browser still respects the `accept` attribute as a hint, but
     * a determined picker can ignore it; this is the behavioral check.
     */
    const ALLOWED_UPLOAD_MIMES = new Set([
        'application/pdf',
        'image/png',
        'image/jpeg',
        'image/tiff',
    ]);
    const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

    const validateUploadShape = (file) => {
        if (!file) return 'missing_file';
        if (file.size > MAX_UPLOAD_BYTES) return 'file_too_large';
        if (!ALLOWED_UPLOAD_MIMES.has(file.type)) return 'unsupported_media_type';
        return null;
    };

    /**
     * §D.1 build URLs for the panel's two browser-inbound endpoints
     * relative to the proxy URL. The proxy lives at
     * `<webroot>/.../public/agent.php`; both `document_upload.php` and
     * `extract.php` live alongside it. (Browser-inbound entries live
     * directly under `public/`; the `snapshot/` prefix is reserved for
     * agent-callback bearer-token endpoints.)
     */
    const siblingProxyUrl = (filename, fallback) => {
        if (typeof proxyUrl !== 'string' || proxyUrl.length === 0) {
            return fallback;
        }
        const lastSlash = proxyUrl.lastIndexOf('/');
        const baseDir = lastSlash >= 0 ? proxyUrl.slice(0, lastSlash) : proxyUrl;
        return `${baseDir}/${filename}`;
    };

    const documentUploadUrl = () => siblingProxyUrl('document_upload.php', '/document_upload.php');
    const extractEndpointUrl = () => siblingProxyUrl('extract.php', '/extract.php');

    /**
     * F.5a — toast utilities. Ephemeral, ~3s, fade-in/fade-out via CSS
     * transition. Stacks vertically when multiple fire in sequence.
     * The toast container is mounted lazily on first use so a panel
     * that never accepts/rejects pays no DOM cost.
     */
    let toastContainerEl = null;
    const TOAST_TIMEOUT_MS = 3000;

    const ensureToastContainer = () => {
        if (toastContainerEl !== null) return toastContainerEl;
        if (typeof document === 'undefined') return null;
        toastContainerEl = document.createElement('div');
        toastContainerEl.className = 'copilot-toast-container';
        toastContainerEl.setAttribute('role', 'status');
        toastContainerEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastContainerEl);
        return toastContainerEl;
    };

    const showToast = (variant, message) => {
        const container = ensureToastContainer();
        if (container === null) return;
        const toast = document.createElement('div');
        toast.className = `copilot-toast copilot-toast--${variant}`;
        toast.textContent = message;
        container.appendChild(toast);
        // Force a reflow so the fade-in transition fires from the
        // `opacity: 0` initial state instead of skipping straight to
        // the post-transition `opacity: 1`.
        // eslint-disable-next-line no-unused-expressions -- intentional reflow
        toast.offsetHeight;
        toast.classList.add('copilot-toast--visible');
        setTimeout(() => {
            toast.classList.remove('copilot-toast--visible');
            toast.classList.add('copilot-toast--leaving');
            setTimeout(() => {
                toast.remove();
            }, 250);
        }, TOAST_TIMEOUT_MS);
    };

    /**
     * F.5a — POST a fact-accept request to the proxy. The proxy mints
     * an `accept_fact`-scoped JWT (PolicyGate's accept_fact entry) and
     * forwards to the agent middleman, which materializes the
     * promotion body, calls `promote.php`, and records the
     * disposition. Returns a discriminated-union result so the click
     * handler doesn't have to introspect status + body twice.
     */
    const acceptFactUrl = () => `${proxyUrl}?action=accept_fact${pid ? `&pid=${encodeURIComponent(pid)}` : ''}`;
    const dispositionsUrl = () => `${proxyUrl}?action=dispositions${pid ? `&pid=${encodeURIComponent(pid)}` : ''}`;

    /**
     * F.5a — POST a fact-action request (accept or reject) and parse a
     * typed result envelope. The agent's `accept_fact` route and the
     * `dispositions` route share the same JSON-error shape (`{error}`)
     * and the same network/malformed failure modes; one helper covers
     * both with a `transportLabel` for the console-log line. Pure-
     * function shape (caller injects `fetchFn`) so the Jest test can
     * drive the request/response cycle without jsdom.
     */
    const postFactAction = async ({ fetchFn, url, body, transportLabel }) => {
        let response;
        try {
            response = await fetchFn(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (err) {
            console.error(`copilot: ${transportLabel} transport failed`, err);
            return { ok: false, code: 'network_error' };
        }
        let parsed = null;
        try {
            parsed = await response.json();
        } catch {
            return { ok: false, code: 'malformed_response' };
        }
        if (response.ok) {
            return { ok: true, body: parsed };
        }
        const errCode = (parsed && typeof parsed.error === 'string') ? parsed.error : 'unknown';
        return { ok: false, code: errCode, status: response.status };
    };

    // Accept and reject both go through `postFactAction`; the named
    // wrappers are kept for the test surface and so the call sites
    // read at the right semantic level. Both forward to the shared
    // helper above unchanged.
    const postAcceptFact = ({ fetchFn, url, body }) =>
        postFactAction({ fetchFn, url, body, transportLabel: 'accept_fact' });
    const postReject = ({ fetchFn, url, body }) =>
        postFactAction({ fetchFn, url, body, transportLabel: 'dispositions' });

    /**
     * F.5a — typed messages for accept/reject error envelopes.
     * Codes mirror the agent's `accept_fact` route + the proxy's
     * pre-stream errors.
     */
    const FACT_ACTION_ERROR_MESSAGES = {
        not_yet_implemented: 'This fact type is not yet promotable to the chart.',
        artifact_not_found: 'This document is no longer available for promotion.',
        fact_type_mismatch: 'This fact does not match the expected document type.',
        unsupported_field_path: 'This part of the document cannot be promoted.',
        schema_invalid: 'This document is missing data needed to promote.',
        promote_failed: 'OpenEMR could not write the chart record. Please try again.',
        promote_unreachable: 'OpenEMR is temporarily unreachable. Please try again.',
        promote_malformed: 'OpenEMR returned an unexpected response.',
        accept_fact_unavailable: 'The promotion service is offline. Please try again later.',
        dispositions_unavailable: 'The disposition service is offline. Please try again later.',
        invalid_body: 'This action could not be completed (invalid request).',
        network_error: 'Could not reach the agent. Please try again.',
        malformed_response: 'The agent returned an unexpected response.',
        unknown: 'Something went wrong. Please try again.',
    };
    const messageForFactActionCode = (code) =>
        FACT_ACTION_ERROR_MESSAGES[code] || FACT_ACTION_ERROR_MESSAGES.unknown;

    /**
     * F.5a — disable a button group while its request is in flight,
     * re-enable on failure, and lock the relevant button into
     * "Accepted"/"Rejected" state on success. The button-group
     * element is the one carrying `data-role="fact-actions"`.
     */
    const setFactActionsBusy = (groupEl, busy) => {
        if (!groupEl) return;
        const buttons = groupEl.querySelectorAll('button');
        buttons.forEach((b) => {
            b.disabled = busy;
        });
    };

    const finalizeAccept = (groupEl) => {
        if (!groupEl) return;
        groupEl.classList.add('copilot-fact-actions--accepted');
        const buttons = groupEl.querySelectorAll('button');
        buttons.forEach((b) => {
            b.disabled = true;
        });
        const acceptBtn = groupEl.querySelector('[data-role="fact-accept"]');
        if (acceptBtn) acceptBtn.textContent = 'Accepted';
        // F.5a — animated chip swap. The claim's `[source]` chip
        // currently carries the `copilot-source--document` variant;
        // we recolor it in place via the `--chart` variant by adding
        // `copilot-source--chart` and removing `copilot-source--document`.
        // The CSS transition on `background-color` + `border-color`
        // owns the visual recoloring.
        const claimEl = groupEl.closest('.copilot-claim-groups__claim');
        if (claimEl) {
            const docChips = claimEl.querySelectorAll('.copilot-source--document');
            docChips.forEach((chip) => {
                chip.classList.remove('copilot-source--document');
                chip.classList.add('copilot-source--chart');
            });
        }
    };

    const finalizeReject = (groupEl) => {
        if (!groupEl) return;
        const claimEl = groupEl.closest('.copilot-claim-groups__claim');
        if (!claimEl) return;
        claimEl.classList.add('copilot-claim-groups__claim--rejected');
        const buttons = groupEl.querySelectorAll('button');
        buttons.forEach((b) => {
            b.disabled = true;
        });
    };

    const handleFactAccept = async (button) => {
        const groupEl = button.closest('[data-role="fact-actions"]');
        if (!groupEl) return;
        const artifactId = groupEl.dataset.artifactId || '';
        const fieldPath = groupEl.dataset.fieldPath || '';
        const factType = groupEl.dataset.factType || '';
        if (artifactId.length === 0 || fieldPath.length === 0 || factType.length === 0) return;
        if (groupEl.classList.contains('copilot-fact-actions--accepted')) return;
        setFactActionsBusy(groupEl, true);
        const body = {
            artifactId,
            fieldPath,
            factType,
            ...(conversationId ? { conversationId } : {}),
        };
        const result = await postAcceptFact({
            fetchFn: fetch,
            url: acceptFactUrl(),
            body,
        });
        if (result.ok) {
            finalizeAccept(groupEl);
            const idempotent = result.body && result.body.idempotentHit === true;
            showToast(
                'success',
                idempotent ? 'Already in chart.' : 'Promoted to chart.',
            );
            return;
        }
        setFactActionsBusy(groupEl, false);
        showToast('error', messageForFactActionCode(result.code));
    };

    const handleFactReject = async (button) => {
        const groupEl = button.closest('[data-role="fact-actions"]');
        if (!groupEl) return;
        const artifactId = groupEl.dataset.artifactId || '';
        const fieldPath = groupEl.dataset.fieldPath || '';
        if (artifactId.length === 0 || fieldPath.length === 0) return;
        const claimEl = groupEl.closest('.copilot-claim-groups__claim');
        if (claimEl && claimEl.classList.contains('copilot-claim-groups__claim--rejected')) return;
        setFactActionsBusy(groupEl, true);
        const body = { artifactId, fieldPath, status: 'rejected' };
        const result = await postReject({
            fetchFn: fetch,
            url: dispositionsUrl(),
            body,
        });
        if (result.ok) {
            finalizeReject(groupEl);
            showToast('success', 'Fact rejected.');
            return;
        }
        setFactActionsBusy(groupEl, false);
        showToast('error', messageForFactActionCode(result.code));
    };

    /**
     * §D.1 pure upload round-trip. Posts the file as multipart to the
     * `document_upload.php` endpoint and parses the typed JSON
     * response. Returns a discriminated-union result so the caller
     * never has to introspect HTTP status + body shape twice.
     *
     * Pure-function shape (caller injects `fetch` + `url`) so the
     * Jest test can drive the request/response cycle without jsdom.
     */
    const runUpload = async ({ fetchFn, url, file }) => {
        let response;
        try {
            const form = new FormData();
            form.append('file', file);
            response = await fetchFn(url, {
                method: 'POST',
                credentials: 'same-origin',
                body: form,
            });
        } catch (err) {
            console.error('copilot: upload transport failed', err);
            return { ok: false, code: 'upload_unavailable' };
        }
        let body = null;
        try {
            body = await response.json();
        } catch {
            // Body parsing failed; treat as opaque server failure.
        }
        if (!response.ok) {
            const code = body && typeof body.error === 'string' ? body.error : 'upload_unavailable';
            return { ok: false, code };
        }
        if (
            !body
            || typeof body.document_uuid !== 'string'
            || typeof body.doc_type_guess !== 'string'
            || typeof body.canonical_ext !== 'string'
        ) {
            return { ok: false, code: 'upload_unavailable' };
        }
        return {
            ok: true,
            documentUuid: body.document_uuid,
            docType: body.doc_type_guess,
            canonicalExt: body.canonical_ext,
        };
    };

    /**
     * §D.1 stream the pipeline-trigger SSE response from `extract.php`.
     *
     * Returns a result discriminated by the terminal state:
     *   - `{ok: true, artifactId}` — pipeline finished with `pipeline.exit`
     *     `status: 'persisted'`. The panel can now kick off a follow-up
     *     briefing turn so the supervisor synthesizes against the
     *     newly-persisted artifact.
     *   - `{ok: false, code}` — the pipeline emitted `pipeline.error`,
     *     transport failed, OpenEMR refused at the boundary, or
     *     `pipeline.exit` reported `status: 'failed'`. Error toasts
     *     have already rendered through `handleEvent` along the way;
     *     `code` is the terminal failure for status-line purposes.
     *
     * Reuses the existing event vocabulary (`handleEvent` dispatches
     * `pipeline.*` already), so the per-stage status-text and toast
     * rendering stays in one place.
     */
    const streamExtract = async ({ fetchFn, url, body }) => {
        let response;
        try {
            response = await fetchFn(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            console.error('copilot: extract transport failed', err);
            return { ok: false, code: 'pipeline_failed' };
        }
        if (!response.ok) {
            // OpenEMR-side rejection (400 invalid_body, 401 unauthorized,
            // 502 agent unreachable, etc.). Surface as the generic code
            // so the doctor-facing message stays high-signal; the
            // structured error body is logged at the controller.
            return { ok: false, code: 'pipeline_failed' };
        }

        let terminal = { ok: false, code: 'pipeline_failed' };
        let sawExit = false;

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
                let payload;
                try {
                    payload = JSON.parse(dataLine.slice('data: '.length));
                } catch (err) {
                    console.error('copilot: failed to parse pipeline SSE payload', err);
                    continue;
                }
                handleEvent(payload);
                if (payload && payload.type === 'pipeline.exit') {
                    sawExit = true;
                    terminal = payload.status === 'persisted'
                        ? { ok: true, artifactId: payload.artifactId }
                        : { ok: false, code: 'pipeline_failed' };
                } else if (payload && payload.type === 'pipeline.error') {
                    terminal = { ok: false, code: payload.code };
                }
            }
        }

        // The agent always closes the stream with a `pipeline.exit`
        // event (see `agent/src/server/routes/extract.ts`); a stream
        // that ends without one is a transport drop, not a clean
        // failure mode.
        if (!sawExit && terminal.ok === false && terminal.code === 'pipeline_failed') {
            return terminal;
        }
        return terminal;
    };

    /**
     * §D.1 upload + extract + briefing flow.
     *
     *   1. Client-side gate (size + MIME). Failures render a toast and
     *      no network call is made.
     *   2. POST multipart to `document_upload.php`. On 4xx/5xx render
     *      the typed-error toast.
     *   3. On 200, POST the trigger envelope to `extract.php` (B.8 path
     *      A). The agent's pipeline runs synchronously; pipeline.* SSE
     *      events drive the panel's status line and error toasts.
     *   4. On `pipeline.exit{status: 'persisted'}`, kick off a
     *      follow-up briefing turn so the supervisor synthesizes
     *      against the newly-persisted artifact. (B.9 will replace the
     *      `kickoffExtraction` stub with a path that consumes the
     *      extraction directly; until then, the briefing turn is the
     *      seam — the supervisor sees the persisted DocumentReference
     *      via the normal chart fetch and can cite it.)
     */
    /**
     * Upload-then-briefing flow.
     *
     *   1. Client-side gate (size + MIME). Failures render a toast and
     *      no network call is made.
     *   2. POST multipart to `document_upload.php`. On 4xx/5xx render
     *      the typed-error toast.
     *   3. On 200, POST a follow-up briefing carrying `pendingUploads`
     *      so the supervisor sees there is an unprocessed document. The
     *      supervisor decides — on its first iteration — whether to
     *      pick `kickoffExtraction`, what to do with the results
     *      (trend prior labs, query the guideline knowledge base,
     *      retrieve document evidence), and how to frame the response.
     *      Pipeline events stream back through the existing
     *      `pipelineEvent` SSE wrapper while the supervisor's next-step
     *      narration arrives via `supervisorNarration`.
     *
     * The legacy `extract.php` proxy still exists for non-conversational
     * uploads (autosweep / cron / CLI replay), but the panel does not
     * call it: the supervisor is the single point of authority for
     * turning "user attached a doc" into a briefing.
     */
    const submitUpload = async (file) => {
        if (composerBusy) return;
        clearUploadToast();
        const shapeError = validateUploadShape(file);
        if (shapeError !== null) {
            showUploadToast(messageForUploadCode(shapeError));
            return;
        }

        composerBusy = true;
        setStatus('Uploading document…', 'streaming');
        thread.push({ role: 'user', text: `📎 ${file.name}` });
        renderThread();

        const uploadResult = await runUpload({ fetchFn: fetch, url: documentUploadUrl(), file });
        if (!uploadResult.ok) {
            showUploadToast(messageForUploadCode(uploadResult.code));
            setStatus('Upload failed.', 'error');
            composerBusy = false;
            return;
        }

        setStatus('Drafting briefing…', 'streaming');
        try {
            await streamTurn({
                envelope: {
                    conversationId,
                    requestId: `req-${pid}-${Date.now()}`,
                    siteId,
                    patient: { pid, uuid: '' },
                    task: 'follow_up',
                    pendingUploads: [
                        {
                            documentUuid: uploadResult.documentUuid,
                            docType: uploadResult.docType,
                            canonicalExt: uploadResult.canonicalExt,
                        },
                    ],
                },
                errorTag: 'upload-followup',
            });
        } finally {
            composerBusy = false;
        }
    };

    const wireFilePicker = () => {
        if (!root) return;
        const attach = root.querySelector('[data-role="attach"]');
        const fileInput = root.querySelector('[data-role="file"]');
        if (!attach || !fileInput) return;
        attach.addEventListener('click', (e) => {
            e.preventDefault();
            fileInput.click();
        });
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            // Reset the input value so picking the same file twice
            // still fires `change` — without the reset, a second pick
            // of the same filename is silent.
            const captured = file;
            fileInput.value = '';
            submitUpload(captured).catch((err) => {
                console.error('copilot: submitUpload errored', err);
            });
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
            const response = await proxyFetch(
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
            const response = await proxyFetch(`${proxyUrl}?${params.toString()}`, {
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
        const response = await proxyFetch(`${proxyUrl}?${params.toString()}`, {
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
        wireFilePicker();
        wireHistoryInfiniteScroll();
        wireSuggestionsClicks();
        wireSourceChipClicks();
        wireDocumentViewerControls();
        wireGuidelineViewerControls();
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
        // §D.1 upload + pipeline-event helpers, exposed for
        // `tests/js/copilot-panel-upload.test.js`.
        validateUploadShape,
        documentUploadUrl,
        extractEndpointUrl,
        runUpload,
        messageForUploadCode,
        messageForPipelineCode,
        PIPELINE_STATUS_TEXT,
        MAX_UPLOAD_BYTES,
        ALLOWED_UPLOAD_MIMES,
        // F.4 viewer-args extractor, exposed for
        // `tests/js/copilot-panel-document-viewer.test.js`.
        viewerArgsFromSource,
        sectionChipViewerArgs,
        // Guideline drawer helpers, exposed for
        // `tests/js/copilot-panel-guideline-viewer.test.js`.
        guidelineCardFromSource,
        sectionGuidelineCardArgs,
        safeGuidelineUrl,
        renderGuidelineCard,
        // F.5a accept/reject helpers, exposed for
        // `tests/js/copilot-panel-fact-actions.test.js`.
        factTypeForClaimCategory,
        docPromotionTargetForClaim,
        renderFactActions,
        postAcceptFact,
        postReject,
        messageForFactActionCode,
        // Trend-chart helpers, exposed for
        // `tests/js/copilot-panel-trend-chart.test.js`.
        renderTrendChart,
        renderTrendChartSvg,
        trendChartCaption,
        parseTrendRange,
        formatTrendDate,
    };
})();

// CommonJS bridge for Jest. The browser-side `<script>` tag has no
// `module` global, so this branch is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = __copilotPanel;
}
