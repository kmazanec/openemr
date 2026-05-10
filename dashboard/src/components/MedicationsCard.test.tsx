import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle, MedicationRequest } from '@medplum/fhirtypes';
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

const dosed: MedicationRequest = {
  resourceType: 'MedicationRequest',
  id: 'm1',
  status: 'active',
  intent: 'plan',
  medicationCodeableConcept: { text: 'Lisinopril 10 mg tablet' },
  dosageInstruction: [
    {
      text: '1 tablet by mouth daily',
      route: { coding: [{ display: 'Oral' }] },
      timing: { code: { text: 'daily' } },
    },
  ],
  subject: { reference: 'Patient/42' },
};

const undosed: MedicationRequest = {
  resourceType: 'MedicationRequest',
  id: 'm2',
  status: 'active',
  intent: 'plan',
  medicationCodeableConcept: { text: 'Multivitamin' },
  // no dosageInstruction
  subject: { reference: 'Patient/42' },
};

describe('MedicationsCard', () => {
  it('queries MedicationRequest with intent=plan and status=active', async () => {
    const { MedicationsCard } = await import('./MedicationsCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <MedicationsCard pid="42" />);

    expect(client.request).toHaveBeenCalledWith(
      'MedicationRequest?patient=42&status=active&intent=plan',
    );
  });

  it('renders a dosed medication with drug, dose, route, frequency', async () => {
    const { MedicationsCard } = await import('./MedicationsCard');
    const bundle: Bundle<MedicationRequest> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: dosed }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <MedicationsCard pid="42" />);

    expect(await screen.findByText(/Lisinopril 10 mg tablet/)).toBeInTheDocument();
    expect(screen.getByText(/1 tablet by mouth daily/)).toBeInTheDocument();
    expect(screen.getByText(/Oral/)).toBeInTheDocument();
    // Frequency cell renders the timing.code.text — "daily" — alongside dose.
    expect(screen.getAllByText(/daily/i).length).toBeGreaterThan(0);
  });

  it('renders an undosed medication without crashing', async () => {
    const { MedicationsCard } = await import('./MedicationsCard');
    const bundle: Bundle<MedicationRequest> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: undosed }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <MedicationsCard pid="42" />);

    expect(await screen.findByText(/Multivitamin/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no active medications', async () => {
    const { MedicationsCard } = await import('./MedicationsCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <MedicationsCard pid="42" />);

    expect(await screen.findByText(/No active medications/i)).toBeInTheDocument();
  });

  it('renders the Medications title and an Add medication button', async () => {
    const { MedicationsCard } = await import('./MedicationsCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <MedicationsCard pid="42" />);

    expect(await screen.findByText('Medications')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add medication/i })).toBeInTheDocument();
  });
});
