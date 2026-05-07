import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Patient } from '@medplum/fhirtypes';
import type { ReactElement } from 'react';

vi.mock('fhirclient/lib/entry/browser', () => ({
  default: {
    oauth2: { authorize: vi.fn(), ready: vi.fn() },
    AbortController,
    client: vi.fn(),
    FhirClient: vi.fn(),
    utils: {},
  },
}));

interface FakeClient {
  request: ReturnType<typeof vi.fn>;
}

function makeClient(impl: (url: string) => Promise<unknown>): FakeClient {
  return { request: vi.fn(impl) };
}

async function renderWithClient(client: FakeClient, ui: ReactElement) {
  const { FhirSessionProvider } = await import('./authBoundary');
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <FhirSessionProvider client={client as never}>{ui}</FhirSessionProvider>,
    );
    // Let the in-flight promises chain (request.then → setData) flush
    // before we return; otherwise the state updates happen outside
    // the act() and React warns about them.
    await Promise.resolve();
  });
  return result!;
}

describe('useFhirRequest', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls client.request exactly once on mount', async () => {
    const { useFhirRequest } = await import('./useFhirRequest');
    const client = makeClient(() => Promise.resolve({ resourceType: 'Patient', id: '1' }));

    function Probe(): ReactElement {
      const result = useFhirRequest<Patient>('Patient/1');
      if (result.loading) return <div>loading</div>;
      if (result.error !== null) return <div>error</div>;
      return <div>id={result.data?.id ?? 'none'}</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(await screen.findByText('id=1')).toBeInTheDocument();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith('Patient/1');
  });

  it('exposes loading=true before the promise resolves', async () => {
    const { useFhirRequest } = await import('./useFhirRequest');
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const client = makeClient(() => pending);

    function Probe(): ReactElement {
      const result = useFhirRequest<Patient>('Patient/1');
      if (result.loading) return <div>loading</div>;
      return <div>done</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    await act(async () => {
      resolve({ resourceType: 'Patient', id: '1' });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument());
  });

  it('retry() re-fetches', async () => {
    const { useFhirRequest } = await import('./useFhirRequest');
    let call = 0;
    const client = makeClient(() => {
      call += 1;
      return Promise.resolve({ resourceType: 'Patient', id: String(call) });
    });

    let retryFn: (() => void) | null = null;
    function Probe(): ReactElement {
      const result = useFhirRequest<Patient>('Patient/1');
      retryFn = result.retry;
      if (result.loading) return <div>loading</div>;
      if (result.error !== null) return <div>error</div>;
      return <div>id={result.data?.id ?? 'none'}</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(await screen.findByText('id=1')).toBeInTheDocument();
    expect(client.request).toHaveBeenCalledTimes(1);

    await act(async () => {
      retryFn?.();
      await Promise.resolve();
    });
    expect(await screen.findByText('id=2')).toBeInTheDocument();
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('reports a generic error when the FHIR call rejects with a non-401', async () => {
    const { useFhirRequest } = await import('./useFhirRequest');
    const client = makeClient(() => Promise.reject(new Error('network down')));

    function Probe(): ReactElement {
      const result = useFhirRequest<Patient>('Patient/1');
      if (result.loading) return <div>loading</div>;
      if (result.error !== null) return <div>error: {result.error.message}</div>;
      return <div>data</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(await screen.findByText(/error: network down/)).toBeInTheDocument();
  });

  it('translates a 401 from fhirclient into AuthExpiredError', async () => {
    const { useFhirRequest } = await import('./useFhirRequest');
    const { AuthExpiredError } = await import('./auth');

    // fhirclient throws an HttpError with .status on 4xx/5xx.
    const httpError = Object.assign(new Error('401 Unauthorized'), { status: 401 });
    const client = makeClient(() => Promise.reject(httpError));

    let captured: Error | null = null;
    function Probe(): ReactElement {
      const result = useFhirRequest<Patient>('Patient/1');
      if (result.loading) return <div>loading</div>;
      if (result.error !== null) {
        captured = result.error;
        return <div>error: {result.error.name}</div>;
      }
      return <div>data</div>;
    }

    await renderWithClient(client, <Probe />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toBeInstanceOf(AuthExpiredError);
  });

  it('the typed hook returns Patient | undefined for data', async () => {
    const { useFhirRequest } = await import('./useFhirRequest');
    const client = makeClient(() => Promise.resolve({ resourceType: 'Patient', id: '1' }));

    function Probe(): ReactElement {
      const result = useFhirRequest<Patient>('Patient/1');
      // Compile-time: data has type Patient | undefined.
      const idOrNone: string = result.data?.id ?? 'none';
      return <div>id={idOrNone}</div>;
    }

    await renderWithClient(client, <Probe />);
    expect(await screen.findByText('id=1')).toBeInTheDocument();
  });
});
