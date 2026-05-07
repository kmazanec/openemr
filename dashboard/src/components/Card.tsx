import type { ReactElement, ReactNode } from 'react';

export interface CardProps {
  title: string;
  viewAllHref?: string;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  children: ReactNode;
}

export function Card({
  title,
  viewAllHref,
  loading,
  error,
  onRetry,
  children,
}: CardProps): ReactElement {
  return (
    <div className="card mb-3">
      <div className="card-header d-flex justify-content-between align-items-center">
        <span className="card-title fw-semibold mb-0">{title}</span>
        {viewAllHref !== undefined && (
          <a className="card-link small" href={viewAllHref}>
            View all
          </a>
        )}
      </div>
      <div className="card-body">{renderBody({ title, loading, error, onRetry, children })}</div>
    </div>
  );
}

function renderBody({
  title,
  loading,
  error,
  onRetry,
  children,
}: Omit<CardProps, 'viewAllHref'>): ReactNode {
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
