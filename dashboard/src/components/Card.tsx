import type { ReactElement, ReactNode } from 'react';

export interface CardProps {
  title: string;
  // When set, the title-level edit link (rendered as a pencil icon
  // on the right of the card header) points here. Used for cards
  // that haven't been migrated to in-page editing yet (and as a
  // fallback when `onEditClick` is also unset).
  viewAllHref?: string;
  // When set, the title-level pencil icon becomes an in-page button
  // that fires this handler — used by the new edit-modal flow on
  // allergies/problems/medications/etc. Takes precedence over
  // `viewAllHref` so the dashboard can ship the new UX without first
  // ripping the legacy hrefs out of every call site.
  onEditClick?: () => void;
  // Tooltip + aria label for the edit affordance. Falls back to
  // "Add {title}" / "View all {title}" depending on which mode the
  // card is in so the icon-only button is announceable.
  editLabel?: string;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  children: ReactNode;
}

export function Card({
  title,
  viewAllHref,
  onEditClick,
  editLabel,
  loading,
  error,
  onRetry,
  children,
}: CardProps): ReactElement {
  return (
    <div className="card legacy-card mb-3 border-0 shadow-none">
      <div className="card-header d-flex justify-content-between align-items-center bg-body border-bottom px-2 py-1">
        <span className="d-inline-flex align-items-center gap-1">
          <DragHandle />
          <span className="card-title fw-semibold mb-0 text-primary">{title}</span>
        </span>
        {onEditClick !== undefined ? (
          <button
            type="button"
            className="btn btn-link card-link small text-primary p-0"
            onClick={onEditClick}
            aria-label={editLabel ?? `Add ${title}`}
            title={editLabel ?? `Add ${title}`}
            data-testid={`card-edit-${title.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <PencilIcon />
            <span className="visually-hidden">{editLabel ?? `Add ${title}`}</span>
          </button>
        ) : viewAllHref !== undefined ? (
          <a
            className="card-link small text-primary"
            href={viewAllHref}
            aria-label={editLabel ?? `View all ${title}`}
            title={editLabel ?? 'View all'}
          >
            <PencilIcon />
            <span className="visually-hidden">{editLabel ?? `View all ${title}`}</span>
          </a>
        ) : null}
      </div>
      <div className="card-body px-2 py-2">{renderBody({ title, loading, error, onRetry, children })}</div>
    </div>
  );
}

function DragHandle(): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="text-primary"
      aria-hidden="true"
    >
      <path d="M5 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm6-10a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
    </svg>
  );
}

function PencilIcon(): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" />
    </svg>
  );
}

function renderBody({
  title,
  loading,
  error,
  onRetry,
  children,
}: Omit<CardProps, 'viewAllHref' | 'onEditClick' | 'editLabel'>): ReactNode {
  if (loading === true) {
    return (
      <div data-testid="card-skeleton" className="placeholder-glow" aria-busy="true">
        <span className="placeholder col-7" />
        <br />
        <span className="placeholder col-4" />
      </div>
    );
  }
  if (error !== undefined && error !== null) {
    return (
      <div className="text-danger d-flex justify-content-between align-items-center">
        <span>Couldn&rsquo;t load {title}</span>
        {onRetry !== undefined && (
          <button type="button" className="btn btn-sm btn-outline-danger" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  return children;
}
