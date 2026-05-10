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
    render(
      <FhirSessionProvider client={client as never}>{ui}</FhirSessionProvider>,
    );
    await Promise.resolve();
  });
}

const emptyBundle: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 0,
  entry: [],
};

const oneAllergy: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 1,
  entry: [
    {
      resource: {
        resourceType: 'AllergyIntolerance',
        id: 'a1',
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }],
        },
        verificationStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }],
        },
        code: { text: 'Penicillin' },
        criticality: 'high',
        reaction: [{ manifestation: [{ text: 'Hives' }] }],
        patient: { reference: 'Patient/42' },
      },
    },
  ],
};

const multipleAllergiesWithMissingFields: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  total: 2,
  entry: [
    {
      resource: {
        resourceType: 'AllergyIntolerance',
        id: 'a1',
        code: { text: 'Peanuts' },
        criticality: 'low',
        reaction: [{ manifestation: [{ text: 'Rash' }] }],
        patient: { reference: 'Patient/42' },
      },
    },
    {
      resource: {
        resourceType: 'AllergyIntolerance',
        id: 'a2',
        // No code.text, no criticality, no reaction, no verificationStatus
        patient: { reference: 'Patient/42' },
      },
    },
  ],
};

describe('AllergiesCard', () => {
  it('queries AllergyIntolerance for the active patient (unfiltered; active narrowing happens client-side)', async () => {
    const { AllergiesCard } = await import('./AllergiesCard');
    const client = clientReturning(emptyBundle);

    await renderWithClient(client, <AllergiesCard pid="42" />);

    // The FHIR layer doesn't register `clinical-status` as a search
    // parameter, so passing it would make the search throw and
    // return an empty bundle silently. Fetching unfiltered avoids
    // that, and the body filters to active rows in JS.
    expect(client.request).toHaveBeenCalledWith('AllergyIntolerance?patient=42');
  });

  it('renders an empty state when there are no allergies', async () => {
    const { AllergiesCard } = await import('./AllergiesCard');
    const client = clientReturning(emptyBundle);

    await renderWithClient(client, <AllergiesCard pid="42" />);

    expect(await screen.findByText(/No known active allergies/i)).toBeInTheDocument();
  });

  it('renders a single allergy with allergen, severity, reaction, and verification', async () => {
    const { AllergiesCard } = await import('./AllergiesCard');
    const client = clientReturning(oneAllergy);

    await renderWithClient(client, <AllergiesCard pid="42" />);

    expect(await screen.findByText(/Penicillin/)).toBeInTheDocument();
    expect(screen.getByText(/high/i)).toBeInTheDocument();
    expect(screen.getByText(/Hives/)).toBeInTheDocument();
    expect(screen.getByText(/confirmed/i)).toBeInTheDocument();
  });

  it('renders multiple allergies and tolerates missing fields', async () => {
    const { AllergiesCard } = await import('./AllergiesCard');
    const client = clientReturning(multipleAllergiesWithMissingFields);

    await renderWithClient(client, <AllergiesCard pid="42" />);

    expect(await screen.findByText(/Peanuts/)).toBeInTheDocument();
    // The unknown row still renders without crashing.
    const rows = screen.getAllByRole('row');
    // header + 2 data rows
    expect(rows.length).toBe(3);
  });

  it('shows the title "Allergies" and an Add allergy edit button', async () => {
    const { AllergiesCard } = await import('./AllergiesCard');
    const client = clientReturning(emptyBundle);

    await renderWithClient(client, <AllergiesCard pid="42" />);

    expect(await screen.findByText('Allergies')).toBeInTheDocument();
    // The header pencil opens an in-page modal now instead of
    // navigating to the legacy stats_full.php page.
    const editButton = screen.getByRole('button', { name: /add allergy/i });
    expect(editButton).toBeInTheDocument();
  });

  it('shows a row-level Edit button on each allergy', async () => {
    const { AllergiesCard } = await import('./AllergiesCard');
    const client = clientReturning(oneAllergy);

    await renderWithClient(client, <AllergiesCard pid="42" />);

    expect(await screen.findByText(/Penicillin/)).toBeInTheDocument();
    const rowEdits = screen.getAllByTestId('allergy-row-edit');
    expect(rowEdits.length).toBe(1);
  });
});
