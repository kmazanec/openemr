import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentFactReview } from './DocumentFactReview';
import type { Claim, DocumentClaimGroup } from '../lib/copilotTypes';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'c1',
    text: 'Patient takes Lisinopril 10mg daily.',
    category: 'medication_statement',
    safetyCritical: false,
    sourceReferences: [
      {
        source_type: 'extracted_document',
        source_id: 'art-123',
        locator: { field: 'medications[0]', page: 1 },
        quote: 'Lisinopril 10mg PO daily',
        meta: { document_uuid: 'doc-abc' },
      },
    ],
    ...overrides,
  };
}

function makeGroup(claims: Claim[] = [makeClaim()]): DocumentClaimGroup {
  return {
    cards: [{ documentUuid: 'doc-abcdef12', claims }],
  };
}

// Most tests don't care about chip clicks; the dedicated chip test
// uses a `vi.fn()` instead.
const noopChipClick = (): void => undefined;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DocumentFactReview', () => {
  it('renders one row per extracted fact with Accept / Reject buttons', () => {
    render(
      <DocumentFactReview
        group={makeGroup()}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId="conv-1"
        onChipClick={noopChipClick}
      />,
    );
    expect(screen.getByTestId('copilot-fact-review')).toBeInTheDocument();
    expect(screen.getByTestId('copilot-fact-review-row')).toBeInTheDocument();
    expect(screen.getByTestId('copilot-fact-accept')).toBeEnabled();
    expect(screen.getByTestId('copilot-fact-reject')).toBeEnabled();
  });

  it('renders a per-claim [source] chip and dispatches its click to onChipClick', () => {
    const onChipClick = vi.fn();
    render(
      <DocumentFactReview
        group={makeGroup()}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId="conv-1"
        onChipClick={onChipClick}
      />,
    );
    const chip = screen.getByTestId('copilot-chip');
    expect(chip).toHaveAttribute('data-source-type', 'extracted_document');
    expect(chip).toHaveTextContent('[source]');
    fireEvent.click(chip);
    expect(onChipClick).toHaveBeenCalledTimes(1);
    const call = onChipClick.mock.calls[0] as [Claim, unknown, HTMLElement];
    expect(call[0].id).toBe('c1');
    expect(call[2]).toBe(chip);
  });

  it('POSTs to ?action=accept_fact and locks the row on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ idempotentHit: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(
      <DocumentFactReview
        group={makeGroup()}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId="conv-1"
        onChipClick={noopChipClick}
        fetchFn={fetchMock as unknown as typeof fetch}
      />,
    );
    fireEvent.click(screen.getByTestId('copilot-fact-accept'));

    await waitFor(() => {
      expect(screen.getByTestId('copilot-fact-accept')).toHaveTextContent(
        'Accepted',
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('/proxy.php?action=accept_fact&pid=42');
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({
      artifactId: 'art-123',
      fieldPath: 'medications[0]',
      factType: 'medication_statement',
      conversationId: 'conv-1',
    });
    expect(screen.getByTestId('copilot-fact-accept')).toBeDisabled();
    expect(screen.getByTestId('copilot-fact-reject')).toBeDisabled();
  });

  it('shows "Already in chart" when the accept response reports idempotentHit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ idempotentHit: true }), { status: 200 }),
    );
    render(
      <DocumentFactReview
        group={makeGroup()}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId="conv-1"
        onChipClick={noopChipClick}
        fetchFn={fetchMock as unknown as typeof fetch}
      />,
    );
    fireEvent.click(screen.getByTestId('copilot-fact-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('copilot-fact-accept')).toHaveTextContent(
        'Already in chart',
      );
    });
  });

  it('POSTs to ?action=dispositions on Reject and dims the row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    render(
      <DocumentFactReview
        group={makeGroup()}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId="conv-1"
        onChipClick={noopChipClick}
        fetchFn={fetchMock as unknown as typeof fetch}
      />,
    );
    fireEvent.click(screen.getByTestId('copilot-fact-reject'));
    await waitFor(() => {
      expect(screen.getByTestId('copilot-fact-reject')).toHaveTextContent(
        'Rejected',
      );
    });
    const row = screen.getByTestId('copilot-fact-review-row');
    expect(row).toHaveAttribute('data-status', 'rejected');
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('/proxy.php?action=dispositions&pid=42');
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({
      artifactId: 'art-123',
      fieldPath: 'medications[0]',
      status: 'rejected',
    });
  });

  it('renders an error message and re-enables the buttons on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'promote_failed' }), { status: 500 }),
    );
    render(
      <DocumentFactReview
        group={makeGroup()}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId={null}
        onChipClick={noopChipClick}
        fetchFn={fetchMock as unknown as typeof fetch}
      />,
    );
    fireEvent.click(screen.getByTestId('copilot-fact-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('copilot-fact-error')).toHaveTextContent(
        /OpenEMR could not write/,
      );
    });
    expect(screen.getByTestId('copilot-fact-accept')).toBeEnabled();
    expect(screen.getByTestId('copilot-fact-reject')).toBeEnabled();
  });

  it('marks claims with no extracted_document ref as "Not promotable"', () => {
    const claim = makeClaim({
      sourceReferences: [
        {
          source_type: 'chart',
          source_id: 'enc-7',
          locator: { field: 'encounter.summary' },
          quote: 'in-chart fact',
        },
      ],
    });
    render(
      <DocumentFactReview
        group={makeGroup([claim])}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId={null}
        onChipClick={noopChipClick}
      />,
    );
    expect(screen.getByText(/Not promotable/i)).toBeInTheDocument();
    expect(screen.queryByTestId('copilot-fact-accept')).not.toBeInTheDocument();
  });

  it('omits the panel entirely when the group has no cards', () => {
    const { container } = render(
      <DocumentFactReview
        group={{ cards: [] }}
        proxyUrl="/proxy.php"
        pid={42}
        conversationId={null}
        onChipClick={noopChipClick}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
