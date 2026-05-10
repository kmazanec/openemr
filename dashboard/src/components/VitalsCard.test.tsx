import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle, Observation } from '@medplum/fhirtypes';
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
    render(
      <FhirSessionProvider client={client as never}>{ui}</FhirSessionProvider>,
    );
    await Promise.resolve();
  });
}

const empty: Bundle = { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] };

const oneEncounter: Bundle<Observation> = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 4,
  entry: [
    {
      resource: {
        resourceType: 'Observation',
        id: 'bp1',
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
        effectiveDateTime: '2026-04-01T10:00:00Z',
        component: [
          {
            code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
            valueQuantity: { value: 128, unit: 'mmHg' },
          },
          {
            code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] },
            valueQuantity: { value: 82, unit: 'mmHg' },
          },
        ],
        subject: { reference: 'Patient/x' },
      },
    },
    {
      resource: {
        resourceType: 'Observation',
        id: 'hr1',
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        effectiveDateTime: '2026-04-01T10:00:00Z',
        valueQuantity: { value: 72, unit: '/min' },
        subject: { reference: 'Patient/x' },
      },
    },
    {
      resource: {
        resourceType: 'Observation',
        id: 'wt1',
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '29463-7' }] },
        effectiveDateTime: '2026-04-01T10:00:00Z',
        valueQuantity: { value: 188, unit: 'lb' },
        subject: { reference: 'Patient/x' },
      },
    },
    {
      resource: {
        resourceType: 'Observation',
        id: 't1',
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] },
        effectiveDateTime: '2026-04-01T10:00:00Z',
        valueQuantity: { value: 98.6, unit: 'F' },
        subject: { reference: 'Patient/x' },
      },
    },
  ],
};

describe('VitalsCard', () => {
  it('queries Observation with category=vital-signs for the active patient', async () => {
    const { VitalsCard } = await import('./VitalsCard');
    const client = clientReturning(empty);
    await renderWithClient(client, <VitalsCard pid="42" />);
    expect(client.request).toHaveBeenCalledWith(
      'Observation?patient=42&category=vital-signs&_sort=-date&_count=20',
    );
  });

  it('renders an empty state when no observations are returned', async () => {
    const { VitalsCard } = await import('./VitalsCard');
    const client = clientReturning(empty);
    await renderWithClient(client, <VitalsCard pid="42" />);
    expect(await screen.findByText(/No vitals on file/i)).toBeInTheDocument();
  });

  it('collapses BP, heart rate, weight, and temperature into one row per encounter date', async () => {
    const { VitalsCard } = await import('./VitalsCard');
    const client = clientReturning(oneEncounter);
    await renderWithClient(client, <VitalsCard pid="42" />);
    expect(await screen.findByText('2026-04-01')).toBeInTheDocument();
    // BP renders as systolic/diastolic.
    expect(screen.getByText('128/82')).toBeInTheDocument();
    // Heart rate, weight, temperature each render with their unit.
    expect(screen.getByText(/72 \/min/)).toBeInTheDocument();
    expect(screen.getByText(/188 lb/)).toBeInTheDocument();
    expect(screen.getByText(/98\.6 F/)).toBeInTheDocument();
  });

  it('renders an Add vitals button in the card header', async () => {
    const { VitalsCard } = await import('./VitalsCard');
    const client = clientReturning(empty);
    await renderWithClient(client, <VitalsCard pid="42" />);
    expect(screen.getByRole('button', { name: /add vitals/i })).toBeInTheDocument();
  });
});
