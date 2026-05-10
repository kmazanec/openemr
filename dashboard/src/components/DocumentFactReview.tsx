import { Fragment, useCallback, useState, type ReactElement } from 'react';
import type {
  Claim,
  ClaimCategory,
  DocumentClaimCard,
  DocumentClaimGroup,
  SourceReference,
} from '../lib/copilotTypes';

/**
 * "Review extracted facts" panel — renders below the assistant
 * bubble whenever a turn produced an `extractedDocument` claim group
 * (i.e. the user uploaded a document and the agent extracted facts
 * from it). Each fact gets Accept / Reject buttons; clicks POST to
 * the same proxy endpoints the legacy panel uses
 * (`?action=accept_fact` and `?action=dispositions`), so the agent
 * write path stays identical.
 *
 * On accept: the proxy mints an `accept_fact`-scoped JWT and the
 * agent middleman calls `promote.php` to write the chart record. On
 * reject: the disposition is recorded and the row dims out. Either
 * way the buttons disable so a doctor can't double-promote a fact.
 */

const FACT_TYPE_BY_CATEGORY: Partial<Record<ClaimCategory, string>> = {
  lab: 'lab',
  allergy: 'allergy',
  medication_statement: 'medication_statement',
  diagnosis: 'past_medical_history',
  family_history: 'family_history',
};

const ERROR_MESSAGES: Record<string, string> = {
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
  invalid_body: 'This action could not be completed.',
  network_error: 'Could not reach the agent. Please try again.',
  malformed_response: 'The agent returned an unexpected response.',
  unknown: 'Something went wrong. Please try again.',
};

interface FactPromotionTarget {
  artifactId: string;
  fieldPath: string;
  factType: string;
}

export interface DocumentFactReviewProps {
  group: DocumentClaimGroup;
  proxyUrl: string;
  pid: number;
  conversationId: string | null;
  // Click handler for the per-claim `[source]` chips. Same shape as
  // the inline-prose chip handler in CopilotPanel — opens the
  // DocumentViewerDrawer at the cited page+bbox so the doctor can
  // verify the extracted fact in context before accepting.
  onChipClick: (claim: Claim, ref: SourceReference, anchor: HTMLElement) => void;
  // Test-only override; production omits.
  fetchFn?: typeof fetch;
}

type FactStatus = 'idle' | 'submitting' | 'accepted' | 'rejected' | 'error';

export function DocumentFactReview({
  group,
  proxyUrl,
  pid,
  conversationId,
  onChipClick,
  fetchFn,
}: DocumentFactReviewProps): ReactElement | null {
  if (group.cards.length === 0) return null;
  return (
    <section className="copilot-fact-review" data-testid="copilot-fact-review">
      <h3 className="copilot-fact-review__heading">From documents</h3>
      {group.cards.map((card, idx) => (
        <DocumentFactCard
          key={card.documentUuid ?? `card-${String(idx)}`}
          card={card}
          proxyUrl={proxyUrl}
          pid={pid}
          conversationId={conversationId}
          onChipClick={onChipClick}
          {...(fetchFn !== undefined ? { fetchFn } : {})}
        />
      ))}
    </section>
  );
}

function DocumentFactCard({
  card,
  proxyUrl,
  pid,
  conversationId,
  onChipClick,
  fetchFn,
}: {
  card: DocumentClaimCard;
  proxyUrl: string;
  pid: number;
  conversationId: string | null;
  onChipClick: (claim: Claim, ref: SourceReference, anchor: HTMLElement) => void;
  fetchFn?: typeof fetch;
}): ReactElement {
  const label =
    card.documentUuid !== null && card.documentUuid.length > 0
      ? `Document ${card.documentUuid.slice(0, 8)}`
      : 'Document';
  return (
    <div
      className="copilot-fact-review__card"
      data-testid="copilot-fact-review-card"
      data-document-uuid={card.documentUuid ?? ''}
    >
      <h4 className="copilot-fact-review__doc-label">{label}</h4>
      <ul className="copilot-fact-review__list">
        {card.claims.map((claim) => (
          <DocumentFactRow
            key={claim.id}
            claim={claim}
            proxyUrl={proxyUrl}
            pid={pid}
            conversationId={conversationId}
            onChipClick={onChipClick}
            {...(fetchFn !== undefined ? { fetchFn } : {})}
          />
        ))}
      </ul>
    </div>
  );
}

