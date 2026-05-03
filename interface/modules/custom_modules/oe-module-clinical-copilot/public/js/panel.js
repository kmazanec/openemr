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
     *   { role: 'assistant', progress: { stages: {…}[] }, requestId }
     *   { role: 'user', text: string }
     *
     * The `progress` shape is a transient placeholder bubble shown
     * while a turn is in flight. Each stage flips through
     * `pending → active → done` as `progress` SSE events arrive; the
     * whole bubble is replaced by the real assistant bubble when the
     * `assistantMessage` event lands. `requestId` keys the placeholder
     * so a fast second turn never lands its progress events into the
     * previous turn's bubble.
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
        if (entry.role === 'assistant' && entry.message) {
            const segments = (entry.message.segments || []).map(renderSegment).join(' ');
            const gaps = renderGapsBanner(entry.message.gaps);
            const suggestions = renderSuggestionsRail(entry.message.suggestedFollowUps, index);
            return `<article class="copilot-bubble copilot-bubble--assistant" data-role="bubble" data-state="rendered" data-bubble-index="${index}">
                ${gaps}
                <div class="copilot-bubble__body">${segments}</div>
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
        // Replace the in-flight progress bubble (if any) with the
        // real assistant message — keep the same array slot so the
        // chat doesn't visually jump.
        const idx = activeRequestId !== null ? findProgressIndex(activeRequestId) : -1;
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
        // Drop any in-flight progress placeholder for this turn so
        // the error bubble takes its place rather than appending
        // below a half-finished spinner.
        const idx = activeRequestId !== null ? findProgressIndex(activeRequestId) : -1;
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
     * Pushes an in-flight progress bubble before opening the stream so
     * the doctor sees the stage list immediately. `activeRequestId`
     * keys progress events back to this bubble, and the
     * `assistantMessage` / `error` paths replace it.
     */
    const streamTurn = async ({ envelope, errorTag }) => {
        activeRequestId = envelope.requestId;
        thread.push(newProgressEntry(envelope.requestId));
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
    const historyEl = root.querySelector('[data-role="history-list"]');
    const historyEmptyEl = root.querySelector('[data-role="history-empty"]');
    const historySentinelEl = root.querySelector('[data-role="history-sentinel"]');
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

    start();
})();
