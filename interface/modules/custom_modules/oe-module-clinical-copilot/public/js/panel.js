/**
 * Clinical Co-Pilot panel renderer.
 *
 * Opens a streaming POST to the agent proxy, parses SSE events, and
 * renders each `section` event into the matching `<section>` block. Source
 * references travel as structured `SourceReference` objects on every claim
 * — the renderer turns each one into a `[source]` chip with a tooltip and,
 * where possible, a deep link to the OpenEMR record.
 *
 * Failure-state policy (§3.4 plan):
 *   - Whole-stream errors render "Briefing unavailable."
 *   - A `Gap`-shaped section payload renders the gap message verbatim
 *     ("Allergies could not be verified", "Medication summary withheld",
 *     etc.). A section never silently disappears.
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

    const conversationId = `conv-${pid}-${Date.now()}`;
    const requestId = `req-${pid}-${Date.now()}`;

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
     * patient demographics have well-known view pages; others render as a
     * tooltip-only chip. The record-id is always shown in the tooltip so
     * even unmappable types are auditable from the UI.
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

    const renderEntry = (entry) =>
        `<li>${escapeText(entry.text)} ${renderSourceChip(entry.source)}</li>`;

    const isGap = (payload) =>
        payload && typeof payload === 'object' && payload.kind === 'gap';

    const renderSection = (sectionEl, payload) => {
        const content = sectionEl.querySelector('[data-role="content"]');
        if (!content) return;
        sectionEl.dataset.state = 'rendered';

        if (isGap(payload)) {
            sectionEl.dataset.state = 'gap';
            const message = payload.message || 'Section unavailable.';
            content.innerHTML = `<p class="copilot-gap" role="status">${escapeText(message)}</p>`;
            return;
        }

        if (Array.isArray(payload)) {
            if (payload.length === 0) {
                content.innerHTML = `<p class="copilot-empty">${escapeText('None recorded.')}</p>`;
                return;
            }
            content.innerHTML = `<ul class="copilot-list">${payload.map(renderEntry).join('')}</ul>`;
            return;
        }

        // Single-entry payload (appointment, demographics).
        if (payload && typeof payload === 'object' && 'text' in payload) {
            content.innerHTML = `<p class="copilot-entry">${escapeText(payload.text)} ${renderSourceChip(payload.source)}</p>`;
            return;
        }

        content.innerHTML = `<p class="copilot-empty">${escapeText('—')}</p>`;
    };

    const handleSectionEvent = (data) => {
        const sectionEl = root.querySelector(`[data-section="${data.section}"]`);
        if (!sectionEl) return;
        renderSection(sectionEl, data.payload);
    };

    /**
     * Map an SSE error code to a user-facing message. Codes are emitted by
     * the agent's `errorClassifier.ts`; the user never sees the raw code or
     * any provider name. Operators see the code in the network tab and the
     * agent log if they need to drill in. Keep this map in sync with
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

    const renderFatalError = (code) => {
        setStatus('Briefing unavailable.', 'error');
        const message = messageForCode(code);
        root.querySelectorAll('[data-section]').forEach((sectionEl) => {
            if (sectionEl.dataset.state) return;
            const content = sectionEl.querySelector('[data-role="content"]');
            if (content) {
                sectionEl.dataset.state = 'error';
                content.innerHTML = `<p class="copilot-error" role="status">${escapeText(message)}</p>`;
            }
        });
    };

    const handleEvent = (data) => {
        if (!data || typeof data !== 'object' || !data.type) return;
        switch (data.type) {
            case 'meta':
                setStatus('Streaming briefing…', 'streaming');
                break;
            case 'section':
                handleSectionEvent(data);
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
                    // Fall through; the fatal error handler below will catch
                    // a permanently empty stream.
                    console.error('copilot: failed to parse SSE payload', err);
                }
            }
        }
    };

    const start = async () => {
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
