import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
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

const emptyBundle: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 0,
  entry: [],
};

const oneReport: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 1,
  entry: [
    {
      resource: {
        resourceType: 'DiagnosticReport',
        id: 'dr1',
        status: 'final',
        category: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' },
            ],
          },
        ],
        code: { text: 'Comprehensive Metabolic Panel' },
        subject: { reference: 'Patient/42' },
        effectiveDateTime: '2026-04-15T08:30:00Z',
      },
    },
  ],
};

const multipleReports: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 2,
  entry: [
    {
      resource: {
        resourceType: 'DiagnosticReport',
        id: 'dr1',
        status: 'final',
        code: { text: 'Lipid Panel' },
        subject: { reference: 'Patient/42' },
        effectiveDateTime: '2026-03-12',
      },
    },
    {
      resource: {
        resourceType: 'DiagnosticReport',
        id: 'dr2',
        status: 'preliminary',
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '24323-8',
              display: 'Comprehensive metabolic 2000 panel',
            },
          ],
        },
        subject: { reference: 'Patient/42' },
        issued: '2025-11-04T10:15:00Z',
      },
    },
  ],
};

describe('LabsCard', () => {
  it('queries DiagnosticReport with category=LAB sorted by date', async () => {
    const { LabsCard } = await import('./LabsCard');
    const client = clientReturning(emptyBundle);

    await renderWithClient(client, <LabsCard pid="42" />);

    expect(client.request).toHaveBeenCalledWith(
      'DiagnosticReport?patient=42&category=LAB&_sort=-date&_count=10',
    );
  });

  it('renders an empty state when there are no reports', async () => {
    const { LabsCard } = await import('./LabsCard');
    const client = clientReturning(emptyBundle);

    await renderWithClient(client, <LabsCard pid="42" />);

    expect(await screen.findByText('Nothing Recorded')).toBeInTheDocument();
    // Hidden screen-reader copy keeps the original phrasing accessible.
    expect(screen.getByText(/No lab results/i)).toBeInTheDocument();
  });

  it('renders a single report with date, test, and status', async () => {
    const { LabsCard } = await import('./LabsCard');
    const client = clientReturning(oneReport);

    await renderWithClient(client, <LabsCard pid="42" />);

    expect(await screen.findByText(/Comprehensive Metabolic Panel/)).toBeInTheDocument();
    // Time is stripped — the column shows the date only.
    expect(screen.getByText('2026-04-15')).toBeInTheDocument();
    expect(screen.getByText('final')).toBeInTheDocument();
  });

  it('falls back to coding.display when code.text is absent', async () => {
    const { LabsCard } = await import('./LabsCard');
    const client = clientReturning(multipleReports);

    await renderWithClient(client, <LabsCard pid="42" />);

    expect(await screen.findByText(/Lipid Panel/)).toBeInTheDocument();
    expect(screen.getByText(/Comprehensive metabolic 2000 panel/)).toBeInTheDocument();
  });

  it('shows the title "Lab Results" and an Add lab result button', async () => {
    const { LabsCard } = await import('./LabsCard');
    const client = clientReturning(emptyBundle);

    await renderWithClient(client, <LabsCard pid="42" />);

    expect(await screen.findByText('Lab Results')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add lab result/i })).toBeInTheDocument();
  });
});
