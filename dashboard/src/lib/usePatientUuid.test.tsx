import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bundle, Patient } from '@medplum/fhirtypes';
import type { ReactElement } from 'react';

vi.mock('fhirclient/lib/entry/browser', () => ({
  default: {
    oauth2: { authorize: vi.fn(), ready: vi.fn() },
  },
}));

interface FakeClient {
  request: ReturnType<typeof vi.fn>;
  patient?: { id?: string };
}

function makeClient(opts: {
  patientId?: string;
  request?: (url: string) => Promise<unknown>;
}): FakeClient {
  return {
    request: vi.fn(opts.request ?? (() => Promise.reject(new Error('not stubbed')))),
    patient: opts.patientId !== undefined ? { id: opts.patientId } : undefined,
  };
}

async function renderWithClient(client: FakeClient, ui: ReactElement) {
  const { FhirSessionProvider } = await import('./authBoundary');
  await act(async () => {
    render(
      <FhirSessionProvider client={client as never}>{ui}</FhirSessionProvider>,
    );
    await Promise.resolve();
  });
}

function bundleOf(patient: Patient): Bundle<Patient> {
  return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: patient }] };
}

const emptyBundle: Bundle<Patient> = {
  resourceType: 'Bundle',
  type: 'searchset',
  entry: [],
};

describe('usePatientUuid', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the SMART context patient UUID immediately when present', async () => {
    const { usePatientUuid } = await import('./usePatientUuid');
    const client = makeClient({ patientId: 'launch-uuid-1' });

    function Probe(): ReactElement {
      const r = usePatientUuid('42');
      return (
        <div>
          uuid={r.uuid ?? 'null'} loading={String(r.loading)} error={r.error?.message ?? 'null'}
        </div>
      );
    }

    await renderWithClient(client, <Probe />);
    expect(await screen.findByText(/uuid=launch-uuid-1/)).toBeInTheDocument();
    expect(screen.getByText(/loading=false/)).toBeInTheDocument();
    // No identifier lookup needed when the SMART context already
    // has the patient.
    expect(client.request).not.toHaveBeenCalled();
  });

  it('falls back to ?identifier= lookup when the SMART context has no patient', async () => {
    const { usePatientUuid } = await import('./usePatientUuid');
    const patient: Patient = { resourceType: 'Patient', id: 'looked-up-uuid' };
    const client = makeClient({
      request: () => Promise.resolve(bundleOf(patient)),
    });

    function Probe(): ReactElement {
      const r = usePatientUuid('42');
      return <div>uuid={r.uuid ?? 'null'}</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(await screen.findByText(/uuid=looked-up-uuid/)).toBeInTheDocument();
    expect(client.request).toHaveBeenCalledWith('Patient?identifier=42');
  });

  it('reports uuid=null and no error when the lookup returns an empty bundle', async () => {
    const { usePatientUuid } = await import('./usePatientUuid');
    const client = makeClient({
      request: () => Promise.resolve(emptyBundle),
    });

    function Probe(): ReactElement {
      const r = usePatientUuid('42');
      return (
        <div>
          uuid={r.uuid ?? 'null'} loading={String(r.loading)} error={r.error?.message ?? 'null'}
        </div>
      );
    }

    await renderWithClient(client, <Probe />);
    await waitFor(() =>
      expect(screen.getByText(/uuid=null/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/loading=false/)).toBeInTheDocument();
    expect(screen.getByText(/error=null/)).toBeInTheDocument();
  });

  it('surfaces an error when the lookup rejects', async () => {
    const { usePatientUuid } = await import('./usePatientUuid');
    const client = makeClient({
      request: () => Promise.reject(new Error('network down')),
    });

    function Probe(): ReactElement {
      const r = usePatientUuid('42');
      return <div>error={r.error?.message ?? 'null'}</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(await screen.findByText(/error=network down/)).toBeInTheDocument();
  });

  it('encodes the pid in the lookup URL', async () => {
    const { usePatientUuid } = await import('./usePatientUuid');
    const client = makeClient({
      request: () => Promise.resolve(emptyBundle),
    });

    function Probe(): ReactElement {
      usePatientUuid('foo bar');
      return <div>probe</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(client.request).toHaveBeenCalledWith('Patient?identifier=foo%20bar');
  });
});
