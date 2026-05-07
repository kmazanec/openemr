import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const rx: MedicationRequest = {
  resourceType: 'MedicationRequest',
  id: 'r1',
  status: 'active',
  intent: 'order',
  authoredOn: '2026-04-12',
  medicationCodeableConcept: { text: 'Atorvastatin 20 mg tablet' },
  dosageInstruction: [{ text: '1 tab nightly' }],
  subject: { reference: 'Patient/42' },
};

describe('PrescriptionsCard', () => {
  const original = { erx: (window as unknown as Record<string, unknown>).erx_enable };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).erx_enable = original.erx;
  });

  it('queries MedicationRequest with intent=order and status=active', async () => {
    (window as unknown as Record<string, unknown>).erx_enable = false;
    const { PrescriptionsCard } = await import('./PrescriptionsCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <PrescriptionsCard pid="42" />);

    expect(client.request).toHaveBeenCalledWith(
      'MedicationRequest?patient=42&status=active&intent=order',
    );
  });

  it('when erx_enable=true, the Add link goes to eRx.php?page=compose', async () => {
    (window as unknown as Record<string, unknown>).erx_enable = true;
    const { PrescriptionsCard } = await import('./PrescriptionsCard');
    const bundle: Bundle<MedicationRequest> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: rx }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <PrescriptionsCard pid="42" />);

    const addLink = await screen.findByRole('link', { name: /add prescription/i });
    expect(addLink.getAttribute('href')).toContain('eRx.php');
    expect(addLink.getAttribute('href')).toContain('page=compose');
  });

  it('when erx_enable=false, the Add link goes to controller.php?prescription', async () => {
    (window as unknown as Record<string, unknown>).erx_enable = false;
    const { PrescriptionsCard } = await import('./PrescriptionsCard');
    const bundle: Bundle<MedicationRequest> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: rx }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <PrescriptionsCard pid="42" />);

    const addLink = await screen.findByRole('link', { name: /add prescription/i });
    expect(addLink.getAttribute('href')).toContain('controller.php');
    expect(addLink.getAttribute('href')).toContain('prescription');
    expect(addLink.getAttribute('href')).toContain('id=42');
  });

  it('renders prescription details from the bundle', async () => {
    (window as unknown as Record<string, unknown>).erx_enable = false;
    const { PrescriptionsCard } = await import('./PrescriptionsCard');
    const bundle: Bundle<MedicationRequest> = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: rx }],
    };
    const client = clientReturning(bundle);

    await renderWithClient(client, <PrescriptionsCard pid="42" />);

    expect(await screen.findByText(/Atorvastatin 20 mg tablet/)).toBeInTheDocument();
    expect(screen.getByText(/1 tab nightly/)).toBeInTheDocument();
    expect(screen.getByText(/2026-04-12/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no active prescriptions', async () => {
    (window as unknown as Record<string, unknown>).erx_enable = false;
    const { PrescriptionsCard } = await import('./PrescriptionsCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <PrescriptionsCard pid="42" />);

    expect(await screen.findByText(/No active prescriptions/i)).toBeInTheDocument();
  });
});
