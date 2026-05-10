import { useCallback, useState, type ReactElement } from 'react';
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
  // Test-only override; production omits.
  fetchFn?: typeof fetch;
}

type FactStatus = 'idle' | 'submitting' | 'accepted' | 'rejected' | 'error';

export function DocumentFactReview({
  group,
  proxyUrl,
  pid,
  conversationId,
  fetchFn,
}: DocumentFactReviewProps): ReactElement | null {
  if (group.cards.length === 0) return null;
  return (
    <section
      className="copilot-fact-review mt-3 border rounded p-3 bg-body-tertiary"
      data-testid="copilot-fact-review"
    >
      <header className="d-flex align-items-baseline justify-content-between mb-2">
        <h3 className="h6 mb-0">Review extracted facts</h3>
        <span className="small text-body-secondary">
          Accept to add to the chart · Reject to dismiss
        </span>
      </header>
      {group.cards.map((card, idx) => (
        <DocumentFactCard
          key={card.documentUuid ?? `card-${String(idx)}`}
          card={card}
          proxyUrl={proxyUrl}
          pid={pid}
          conversationId={conversationId}
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
  fetchFn,
}: {
  card: DocumentClaimCard;
  proxyUrl: string;
  pid: number;
  conversationId: string | null;
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
      <h4 className="copilot-fact-review__doc-label small text-body-secondary fw-semibold mb-1">
        {label}
      </h4>
      <ul className="copilot-fact-review__list list-unstyled mb-0">
        {card.claims.map((claim) => (
          <DocumentFactRow
            key={claim.id}
            claim={claim}
            proxyUrl={proxyUrl}
            pid={pid}
            conversationId={conversationId}
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
  fetchFn,
}: {
  claim: Claim;
  proxyUrl: string;
  pid: number;
  conversationId: string | null;
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
    'copilot-fact-review__row d-flex flex-wrap align-items-baseline gap-2 py-2 border-top' +
    (status === 'rejected' ? ' copilot-fact-review__row--rejected' : '') +
    (status === 'accepted' ? ' copilot-fact-review__row--accepted' : '');

  return (
    <li
      className={rowClass}
      data-testid="copilot-fact-review-row"
      data-claim-id={claim.id}
      data-status={status}
    >
      <span className="copilot-fact-review__category badge bg-secondary text-uppercase">
        {prettyCategory(claim.category)}
      </span>
      <span className="copilot-fact-review__text flex-grow-1">{claim.text}</span>
      {target === null ? (
        <span
          className="copilot-fact-review__not-promotable small text-body-secondary"
          title="This fact category is not promotable to the chart from this UI."
        >
          Not promotable
        </span>
      ) : (
        <div className="copilot-fact-review__actions d-flex gap-2" role="group">
          <button
            type="button"
            className="btn btn-sm btn-success"
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
            className="btn btn-sm btn-outline-secondary"
            onClick={() => {
              void onReject();
            }}
            disabled={disabled}
            data-testid="copilot-fact-reject"
          >
            {status === 'rejected' ? 'Rejected' : 'Reject'}
          </button>
        </div>
      )}
      {error !== null && (
        <p
          className="copilot-fact-review__error w-100 small text-danger mb-0"
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
