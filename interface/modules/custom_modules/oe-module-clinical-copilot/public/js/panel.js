/**
 * Clinical Co-Pilot panel renderer (chat-thread shape).
 *
 * Opens a streaming POST to the agent proxy, parses SSE events, and
 * renders the resulting `assistantMessage` into a chat thread. Each
 * segment of an assistant message is one inline run of prose; per-claim
 * `[source]` chips link to the OpenEMR record where practical. Redacted
 * segments — segments whose claims were rejected by the verifier or
 * suppressed by a safety hard stop — render as a muted "[content
 * withheld]" notice so the renderer never asserts an unverified fact.
 *
 * Failure-state policy:
 *   - Whole-stream errors render an error bubble using the typed error
 *     code from the agent's `errorClassifier.ts`.
 *   - Message-level `gaps` (allergies-unavailable, etc.) render as a
 *     yellow warning banner inside the assistant bubble.
 *   - Redactions stay visible — we never silently drop content.
 *
 * Composer (free-text follow-up input) is rendered disabled in this
 * phase; the agent backend doesn't yet branch on `task: 'follow_up'`,
 * so wiring submit would create a visibly broken interaction. The
 * disabled state is set in HTML and intentionally not lifted here.
 * That changes in the next phase, when the rest of §4.5 lands.
 */
