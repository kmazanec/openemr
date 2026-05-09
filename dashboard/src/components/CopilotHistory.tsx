import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

interface HistoryItem {
  conversationId: string;
  firstQuestion: string | null;
  updatedAt: string;
  messageCount: number;
}

interface NextBefore {
  updatedAt: string;
  id: string;
}

interface HistoryResponse {
  items?: HistoryItem[];
  nextBefore?: NextBefore | null;
}

export interface CopilotHistoryProps {
  pid: number;
  proxyUrl: string;
  activeConversationId: string;
  onResume: (conversationId: string) => void;
}

/**
 * Left-rail list of this clinician's prior conversations on the active
 * patient. Mirrors the legacy panel's `.copilot-history` sidebar:
 * snippet + relative timestamp + turn-count badge per row, infinite-
 * scrolled by an `IntersectionObserver` against a sentinel.
 */
export function CopilotHistory({
  pid,
  proxyUrl,
  activeConversationId,
  onResume,
}: CopilotHistoryProps): ReactElement {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextBefore, setNextBefore] = useState<NextBefore | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  const loadPage = useCallback(async () => {
    if (loading || exhausted) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        action: 'conversation_history',
        pid: String(pid),
        limit: '50',
      });
      if (nextBefore !== null) {
        params.set('before_updated_at', nextBefore.updatedAt);
        params.set('before_id', nextBefore.id);
      }
      const response = await fetch(`${proxyUrl}?${params.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        setExhausted(true);
        return;
      }
      const body = (await response.json()) as HistoryResponse;
      const fresh = Array.isArray(body.items) ? body.items : [];
      setItems((prev) => [...prev, ...fresh]);
      const nb = body.nextBefore ?? null;
      setNextBefore(nb);
      if (nb === null) setExhausted(true);
    } catch {
      setExhausted(true);
    } finally {
      setLoading(false);
    }
  }, [pid, proxyUrl, nextBefore, loading, exhausted]);

  // Reset and reload when the patient changes.
  useEffect(() => {
    setItems([]);
    setNextBefore(null);
    setExhausted(false);
  }, [pid]);

  // Initial fetch (and re-fetch after pid reset). The reset above
  // clears `exhausted`, so this fires again after the patient switch.
  useEffect(() => {
    if (items.length === 0 && !exhausted && !loading) {
      void loadPage();
    }
  }, [items.length, exhausted, loading, loadPage]);

  // Infinite scroll: observe the sentinel <li> and load the next page
  // when it enters the scroll viewport.
  useEffect(() => {
    const node = sentinelRef.current;
    if (node === null) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !loading && !exhausted) {
            void loadPage();
          }
        }
      },
      { rootMargin: '120px', threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadPage, loading, exhausted]);

  return (
    <aside className="copilot-history" data-testid="copilot-history">
      <h3 className="copilot-history__title">History</h3>
      {items.length === 0 && exhausted ? (
        <p className="copilot-history__empty">No prior conversations yet.</p>
      ) : (
        <ul className="copilot-history__list">
          {items.map((item) => (
            <li key={item.conversationId}>
              <button
                type="button"
                className="copilot-history__row"
                data-active={item.conversationId === activeConversationId ? 'true' : 'false'}
                data-testid="copilot-history-row"
                data-conv-id={item.conversationId}
                onClick={() => onResume(item.conversationId)}
              >
                <span
                  className={
                    'copilot-history__row-snippet' +
                    (item.firstQuestion === null
                      ? ' copilot-history__row-snippet--briefing'
                      : '')
                  }
                >
                  {item.firstQuestion ?? 'Briefing only'}
                </span>
                <span className="copilot-history__row-meta">
                  <span className="copilot-history__row-time">
                    {formatRelativeTime(item.updatedAt)}
                  </span>
                  <span className="copilot-history__row-count">
                    {item.messageCount}{' '}
                    {item.messageCount === 1 ? 'turn' : 'turns'}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!exhausted && <li ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />}
        </ul>
      )}
    </aside>
  );
}

function formatRelativeTime(iso: string): string {
  if (iso === '') return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const deltaSec = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));
  if (deltaSec < 60) return 'just now';
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return then.toLocaleDateString();
}
