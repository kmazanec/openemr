import { Component, type ReactElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fhirclient/lib/entry/browser', () => ({
  default: {
    oauth2: { authorize: vi.fn(), ready: vi.fn() },
    AbortController,
    client: vi.fn(),
    FhirClient: vi.fn(),
    utils: {},
  },
}));

interface BoundaryState {
  caught: Error | null;
}

class CatchingBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { caught: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { caught: error };
  }

  render(): ReactElement {
    if (this.state.caught) {
      return <div data-testid="caught">{this.state.caught.name}</div>;
    }
    return <>{this.props.children}</>;
  }
}

describe('useFhir', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the client when a session is set', async () => {
    const { useFhir } = await import('./auth');
    const { FhirSessionProvider } = await import('./authBoundary');
    const fakeClient = { request: vi.fn(), patient: { id: '7' } };

    function Probe(): ReactElement {
      const client = useFhir();
      return <div>pid={client.patient?.id ?? 'none'}</div>;
    }

    render(
      <FhirSessionProvider client={fakeClient as never}>
        <Probe />
      </FhirSessionProvider>,
    );

    expect(screen.getByText('pid=7')).toBeInTheDocument();
  });

  it('throws NotAuthenticatedError when called outside a session provider', async () => {
    const { useFhir, NotAuthenticatedError } = await import('./auth');

    let caught: unknown = null;
    function Probe(): ReactElement {
      try {
        useFhir();
      } catch (err) {
        caught = err;
        throw err;
      }
      return <div>unreachable</div>;
    }

    // Suppress React's noisy error logging for the expected throw.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <CatchingBoundary>
        <Probe />
      </CatchingBoundary>,
    );
    consoleError.mockRestore();

    expect(caught).toBeInstanceOf(NotAuthenticatedError);
  });

  it('throws NotAuthenticatedError when the provider holds a null client', async () => {
    const { useFhir, NotAuthenticatedError } = await import('./auth');
    const { FhirSessionProvider } = await import('./authBoundary');

    let caught: unknown = null;
    function Probe(): ReactElement {
      try {
        useFhir();
      } catch (err) {
        caught = err;
        throw err;
      }
      return <div>unreachable</div>;
    }

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <FhirSessionProvider client={null}>
        <CatchingBoundary>
          <Probe />
        </CatchingBoundary>
      </FhirSessionProvider>,
    );
    consoleError.mockRestore();

    expect(caught).toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('<AuthBoundary />', () => {
  it('renders the redirect UI and triggers a /login navigation when a child throws NotAuthenticatedError', async () => {
    const { NotAuthenticatedError } = await import('./auth');
    const { AuthBoundary } = await import('./authBoundary');

    const navigate = vi.fn();
    function Throwing(): ReactElement {
      throw new NotAuthenticatedError();
    }

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AuthBoundary onUnauthenticated={navigate}>
        <Throwing />
      </AuthBoundary>,
    );
    consoleError.mockRestore();

    expect(screen.getByText(/redirecting to sign in/i)).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-auth errors so a global error boundary can catch them', async () => {
    const { AuthBoundary } = await import('./authBoundary');

    function Throwing(): ReactElement {
      throw new Error('boom');
    }

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <CatchingBoundary>
        <AuthBoundary onUnauthenticated={() => {}}>
          <Throwing />
        </AuthBoundary>
      </CatchingBoundary>,
    );
    consoleError.mockRestore();

    expect(screen.getByTestId('caught')).toHaveTextContent('Error');
  });
});
