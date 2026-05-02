/**
 * §5.4 schedule-view annotations shim.
 *
 * Runs only on the calendar day/week view (the listener in Bootstrap.php
 * scopes injection to `pnuserapi.php`). Fetches cached briefing flags
 * for the logged-in practitioner from the existing agent proxy and
 * decorates each appointment row with one chip per flag.
 *
 * Decoration model:
 *   - Each appointment DIV in `ajax_template.html` carries `data-eid='<eventid>'`.
 *   - The agent's `schedule_briefings` rows are keyed by `appointment_id`,
 *     which is the same `eventid`.
 *   - When the practitioner is opted out, the proxy short-circuits and
 *     returns `{"briefings": []}`. The shim's "no rows → render
 *     unchanged" branch covers both opt-out and "opted-in but cold
 *     cache" identically.
 */

(function () {
    'use strict';

    if (typeof document === 'undefined') {
        return;
    }

    // Minimal styling for the chip. Keeping it inline avoids a second
    // StyleFilterEvent listener for one rule.
    const STYLE_ID = 'copilot-flag-style';
    function ensureStyles() {
        if (document.getElementById(STYLE_ID) !== null) {
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = '.copilot-flag {'
            + 'display: inline-block;'
            + 'margin: 0 2px 2px 0;'
            + 'padding: 1px 4px;'
            + 'font-size: 10px;'
            + 'font-weight: 600;'
            + 'line-height: 1.2;'
            + 'color: #fff;'
            + 'background-color: #b94a48;'
            + 'border-radius: 3px;'
            + 'white-space: nowrap;'
            + '}';
        document.head.appendChild(style);
    }

    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    /**
     * Find the rendered date as an ISO `YYYY-MM-DD` string.
     *
     * The day-view template renders one `<td class="schedule" date="YYYYMMDD">`
     * per provider column. Several columns may render side-by-side — they
     * all share the same date for a given page load. Accept the first
     * one we see, normalize from `Ymd` to `Y-m-d`, and bail if nothing
     * is present (e.g. the script ran on a non-day view that happens to
     * dispatch the same script-filter event).
     */
    function findRenderedDate() {
        const cell = document.querySelector('td.schedule[date]');
        if (cell === null) {
            return null;
        }
        const raw = cell.getAttribute('date') || '';
        if (!/^\d{8}$/.test(raw)) {
            return null;
        }
        return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
    }

    /**
     * Resolve the agent proxy URL relative to the current page. The
     * shim runs inside an iframe whose location is somewhere under
     * `interface/main/calendar/...`; the proxy lives at a fixed module
     * path. Use a webroot-relative absolute path so the same string
     * works whether the install is at `/` or `/openemr/`.
     *
     * `top.webroot_url` is the OpenEMR runtime's exposed webroot — the
     * same value Header.php emits — and falls back to '' for installs
     * mounted at the document root.
     */
    function proxyUrl() {
        let webroot = '';
        try {
            if (typeof top !== 'undefined' && typeof top.webroot_url === 'string') {
                webroot = top.webroot_url;
            }
        } catch (_) {
            // Cross-origin frame; treat as no webroot.
        }
        return webroot
            + '/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php';
    }

    function renderFlag(text) {
        const span = document.createElement('span');
        span.className = 'copilot-flag';
        span.textContent = text;
        return span;
    }

    function flagLabel(rawFlag) {
        // Fallback humanizer for codes the renderer doesn't have a
        // friendly label for: split CamelCase or kebab-case into words
        // so a row never shows a raw enum identifier.
        return String(rawFlag)
            .replace(/[-_]/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .trim();
    }

    function decorate(briefings) {
        for (let i = 0; i < briefings.length; i += 1) {
            const briefing = briefings[i];
            if (!briefing || typeof briefing.appointment_id !== 'string') {
                continue;
            }
            const flags = Array.isArray(briefing.flags) ? briefing.flags : [];
            if (flags.length === 0) {
                continue;
            }
            // CSS selector: the eventid lives in `data-eid`. There can
            // be multiple DIVs per appointment when an IN event spans
            // a separate "in_start" header DIV; decorate them all so
            // the flag is visible regardless of which fragment the
            // user looks at.
            const cssSafe = briefing.appointment_id.replace(/["\\]/g, '\\$&');
            const targets = document.querySelectorAll(
                'div[data-eid="' + cssSafe + '"]',
            );
            targets.forEach(function (target) {
                if (target.querySelector('.copilot-flag') !== null) {
                    // Already decorated (e.g. listener fired twice on
                    // a partial re-render).
                    return;
                }
                for (let f = 0; f < flags.length; f += 1) {
                    target.insertBefore(renderFlag(flagLabel(flags[f])), target.firstChild);
                }
            });
        }
    }

    function fetchAnnotations(date) {
        const url = proxyUrl()
            + '?action=schedule_briefings&date=' + encodeURIComponent(date);
        return fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        }).then(function (res) {
            if (!res.ok) {
                return { briefings: [] };
            }
            return res.json().catch(function () { return { briefings: [] }; });
        }).catch(function () {
            // Network error: degrade silently. The schedule view
            // renders unchanged rather than surfacing a partial
            // failure to the clinician.
            return { briefings: [] };
        });
    }

    ready(function () {
        const date = findRenderedDate();
        if (date === null) {
            return;
        }
        fetchAnnotations(date).then(function (body) {
            const briefings = body && Array.isArray(body.briefings) ? body.briefings : [];
            if (briefings.length === 0) {
                return;
            }
            ensureStyles();
            decorate(briefings);
        });
    });
})();
