import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bundle, Condition } from '@medplum/fhirtypes';
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

const ICD10_SYS = 'http://hl7.org/fhir/sid/icd-10-cm';
const SNOMED_SYS = 'http://snomed.info/sct';

const conditions: Bundle<Condition> = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 3,
  entry: [
    {
      resource: {
        resourceType: 'Condition',
        id: 'c1',
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: {
          coding: [
            { system: ICD10_SYS, code: 'E11.9', display: 'Type 2 diabetes mellitus' },
            { system: SNOMED_SYS, code: '44054006', display: 'Diabetes mellitus type 2' },
          ],
        },
        onsetDateTime: '2020-04-12',
        category: [{ coding: [{ code: 'problem-list-item' }] }],
        subject: { reference: 'Patient/42' },
      },
    },
    {
      resource: {
        resourceType: 'Condition',
        id: 'c2',
        clinicalStatus: { coding: [{ code: 'resolved' }] },
        code: { coding: [{ system: ICD10_SYS, code: 'J45.909', display: 'Asthma, unspecified' }] },
        onsetDateTime: '2010-01-01',
        category: [{ coding: [{ code: 'problem-list-item' }] }],
        subject: { reference: 'Patient/42' },
      },
    },
    {
      resource: {
        resourceType: 'Condition',
        id: 'c3',
        clinicalStatus: { coding: [{ code: 'active' }] },
        code: { text: 'Lower back pain' },
        category: [{ coding: [{ code: 'problem-list-item' }] }],
        subject: { reference: 'Patient/42' },
      },
    },
  ],
};

describe('ProblemListCard', () => {
  it('queries Condition with the problem-list-item category for the patient', async () => {
    const { ProblemListCard } = await import('./ProblemListCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <ProblemListCard pid="42" />);

    expect(client.request).toHaveBeenCalledWith(
      'Condition?patient=42&category=problem-list-item',
    );
  });

  it('only renders active conditions (filters out resolved)', async () => {
    const { ProblemListCard } = await import('./ProblemListCard');
    const client = clientReturning(conditions);

    await renderWithClient(client, <ProblemListCard pid="42" />);

    expect(await screen.findByText(/Diabetes mellitus type 2/)).toBeInTheDocument();
    expect(screen.getByText(/Lower back pain/)).toBeInTheDocument();
    expect(screen.queryByText(/Asthma/)).not.toBeInTheDocument();
  });

  it('prefers SNOMED display over ICD-10 display, falls back to text', async () => {
    const { ProblemListCard } = await import('./ProblemListCard');
    const client = clientReturning(conditions);

    await renderWithClient(client, <ProblemListCard pid="42" />);

    // SNOMED display preferred for c1.
    expect(await screen.findByText(/Diabetes mellitus type 2/)).toBeInTheDocument();
    // c3 has only text — should render the text.
    expect(screen.getByText(/Lower back pain/)).toBeInTheDocument();
  });

  it('renders the onset date and an active status badge', async () => {
    const { ProblemListCard } = await import('./ProblemListCard');
    const client = clientReturning(conditions);

    await renderWithClient(client, <ProblemListCard pid="42" />);

    expect(await screen.findByText(/2020-04-12/)).toBeInTheDocument();
    expect(screen.getAllByText(/active/i).length).toBeGreaterThan(0);
  });

  it('shows an empty state when no active conditions exist', async () => {
    const { ProblemListCard } = await import('./ProblemListCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <ProblemListCard pid="42" />);

    expect(await screen.findByText(/No active problems/i)).toBeInTheDocument();
  });

  it('links View all to the legacy medical_problem stats page', async () => {
    const { ProblemListCard } = await import('./ProblemListCard');
    const client = clientReturning({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await renderWithClient(client, <ProblemListCard pid="42" />);

    const link = screen.getByRole('link', { name: /view all/i });
    expect(link.getAttribute('href')).toContain('stats_full.php');
    expect(link.getAttribute('href')).toContain('category=medical_problem');
  });
});