function DocumentFactRow({
  claim,
  proxyUrl,
  pid,
  conversationId,
  onChipClick,
  fetchFn,
}: {
  claim: Claim;
  proxyUrl: string;
  pid: number;
  conversationId: string | null;
  onChipClick: (claim: Claim, ref: SourceReference, anchor: HTMLElement) => void;
  fetchFn?: typeof fetch;
}): ReactElement {
  const [status, setStatus] = useState<FactStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [idempotent, setIdempotent] = useState<boolean>(false);

  const target = promotionTargetForClaim(claim);

  const fetchImpl = fetchFn ?? fetch;

  const onAccept = useCallback(async () => {
    if (target === null) return;
    setStatus('submitting');
    setError(null);
    const url =
      `${proxyUrl}?action=accept_fact` +
      (Number.isFinite(pid) ? `&pid=${encodeURIComponent(String(pid))}` : '');
    const body = {
      artifactId: target.artifactId,
      fieldPath: target.fieldPath,
      factType: target.factType,
      ...(conversationId !== null ? { conversationId } : {}),
    };
    const result = await postJson(fetchImpl, url, body);
    if (result.ok) {
      const idem =
        typeof result.body === 'object' &&
        result.body !== null &&
        (result.body as { idempotentHit?: unknown }).idempotentHit === true;
      setIdempotent(idem);
      setStatus('accepted');
      return;
    }
    setError(messageForCode(result.code));
    setStatus('error');
  }, [target, proxyUrl, pid, conversationId, fetchImpl]);

  const onReject = useCallback(async () => {
    if (target === null) return;
    setStatus('submitting');
    setError(null);
    const url =
      `${proxyUrl}?action=dispositions` +
      (Number.isFinite(pid) ? `&pid=${encodeURIComponent(String(pid))}` : '');
    const body = {
      artifactId: target.artifactId,
      fieldPath: target.fieldPath,
      status: 'rejected',
    };
    const result = await postJson(fetchImpl, url, body);
    if (result.ok) {
      setStatus('rejected');
      return;
    }
    setError(messageForCode(result.code));
    setStatus('error');
  }, [target, proxyUrl, pid, fetchImpl]);

  const disabled =
    status === 'submitting' || status === 'accepted' || status === 'rejected';

  const rowClass =
    'copilot-fact-review__row' +
    (status === 'rejected' ? ' copilot-fact-review__row--rejected' : '') +
    (status === 'accepted' ? ' copilot-fact-review__row--accepted' : '');

  return (
    <li
      className={rowClass}
      data-testid="copilot-fact-review-row"
      data-claim-id={claim.id}
      data-status={status}
    >
      <span className="copilot-fact-review__category">
        {prettyCategory(claim.category)}
      </span>{' '}
      <span className="copilot-fact-review__text">{claim.text}</span>
      {claim.sourceReferences.map((ref, ri) => (
        <Fragment key={`${claim.id}-chip-${String(ri)}`}>
          {' '}
          <ChipForRef
            claim={claim}
            reference={ref}
            onClick={(anchor) => onChipClick(claim, ref, anchor)}
          />
        </Fragment>
      ))}
      {target === null ? (
        <span
          className="copilot-fact-review__not-promotable"
          title="This fact category is not promotable to the chart from this UI."
        >
          Not promotable
        </span>
      ) : (
        <span
          className={
            'copilot-fact-actions' +
            (status === 'accepted' ? ' copilot-fact-actions--accepted' : '')
          }
          role="group"
        >
          <button
            type="button"
            className="copilot-fact-actions__btn copilot-fact-actions__btn--accept"
            onClick={() => {
              void onAccept();
            }}
            disabled={disabled}
            data-testid="copilot-fact-accept"
          >
            {status === 'accepted'
              ? idempotent
                ? 'Already in chart'
                : 'Accepted'
              : 'Accept'}
          </button>
          <button
            type="button"
            className="copilot-fact-actions__btn copilot-fact-actions__btn--reject"
            onClick={() => {
              void onReject();
            }}
            disabled={disabled}
            data-testid="copilot-fact-reject"
          >
            {status === 'rejected' ? 'Rejected' : 'Reject'}
          </button>
        </span>
      )}
      {error !== null && (
        <p
          className="copilot-fact-review__error"
          role="alert"
          data-testid="copilot-fact-error"
        >
          {error}
        </p>
      )}
    </li>
  );
}

type PostResult =
  | { ok: true; body: unknown }
  | { ok: false; code: string; status?: number };

async function postJson(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: 'network_error' };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, code: 'malformed_response' };
  }
  if (response.ok) {
    return { ok: true, body: parsed };
  }
  const code =
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : 'unknown';
  return { ok: false, code, status: response.status };
}

function promotionTargetForClaim(claim: Claim): FactPromotionTarget | null {
  const factType = FACT_TYPE_BY_CATEGORY[claim.category];
  if (factType === undefined) return null;
  const primary: SourceReference | undefined = claim.sourceReferences.find(
    (r) => r.source_type === 'extracted_document',
  );
  if (primary === undefined) return null;
  const artifactId = primary.source_id;
  const fieldPath = primary.locator.field;
  if (typeof fieldPath !== 'string' || fieldPath.length === 0) return null;
  if (artifactId.length === 0) return null;
  return { artifactId, fieldPath, factType };
}

function messageForCode(code: string): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.unknown!;
}

function prettyCategory(category: ClaimCategory): string {
  switch (category) {
    case 'medication_statement':
      return 'Medication';
    case 'family_history':
      return 'Family Hx';
    default:
      return category.charAt(0).toUpperCase() + category.slice(1);
  }
}

/**
 * Per-claim `[source]` chip in the fact-review list. Same visual
 * treatment as the inline-prose chips in CopilotPanel — color
 * variants are keyed off `source_type` so the doc-card chip reads as
 * the brown "extracted document" variant. Clicking dispatches up to
 * the panel's `onChipClick` handler, which opens the document viewer
 * drawer at the cited page+bbox so the doctor can verify the
 * extracted fact in context before accepting.
 */
function ChipForRef({
  claim,
  reference,
  onClick,
}: {
  claim: Claim;
  reference: SourceReference;
  onClick: (anchor: HTMLElement) => void;
}): ReactElement {
  const tooltip =
    reference.quote.length > 220
      ? reference.quote.slice(0, 217) + '…'
      : reference.quote;
  const variant =
    reference.source_type === 'extracted_document'
      ? 'copilot-source--document'
      : reference.source_type === 'guideline'
        ? 'copilot-source--guideline'
        : 'copilot-source--chart';
  return (
    <button
      type="button"
      className={`copilot-source ${variant}`}
      title={tooltip}
      data-testid="copilot-chip"
      data-claim-id={claim.id}
      data-source-type={reference.source_type}
      onClick={(e) => {
        e.preventDefault();
        onClick(e.currentTarget);
      }}
    >
      [source]
    </button>
  );
}
