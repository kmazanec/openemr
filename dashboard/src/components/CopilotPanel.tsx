import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useCopilotStream, type CopilotTurn as Turn } from '../lib/useCopilotStream';
import type {
  AssistantMessage,
  AssistantMessageSegment,
  Claim,
  SourceReference,
} from '../lib/copilotTypes';
import { isFiniteBbox, type Bbox } from '../lib/bbox';
import {
  DocumentViewerDrawer,
  type DocumentViewerArgs,
} from './DocumentViewerDrawer';
import { GuidelineDrawer } from './GuidelineDrawer';
import type { PdfJsImporter } from '../lib/pdfjsLoader';

export interface CopilotPanelProps {
  pid: number;
  siteId?: string;
  // Test-only override; production omits this and uses the same-origin
  // proxy url.
  proxyUrl?: string;
  // Test-only override for document_view.php. Lets unit + e2e tests
  // intercept document fetches without a live OpenEMR.
  documentViewUrl?: string;
  // Test-only override for the PDF.js dynamic import — JSDOM can't
  // load a real CDN bundle, so unit tests inject a fake PdfJsModule.
  pdfjsImporter?: PdfJsImporter;
}

/**
 * React-native port of the Clinical Co-Pilot panel. Shape mirrors the
 * legacy panel UI:
 *   - chat thread with assistant + user bubbles
 *   - per-claim [source] chips inline with prose
 *   - message-level Gaps shown as warning banners atop the assistant
 *     bubble
 *   - suggested follow-up chips below the latest assistant bubble
 *   - composer with a textarea + Ask button (Shift+Enter inserts a
 *     newline, plain Enter submits)
 *
 * The first time the panel renders for a (user, patient) pair it
 * fires a default-briefing request automatically. Subsequent free-text
 * questions or chip-clicks become follow-up turns.
 */
export function CopilotPanel({
  pid,
  siteId = 'default',
  proxyUrl,
  documentViewUrl,
  pdfjsImporter,
}: CopilotPanelProps): ReactElement {
  const { state, submit, reset } = useCopilotStream(
    proxyUrl !== undefined
      ? { pid, siteId, proxyUrl }
      : { pid, siteId },
  );

  // Side-drawer state. Per-source-type so a guideline chip click
  // doesn't tear down a document drawer mid-render (the drawers
  // share the right edge of the screen visually but their state is
  // independent).
  const [docArgs, setDocArgs] = useState<DocumentViewerArgs | null>(null);
  const [guidelineSource, setGuidelineSource] = useState<{
    source: SourceReference;
    claimText: string;
  } | null>(null);

  const onChipClick = useCallback(
    (claim: Claim, ref: SourceReference): void => {
      if (ref.source_type === 'extracted_document') {
        const args = viewerArgsFromSource(ref);
        if (args === null) return;
        // Second click on the same chip closes the drawer (toggle UX
        // matches the legacy panel).
        if (
          docArgs !== null &&
          docArgs.documentUuid === args.documentUuid &&
          docArgs.page === args.page
        ) {
          setDocArgs(null);
        } else {
          setDocArgs(args);
          setGuidelineSource(null);
        }
        return;
      }
      if (ref.source_type === 'guideline') {
        if (
          guidelineSource !== null &&
          guidelineSource.source.source_id === ref.source_id
        ) {
          setGuidelineSource(null);
        } else {
          setGuidelineSource({ source: ref, claimText: claim.text });
          setDocArgs(null);
        }
        return;
      }
      // chart chips fall through to their `<a href>` deep link.
    },
    [docArgs, guidelineSource],
  );

  // Auto-fire the default briefing once per mount-per-patient. We key
  // off the conversationId rather than `pid` directly because
  // useCopilotStream's effect resets the conversation on a pid change,
  // which gives us a stable "ready to fire" signal.
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (firedFor.current !== state.conversationId && state.turns.length === 0 && !state.inFlight) {
      firedFor.current = state.conversationId;
      submit({ task: 'default_briefing' });
    }
  }, [state.conversationId, state.turns.length, state.inFlight, submit]);

  const threadEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.turns.length]);

  const [composer, setComposer] = useState('');
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const text = composer.trim();
    if (text === '' || state.inFlight) return;
    submit({ task: 'follow_up', question: text });
    setComposer('');
  };

  const lastAssistant = lastAssistantTurn(state.turns);

  return (
    <div
      className="copilot-panel d-flex flex-column"
      data-testid="copilot-panel"
      data-pid={pid}
      data-site-id={siteId}
      style={{ height: '100%', minHeight: 0 }}
    >
      <header className="d-flex align-items-center justify-content-between px-3 py-2 border-bottom bg-body">
        <div>
          <h2 className="h5 mb-0 text-primary">Clinical Co-Pilot</h2>
          <p className="small text-body-secondary mb-0" data-testid="copilot-status">
            {state.inFlight
              ? 'Composing briefing…'
              : state.turns.length === 0
                ? 'Loading briefing…'
                : 'Ready'}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={reset}
          disabled={state.inFlight}
        >
          New conversation
        </button>
      </header>

      <div
        className="flex-grow-1 overflow-auto px-3 py-3"
        data-testid="copilot-thread"
        style={{ minHeight: 0 }}
      >
        {state.turns.length === 0 && !state.inFlight ? (
          <div className="text-center text-body-secondary p-4">
            <p>The Co-Pilot will summarize this patient&rsquo;s chart for you.</p>
          </div>
        ) : (
          state.turns.map((turn, i) => (
            <TurnView key={i} turn={turn} onChipClick={onChipClick} />
          ))
        )}
        <div ref={threadEndRef} />
      </div>

      <DocumentViewerDrawer
        args={docArgs}
        onClose={() => setDocArgs(null)}
        {...(documentViewUrl !== undefined ? { documentViewUrl } : {})}
        {...(pdfjsImporter !== undefined ? { pdfjsImporter } : {})}
      />
      <GuidelineDrawer
        source={guidelineSource?.source ?? null}
        claimText={guidelineSource?.claimText ?? ''}
        onClose={() => setGuidelineSource(null)}
      />

      {lastAssistant !== null && lastAssistant.message.suggestedFollowUps.length > 0 && (
        <div
          className="copilot-suggestions border-top px-3 py-2 d-flex flex-wrap gap-2 bg-light"
          data-testid="copilot-suggestions"
        >
          {lastAssistant.message.suggestedFollowUps.map((s) => (
            <button
              key={s.id}
              type="button"
              className="btn btn-sm btn-outline-primary"
              data-testid="copilot-suggestion"
              disabled={state.inFlight}
              onClick={() => submit({ task: 'follow_up', question: s.displayText })}
            >
              {s.displayText}
            </button>
          ))}
        </div>
      )}

      <form className="border-top p-2 d-flex gap-2 align-items-end" onSubmit={onSubmit}>
        <textarea
          className="form-control"
          rows={2}
          maxLength={2000}
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          placeholder="Ask a follow-up question about this patient… (Shift+Enter for newline)"
          data-testid="copilot-composer"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const form = e.currentTarget.form;
              if (form !== null) {
                form.requestSubmit();
              }
            }
          }}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={state.inFlight || composer.trim() === ''}
          data-testid="copilot-submit"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

