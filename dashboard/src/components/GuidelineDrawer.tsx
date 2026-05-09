import { useEffect, type ReactElement } from 'react';
import type { SourceReference } from '../lib/copilotTypes';

export interface GuidelineDrawerProps {
  // The source ref the user clicked. Carries publication / title /
  // year / section / url / quote — already enriched by the verifier
  // when the EvidenceSnippet matched.
  source: SourceReference | null;
  claimText?: string;
  onClose: () => void;
}

/**
 * Slide-in drawer for `guideline` source-type chips. No fetch:
 * everything renders from the SourceReference's `meta` block, which
 * the verifier populates with the matched EvidenceSnippet's fields.
 *
 * Same UX shape as the document viewer (right-side drawer + scrim +
 * Escape-closes), but the body is a static evidence card. Layer 2
 * of W2_ARCHITECTURE.md §"Click-to-source UI".
 */
export function GuidelineDrawer({
  source,
  claimText,
  onClose,
}: GuidelineDrawerProps): ReactElement | null {
  useEffect(() => {
    if (source === null) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, onClose]);

  if (source === null) return null;
  const meta = source.meta ?? {};
  const publication = typeof meta.publication === 'string' ? meta.publication : null;
  const title = typeof meta.title === 'string' ? meta.title : null;
  const year = typeof meta.year === 'number' ? meta.year : null;
  const section =
    typeof source.locator.section === 'string' && source.locator.section.length > 0
      ? source.locator.section
      : typeof meta.section === 'string'
        ? meta.section
        : null;
  const url = typeof meta.url === 'string' ? safeUrl(meta.url) : null;
  const quote = source.quote;

  return (
    <>
      <div
        className="copilot-guideline-scrim"
        data-testid="copilot-guideline-scrim"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.35)',
          zIndex: 1040,
        }}
      />
      <aside
        className="copilot-guideline-pane shadow"
        data-testid="copilot-guideline-drawer"
        role="dialog"
        aria-label="Guideline source"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(560px, 50vw)',
          background: '#fff',
          zIndex: 1050,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header className="d-flex align-items-center justify-content-between px-3 py-2 border-bottom">
          <h2 className="h6 mb-0">Source</h2>
          <button
            type="button"
            className="btn-close"
            aria-label="Close source viewer"
            data-testid="copilot-guideline-close"
            onClick={onClose}
          />
        </header>
        <div className="flex-grow-1 overflow-auto p-3" data-testid="copilot-guideline-body">
          <div className="mb-2 text-body-secondary small">
            {publication !== null && publication !== '' && (
              <span data-testid="copilot-guideline-publication">{publication}</span>
            )}
            {year !== null && (
              <>
                {publication !== null && publication !== '' && ' · '}
                <span>{year}</span>
              </>
            )}
          </div>
          {title !== null && title !== '' && (
            <h3 className="h5" data-testid="copilot-guideline-title">
              {title}
            </h3>
          )}
          {section !== null && (
            <p className="text-body-secondary small mb-3" data-testid="copilot-guideline-section">
              {section}
            </p>
          )}
          {quote !== '' && (
            <blockquote
              className="border-start border-3 border-warning ps-3 py-1 fst-italic"
              data-testid="copilot-guideline-quote"
            >
              {quote}
            </blockquote>
          )}
          {claimText !== undefined && claimText !== '' && (
            <div className="mt-3 small">
              <p className="text-body-secondary mb-1">Cited in this answer</p>
              <p className="mb-0">{claimText}</p>
            </div>
          )}
          <div className="mt-3">
            {url !== null ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="copilot-guideline-link"
              >
                View on publisher →
              </a>
            ) : (
              <span
                className="text-body-secondary small"
                data-testid="copilot-guideline-nolink"
                title="No public link is associated with this source."
              >
                No public link available
              </span>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}
