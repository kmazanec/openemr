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
     *   { role: 'user', text: string }
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
     * Open an SSE stream against the agent proxy and render its events
     * into the thread. Shared between the initial briefing and §4.5
     * free-text follow-ups — the only difference between the two is the
     * envelope (`task` and the optional `question`).
     */
    const streamTurn = async ({ envelope, errorTag }) => {
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

    const wireComposer = () => {
        const form = root.querySelector('[data-role="composer"]');
        if (!form) return;
        const input = form.querySelector('[data-role="input"]');
        const submit = form.querySelector('[data-role="submit"]');
        const setBusyUi = (busy) => {
            if (input) input.disabled = busy;
            if (submit) submit.disabled = busy;
        };
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

    const start = async () => {
        wireComposer();
        setStatus('Connecting to Co-Pilot…', 'connecting');

        const resumed = await tryResume();
        if (resumed && typeof resumed.conversationId === 'string' && resumed.conversationId.length > 0) {
            conversationId = resumed.conversationId;
            hydrateFromResume(resumed);
            const relative = formatRelativeTime(resumed.updatedAt || '');
            setStatus(`Resumed conversation from ${relative}.`, 'ready');
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

    start();
})();