function lastAssistantTurn(turns: readonly Turn[]): { message: AssistantMessage } | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t !== undefined && t.kind === 'assistant') {
      return { message: t.message };
    }
  }
  return null;
}

function TurnView({
  turn,
  onChipClick,
}: {
  turn: Turn;
  onChipClick: (claim: Claim, ref: SourceReference) => void;
}): ReactElement {
  switch (turn.kind) {
    case 'user':
      return (
        <div className="d-flex justify-content-end mb-2">
          <div
            className="copilot-bubble copilot-bubble--user p-2 rounded text-bg-primary"
            data-testid="copilot-bubble-user"
            style={{ maxWidth: '80%' }}
          >
            {turn.text}
          </div>
        </div>
      );
    case 'assistant':
      return <AssistantBubble message={turn.message} onChipClick={onChipClick} />;
    case 'progress':
      return (
        <div className="d-flex justify-content-start mb-2">
          <div
            className="copilot-bubble bg-light border rounded p-2"
            data-testid="copilot-bubble-progress"
            style={{ maxWidth: '80%' }}
          >
            <div className="d-flex align-items-center gap-2 mb-1">
              <div
                className="spinner-border spinner-border-sm text-primary"
                role="status"
                aria-label="Working"
              />
              <span className="small text-body-secondary">
                {turn.narration ?? 'Working on briefing…'}
              </span>
            </div>
            <ul className="list-unstyled small mb-0">
              {turn.stages.map((s) => (
                <li
                  key={s.stage}
                  data-stage={s.stage}
                  data-status={s.status}
                  className={
                    s.status === 'completed'
                      ? 'text-success'
                      : s.status === 'started'
                        ? 'text-primary'
                        : 'text-body-secondary'
                  }
                >
                  <span aria-hidden="true">
                    {s.status === 'completed' ? '✓' : s.status === 'started' ? '•' : '○'}
                  </span>{' '}
                  {s.label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    case 'thinking':
      return (
        <div className="d-flex justify-content-start mb-2">
          <div
            className="copilot-bubble bg-light border rounded p-2"
            data-testid="copilot-bubble-thinking"
            style={{ maxWidth: '80%' }}
          >
            <div className="d-flex align-items-center gap-2">
              <div
                className="spinner-border spinner-border-sm text-primary"
                role="status"
                aria-label="Thinking"
              />
              <span className="small text-body-secondary">
                {turn.narration ?? 'Thinking…'}
              </span>
            </div>
          </div>
        </div>
      );
    case 'error':
      return (
        <div className="d-flex justify-content-start mb-2">
          <div
            className="copilot-bubble bg-danger-subtle border border-danger-subtle rounded p-2 text-danger-emphasis"
            data-testid="copilot-bubble-error"
            role="alert"
            style={{ maxWidth: '80%' }}
          >
            <strong>Could not complete this turn.</strong>
            <div className="small mt-1">{humanizeErrorCode(turn.code)}</div>
          </div>
        </div>
      );
  }
}

function AssistantBubble({
  message,
  onChipClick,
}: {
  message: AssistantMessage;
  onChipClick: (claim: Claim, ref: SourceReference) => void;
}): ReactElement {
  const redactedCount = message.segments.filter((s) => s.redacted).length;
  return (
    <div className="d-flex justify-content-start mb-2">
      <div
        className="copilot-bubble bg-light border rounded p-2"
        data-testid="copilot-bubble-assistant"
        style={{ maxWidth: '90%' }}
      >
        {message.gaps.length > 0 && (
          <div
            className="alert alert-warning py-1 px-2 small mb-2"
            role="alert"
            data-testid="copilot-gap"
          >
            {message.gaps.map((g, i) => (
              <div key={i}>
                <strong>{humanizeGapReason(g.reason)}</strong>
                {g.message !== '' && <span> — {g.message}</span>}
              </div>
            ))}
          </div>
        )}
        <p className="mb-0" data-testid="copilot-prose">
          {message.segments.filter((s) => !s.redacted).map((seg, i) => (
            <SegmentInline key={i} segment={seg} onChipClick={onChipClick} />
          ))}
          {redactedCount > 0 && (
            <span
              className="badge bg-secondary ms-1"
              data-testid="copilot-redacted-chip"
              title={`${redactedCount} statement${redactedCount === 1 ? '' : 's'} could not be verified.`}
            >
              {redactedCount} unverified
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function SegmentInline({
  segment,
  onChipClick,
}: {
  segment: AssistantMessageSegment;
  onChipClick: (claim: Claim, ref: SourceReference) => void;
}): ReactElement {
  return (
    <span data-testid="copilot-segment">
      {segment.text}
      {segment.claims.map((claim) =>
        claim.sourceReferences.map((ref, ri) => (
          <SourceChip
            key={`${claim.id}-${ri}`}
            claim={claim}
            reference={ref}
            onClick={() => onChipClick(claim, ref)}
          />
        )),
      )}{' '}
    </span>
  );
}

function SourceChip({
  claim,
  reference,
  onClick,
}: {
  claim: Claim;
  reference: SourceReference;
  onClick: () => void;
}): ReactElement {
  const url = sourceLinkUrl(reference);
  const tooltip = chipTooltipText(reference);
  const label = chipLabel(reference);
  const cls = 'badge text-decoration-none ms-1 ' + chipColorClass(reference);
  // Chart chips with a known deep link render as anchors so the user
  // gets the native middle-click / open-in-new-tab affordance.
  if (url !== null) {
    return (
      <a
        href={url}
        className={cls}
        target="_blank"
        rel="noopener noreferrer"
        title={tooltip}
        data-testid="copilot-chip"
        data-claim-id={claim.id}
        data-source-type={reference.source_type}
      >
        {label}
      </a>
    );
  }
  // extracted_document and guideline chips are buttons that open a
  // side drawer. Chart chips without a known deep link fall back to
  // the same visual treatment as a non-clickable badge (no drawer
  // exists for chart sources — the data is already inline above).
  const interactive =
    reference.source_type === 'extracted_document' || reference.source_type === 'guideline';
  if (interactive) {
    return (
      <button
        type="button"
        className={cls + ' border-0'}
        title={tooltip}
        data-testid="copilot-chip"
        data-claim-id={claim.id}
        data-source-type={reference.source_type}
        onClick={(e) => {
          e.preventDefault();
          onClick();
        }}
        // Buttons inside flowing text shouldn't disturb the line
        // height; collapse browser-default button padding so the chip
        // sits inline with the surrounding badge styles.
        style={{ padding: '0.15em 0.5em', cursor: 'pointer' }}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      className={cls}
      title={tooltip}
      data-testid="copilot-chip"
      data-claim-id={claim.id}
      data-source-type={reference.source_type}
    >
      {label}
    </span>
  );
}

function chipColorClass(ref: SourceReference): string {
  // Loose visual distinction by source type: chart=blue, doc=teal,
  // guideline=violet. All Bootstrap subtle backgrounds so the chip
  // stays unobtrusive.
  switch (ref.source_type) {
    case 'chart':
      return 'bg-primary-subtle text-primary-emphasis border border-primary-subtle';
    case 'extracted_document':
      return 'bg-info-subtle text-info-emphasis border border-info-subtle';
    case 'guideline':
      return 'bg-warning-subtle text-warning-emphasis border border-warning-subtle';
  }
}

function chipLabel(ref: SourceReference): string {
  switch (ref.source_type) {
    case 'chart':
      return 'chart';
    case 'extracted_document':
      return 'document';
    case 'guideline': {
      const pub = ref.meta?.publication;
      return typeof pub === 'string' && pub !== '' ? pub : 'guideline';
    }
  }
}

function chipTooltipText(ref: SourceReference): string {
  // Quote (truncated) is the universally-useful tooltip body across
  // all three source types.
  const trim = ref.quote.length > 220 ? ref.quote.slice(0, 217) + '…' : ref.quote;
  return trim;
}

/**
 * Pull the (documentUuid, page, bbox) the document viewer needs out
 * of an `extracted_document` source ref. Mirrors the legacy panel's
 * `viewerArgsFromSource` — `meta.document_uuid` and `locator.page` /
 * `locator.bbox` are the canonical carriers; if `meta.document_uuid`
 * is missing the chip is unrenderable as a viewer target so we
 * return null and fall back to a tooltip-only chip.
 */
function viewerArgsFromSource(ref: SourceReference): DocumentViewerArgs | null {
  if (ref.source_type !== 'extracted_document') return null;
  const meta = ref.meta ?? {};
  const documentUuid = typeof meta.document_uuid === 'string' ? meta.document_uuid : '';
  if (documentUuid === '') return null;
  const page = typeof ref.locator.page === 'number' ? ref.locator.page : null;
  const rawBbox = ref.locator.bbox;
  let bbox: Bbox | null = null;
  if (Array.isArray(rawBbox) && rawBbox.length === 4 && isFiniteBbox(rawBbox)) {
    bbox = rawBbox as Bbox;
  }
  return { documentUuid, page, bbox };
}

/**
 * Translate a chart SourceReference into a deep link to the
 * corresponding OpenEMR record page where one exists. Mirrors the
 * legacy panel's `recordTypeForChartField` helper. Returns null for
 * extracted-document and guideline refs (those open in side panes in
 * the legacy UI; here they're tooltip-only).
 */
function sourceLinkUrl(ref: SourceReference): string | null {
  if (ref.source_type !== 'chart') return null;
  const field = ref.locator.field;
  if (typeof field !== 'string') return null;
  // Encounter is the only one with a stable record-page URL we can
  // build from the source_id alone — in the legacy UI all the other
  // chip targets opened the patient summary itself, which is what we
  // already render. So we keep this conservative: only emit a link
  // when we know it goes somewhere useful.
  if (field.startsWith('encounter.')) {
    return `/interface/forms/encounter/view.php?id=${encodeURIComponent(ref.source_id)}`;
  }
  return null;
}

function humanizeErrorCode(code: string): string {
  switch (code) {
    case 'invalid_envelope':
      return 'The agent rejected the request envelope. Please reload the panel.';
    case 'site_mismatch':
      return 'Session and patient site disagree. Please re-authenticate.';
    case 'upstream_unavailable':
      return 'Co-Pilot service is temporarily unreachable. Try again in a moment.';
    case 'token_mint_failed':
      return 'OpenEMR could not mint a session token for the agent.';
    case 'wrongpatient':
    case 'wrongsite':
    case 'missingsession':
      return 'Authorization check failed. Please reload OpenEMR.';
    case 'network_error':
      return 'Network error reaching the Co-Pilot service.';
    default:
      return `Service error: ${code}`;
  }
}

function humanizeGapReason(reason: string): string {
  // The agent emits a small closed set of gap reasons. Map the ones
  // we know about; fall through to the raw code so an unknown reason
  // is at least surfaced rather than silently dropped.
  switch (reason) {
    case 'allergies-unavailable':
      return 'Allergy data unavailable';
    case 'medications-unavailable':
      return 'Medications unavailable';
    case 'safety-critical-rejected':
      return 'Safety-critical claim could not be verified';
    case 'low-confidence-extraction':
      return 'Extraction confidence too low';
    default:
      return reason;
  }
}