(function () {
    'use strict';

    const root = document.querySelector('.copilot-panel');
    if (!root) {
        return;
    }

    const proxyUrl = root.dataset.proxyUrl;
    const pid = Number.parseInt(root.dataset.pid, 10);
    const siteId = root.dataset.siteId || 'default';
    const statusEl = root.querySelector('[data-role="status"]');
    const threadEl = root.querySelector('[data-role="thread"]');

    const conversationId = `conv-${pid}-${Date.now()}`;
    const requestId = `req-${pid}-${Date.now()}`;

    /**
     * In-memory thread. The renderer reconciles to the DOM from this
     * array on every change so the DOM never holds state the model
     * doesn't reflect. Each entry is one bubble.
     *
     *   { role: 'assistant', message: AssistantMessage }
     *   { role: 'assistant', error: { code: string } }
     */
    const thread = [];

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
     * Map a SourceReference to a stable record-view URL where there is
     * one. "Where practical" per the plan — diagnoses, encounters, and
     * patient demographics have well-known view pages; others render as
     * a tooltip-only chip. The record-id is always shown in the tooltip
     * so even unmappable types are auditable from the UI.
     */
    const sourceLinkUrl = (source) => {
        if (!source || !source.recordType || !source.recordId) return null;
        switch (source.recordType) {
            case 'Patient':
                return `../../../../patient_file/summary/demographics.php?set_pid=${encodeURIComponent(source.recordId)}`;
            case 'Encounter':
                return `../../../../patient_file/encounter/encounter_top.php?set_encounter=${encodeURIComponent(source.recordId)}`;
            case 'Condition':
                return `../../../../patient_file/summary/stats_full.php`;
            case 'AllergyIntolerance':
                return `../../../../patient_file/summary/stats_full.php`;
            case 'MedicationRequest':
                return `../../../../patient_file/summary/stats_full.php`;
            case 'Observation':
                return `../../../../patient_file/encounter/load_form.php?formname=procedure_order_results`;
            default:
                return null;
        }
    };

    const renderSourceChip = (source) => {
        if (!source) {
            return '';
        }
        const tooltip = `${source.recordType || 'record'} ${source.recordId || ''}`.trim();
        const url = sourceLinkUrl(source);
        if (url) {
            return `<a class="copilot-source" href="${escapeText(url)}" title="${escapeText(tooltip)}">[source]</a>`;
        }
        return `<span class="copilot-source copilot-source--inert" title="${escapeText(tooltip)}">[source]</span>`;
    };

    /**
     * Render every source reference on every claim attached to a
     * segment. Each claim may carry multiple source references (a
     * cross-cited fact); we render one chip per ref so the clinician
     * can audit each provenance independently.
     */
    const renderSegmentChips = (claims) => {
        if (!Array.isArray(claims) || claims.length === 0) return '';
        const chips = [];
        for (const claim of claims) {
            const refs = (claim && claim.sourceReferences) || [];
            for (const ref of refs) {
                chips.push(renderSourceChip(ref));
            }
        }
        return chips.join(' ');
    };

    const renderSegment = (segment) => {
        if (!segment) return '';
        if (segment.redacted) {
            return `<span class="copilot-segment copilot-segment--redacted" title="${escapeText('Withheld by the verification gate')}">${escapeText(segment.text)}</span>`;
        }
        const chips = renderSegmentChips(segment.claims);
        return `<span class="copilot-segment">${escapeText(segment.text)}${chips ? ' ' + chips : ''}</span>`;
    };

    const renderGapsBanner = (gaps) => {
        if (!Array.isArray(gaps) || gaps.length === 0) return '';
        return gaps
            .map((g) => `<p class="copilot-gap" role="status">${escapeText(g.message || 'Section unavailable.')}</p>`)
            .join('');
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

    const renderBubble = (entry) => {
        if (!entry) return '';
        if (entry.role === 'assistant' && entry.error) {
            return `<article class="copilot-bubble copilot-bubble--assistant copilot-bubble--error" data-role="bubble" data-state="error">
                <p class="copilot-error" role="status">${escapeText(messageForCode(entry.error.code))}</p>
            </article>`;
        }
        if (entry.role === 'assistant' && entry.message) {
            const segments = (entry.message.segments || []).map(renderSegment).join(' ');
            const gaps = renderGapsBanner(entry.message.gaps);
            return `<article class="copilot-bubble copilot-bubble--assistant" data-role="bubble" data-state="rendered">
                ${gaps}
                <div class="copilot-bubble__body">${segments}</div>
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
        threadEl.innerHTML = thread.map(renderBubble).join('');
    };

    const handleAssistantMessage = (data) => {
        if (!data || !data.message) return;
        thread.push({ role: 'assistant', message: data.message });
        renderThread();
    };

    const renderFatalError = (code) => {
        setStatus('Briefing unavailable.', 'error');
        thread.push({ role: 'assistant', error: { code: code || 'briefing_failed' } });
        renderThread();
    };

    const handleEvent = (data) => {
        if (!data || typeof data !== 'object' || !data.type) return;
        switch (data.type) {
            case 'meta':
                setStatus('Streaming briefing…', 'streaming');
                break;
            case 'assistantMessage':
                handleAssistantMessage(data);
                break;
            case 'done':
                setStatus('Briefing ready.', 'ready');
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
     * Composer submit handler — stub for this phase.
     *
     * The textarea + button are rendered disabled, so this should never
     * fire from a real user gesture. The handler exists so a phase-4.5
     * follow-up can swap it out without re-wiring the form's event
     * subscription.
     */
    const wireComposer = () => {
        const form = root.querySelector('[data-role="composer"]');
        if (!form) return;
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            // Intentional no-op — see file header. The next phase routes
            // the question to /v1/agent/briefing with task: 'follow_up'.
        });
    };

    const start = async () => {
        wireComposer();
        setStatus('Connecting to Co-Pilot…', 'connecting');
        try {
            const response = await fetch(`${proxyUrl}?action=briefing&pid=${encodeURIComponent(pid)}`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify({
                    conversationId,
                    requestId,
                    siteId,
                    patient: { pid, uuid: '' },
                    task: 'default_briefing',
                }),
            });
            if (!response.ok) {
                renderFatalError(`http_${response.status}`);
                return;
            }
            await parseSseStream(response);
        } catch (err) {
            console.error('copilot: stream failed', err);
            renderFatalError('network_error');
        }
    };

    start();
})();
