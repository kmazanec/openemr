import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Patient } from '@medplum/fhirtypes';
import type { ReactNode } from 'react';

vi.mock('fhirclient/lib/entry/browser', () => ({
  default: {
    oauth2: { authorize: vi.fn(), ready: vi.fn() },
  },
}));

interface FakeClient {
  request: ReturnType<typeof vi.fn>;
}

function clientReturning(value: unknown): FakeClient {
  return { request: vi.fn(() => Promise.resolve(value)) };
}

function clientRejecting(err: Error): FakeClient {
  return { request: vi.fn(() => Promise.reject(err)) };
}

async function renderWithClient(client: FakeClient, ui: ReactNode) {
  const { FhirSessionProvider } = await import('../lib/authBoundary');
  let result: ReturnType<typeof render> | null = null;
  await act(async () => {
    result = render(
      <FhirSessionProvider client={client as never}>{ui}</FhirSessionProvider>,
    );
    await Promise.resolve();
  });
  return result!;
}

const fullPatient: Patient = {
  resourceType: 'Patient',
  id: '42',
  active: true,
  gender: 'male',
  birthDate: '1971-06-08',
  name: [{ family: 'Kowalski', given: ['Robert'] }],
  identifier: [
    {
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
      value: 'MRN-12345',
    },
  ],
};

describe('PatientHeader', () => {
  it('renders name, DOB, age, sex, MRN, and an Active badge', async () => {
    const { PatientHeader } = await import('./PatientHeader');
    const client = clientReturning(fullPatient);

    await renderWithClient(client, <PatientHeader pid="42" today={new Date('2026-05-07')} />);

    expect(await screen.findByText(/Robert Kowalski/)).toBeInTheDocument();
    expect(screen.getByText(/1971-06-08/)).toBeInTheDocument();
    expect(screen.getByText(/54/)).toBeInTheDocument();
    expect(screen.getByText(/male/i)).toBeInTheDocument();
    expect(screen.getByText(/MRN-12345/)).toBeInTheDocument();
    expect(screen.getByText(/Active/)).toBeInTheDocument();
    expect(client.request).toHaveBeenCalledWith('Patient/42');
  });

  it('handles missing optional fields gracefully', async () => {
    const { PatientHeader } = await import('./PatientHeader');
    const minimal: Patient = { resourceType: 'Patient', id: '7' };
    const client = clientReturning(minimal);

    await renderWithClient(client, <PatientHeader pid="7" today={new Date('2026-05-07')} />);

    expect(await screen.findByText(/Unknown patient/i)).toBeInTheDocument();
    // No crashes; no MRN row when none present.
    expect(screen.queryByText(/MRN-/)).not.toBeInTheDocument();
  });

  it('renders a Deceased badge when deceasedBoolean is true', async () => {
    const { PatientHeader } = await import('./PatientHeader');
    const deceased: Patient = { ...fullPatient, deceasedBoolean: true };
    const client = clientReturning(deceased);

    await renderWithClient(client, <PatientHeader pid="42" today={new Date('2026-05-07')} />);

    expect(await screen.findByText(/Deceased/)).toBeInTheDocument();
  });

  it('renders a Deceased badge when deceasedDateTime is set', async () => {
    const { PatientHeader } = await import('./PatientHeader');
    const deceased: Patient = { ...fullPatient, deceasedDateTime: '2024-01-01' };
    const client = clientReturning(deceased);

    await renderWithClient(client, <PatientHeader pid="42" today={new Date('2026-05-07')} />);

    expect(await screen.findByText(/Deceased/)).toBeInTheDocument();
  });

  it('renders an Inactive badge for active=false', async () => {
    const { PatientHeader } = await import('./PatientHeader');
    const inactive: Patient = { ...fullPatient, active: false };
    const client = clientReturning(inactive);

    await renderWithClient(client, <PatientHeader pid="42" today={new Date('2026-05-07')} />);

    expect(await screen.findByText(/Inactive/)).toBeInTheDocument();
  });

  it('renders a skeleton placeholder while loading (not a spinner)', async () => {
    const { PatientHeader } = await import('./PatientHeader');
    const pending = new Promise(() => {}); // never resolves
    const client: FakeClient = { request: vi.fn(() => pending) };

    await renderWithClient(client, <PatientHeader pid="42" today={new Date('2026-05-07')} />);

    const skeleton = screen.getByTestId('patient-header-skeleton');
    expect(skeleton).toBeInTheDocument();
    // Skeleton should not be role=status — that's a spinner pattern. We
    // explicitly avoid layout-shifting spinners for this header.
    expect(skeleton.getAttribute('role')).not.toBe('status');
  });

  it('shows a retry-able error state when the FHIR request fails', async () => {
    const { PatientHeader } = await import('./PatientHeader');
    const client = clientRejecting(new Error('network down'));

    await renderWithClient(client, <PatientHeader pid="42" today={new Date('2026-05-07')} />);

    expect(await screen.findByText(/Couldn.t load patient/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });
    expect(retry).toBeInTheDocument();

    // Clicking retry calls the FHIR client a second time.
    client.request.mockImplementationOnce(() => Promise.resolve(fullPatient));
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});
