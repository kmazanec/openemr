import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle, CareTeam } from '@medplum/fhirtypes';
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

const team: CareTeam = {
  resourceType: 'CareTeam',
  id: 'ct1',
  status: 'active',
  participant: [
    {
      member: { reference: 'Practitioner/p1', display: 'Dr. Alice Smith' },
      role: [{ coding: [{ display: 'Primary Care Physician' }] }],
    },
    {
      member: { reference: 'Practitioner/p2', display: 'Bob Jones, RN' },
      // No role
    },
    {
      // No display, no reference
      role: [{ text: 'Care Coordinator' }],
    },
  ],
  subject: { reference: 'Patient/42' },
};

describe('CareTeamCard', () => {
  it('queries CareTeam with status=active and the include for participants', async () => {
    const { CareTeamCard } = await import('./CareTeamCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <CareTeamCard pid="42" />);

    expect(client.request).toHaveBeenCalledWith(
      'CareTeam?patient=42&status=active&_include=CareTeam:participant',
    );
  });

  it('renders participant displays and roles', async () => {
    const { CareTeamCard } = await import('./CareTeamCard');
    const bundle: Bundle<CareTeam> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: team }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <CareTeamCard pid="42" />);

    expect(await screen.findByText(/Dr. Alice Smith/)).toBeInTheDocument();
    expect(screen.getByText(/Primary Care Physician/)).toBeInTheDocument();
    expect(screen.getByText(/Bob Jones, RN/)).toBeInTheDocument();
  });

  it('handles a participant with a missing role display gracefully', async () => {
    const { CareTeamCard } = await import('./CareTeamCard');
    const bundle: Bundle<CareTeam> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: team }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <CareTeamCard pid="42" />);

    // Bob's row has no role; the cell renders an em dash.
    const bobRow = (await screen.findByText(/Bob Jones, RN/)).closest('tr');
    expect(bobRow).not.toBeNull();
    expect(bobRow?.textContent).toContain('—');
  });

  it('falls back to role.text when role.coding is absent', async () => {
    const { CareTeamCard } = await import('./CareTeamCard');
    const bundle: Bundle<CareTeam> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: team }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <CareTeamCard pid="42" />);

    expect(await screen.findByText(/Care Coordinator/)).toBeInTheDocument();
  });

  it('shows an empty state when there is no active care team', async () => {
    const { CareTeamCard } = await import('./CareTeamCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <CareTeamCard pid="42" />);

    expect(await screen.findByText(/No active care team/i)).toBeInTheDocument();
  });
});
