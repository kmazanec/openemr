import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle, Encounter } from '@medplum/fhirtypes';
import type { ReactNode } from 'react';

vi.mock('fhirclient/lib/entry/browser', () => ({
  default: { oauth2: { authorize: vi.fn(), ready: vi.fn() } },
}));

interface FakeClient {
  request: ReturnType<typeof vi.fn>;
}

function clientReturning(value: unknown): FakeClient {
  return { request: vi.fn(() => Promise.resolve(value)) };
}

async function renderWithClient(client: FakeClient, ui: ReactNode) {
  const { FhirSessionProvider } = await import('../lib/authBoundary');
  await act(async () => {
    render(<FhirSessionProvider client={client as never}>{ui}</FhirSessionProvider>);
    await Promise.resolve();
  });
}

const recent: Bundle<Encounter> = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 2,
  entry: [
    {
      resource: {
        resourceType: 'Encounter',
        id: 'e1',
        status: 'finished',
        class: { code: 'AMB' },
        period: { start: '2026-04-30T09:00:00Z' },
        type: [{ coding: [{ display: 'Office Visit' }] }],
        participant: [
          {
            individual: { display: 'Dr. Alice Smith' },
          },
        ],
        reasonCode: [{ text: 'Follow-up visit' }],
        subject: { reference: 'Patient/42' },
      },
    },
    {
      resource: {
        resourceType: 'Encounter',
        id: 'e2',
        status: 'finished',
        class: { code: 'AMB' },
        period: { start: '2026-03-15T14:00:00Z' },
        // No type, no participant, no reasonCode
        subject: { reference: 'Patient/42' },
      },
    },
  ],
};

describe('EncountersCard', () => {
  it('queries Encounter sorted by -date with count=10', async () => {
    const { EncountersCard } = await import('./EncountersCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <EncountersCard pid="42" />);

    expect(client.request).toHaveBeenCalledWith(
      'Encounter?patient=42&_sort=-date&_count=10',
    );
  });

  it('renders date, type, provider, and reason for each encounter', async () => {
    const { EncountersCard } = await import('./EncountersCard');
    const client = clientReturning(recent);

    await renderWithClient(client, <EncountersCard pid="42" />);

    expect(await screen.findByText(/2026-04-30/)).toBeInTheDocument();
    expect(screen.getByText(/Office Visit/)).toBeInTheDocument();
    expect(screen.getByText(/Dr. Alice Smith/)).toBeInTheDocument();
    expect(screen.getByText(/Follow-up visit/)).toBeInTheDocument();
  });

  it('handles encounters with missing optional fields', async () => {
    const { EncountersCard } = await import('./EncountersCard');
    const client = clientReturning(recent);

    await renderWithClient(client, <EncountersCard pid="42" />);

    // The second encounter renders even with missing type/participant/reason.
    expect(await screen.findByText(/2026-03-15/)).toBeInTheDocument();
  });

  it('shows the no-recent-encounters empty state in the same shape as other cards', async () => {
    const { EncountersCard } = await import('./EncountersCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <EncountersCard pid="42" />);

    expect(await screen.findByText(/No recent encounters/i)).toBeInTheDocument();
  });

  it('does not render row click handlers (no click-through in W2)', async () => {
    const { EncountersCard } = await import('./EncountersCard');
    const client = clientReturning(recent);

    await renderWithClient(client, <EncountersCard pid="42" />);

    // No buttons or links inside the table body — the rows are read-only.
    const rows = await screen.findAllByRole('row');
    for (const row of rows) {
      expect(row.querySelector('a')).toBeNull();
      expect(row.querySelector('button')).toBeNull();
    }
  });
});
