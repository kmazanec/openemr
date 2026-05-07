import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

// Stub fhirclient before importing the routeTree (which transitively
// imports src/lib/fhir.ts, which imports the browser entry).
const authorizeMock = vi.fn();
const readyMock = vi.fn();

vi.mock('fhirclient/lib/entry/browser', () => ({
  default: {
    oauth2: {
      authorize: authorizeMock,
      ready: readyMock,
    },
    AbortController,
    client: vi.fn(),
    FhirClient: vi.fn(),
    utils: {},
  },
}));

const VALID_ENV = {
  VITE_OIDC_ISSUER: 'http://localhost:8300/oauth2/default',
  VITE_OIDC_CLIENT_ID: 'test-client-id',
  VITE_OIDC_REDIRECT_URI: 'http://localhost:5173/auth/callback',
  VITE_OIDC_SCOPE: 'openid fhirUser launch/patient',
};

function setEnv(): void {
  for (const [key, value] of Object.entries(VALID_ENV)) {
    vi.stubEnv(key, value);
  }
}

async function buildRouter(initialPath: string) {
  const { routeTree } = await import('./routeTree');
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe('auth routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    authorizeMock.mockReset();
    readyMock.mockReset();
    setEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('/login calls FHIR.oauth2.authorize with issuer/client/redirect/scope', async () => {
    authorizeMock.mockResolvedValue(undefined);
    const router = await buildRouter('/login');
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(authorizeMock).toHaveBeenCalledTimes(1);
    });

    const params = authorizeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      iss: VALID_ENV.VITE_OIDC_ISSUER,
      clientId: VALID_ENV.VITE_OIDC_CLIENT_ID,
      redirectUri: VALID_ENV.VITE_OIDC_REDIRECT_URI,
      scope: VALID_ENV.VITE_OIDC_SCOPE,
    });
  });

  it('/login renders a "redirecting…" placeholder while authorize resolves', async () => {
    authorizeMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const router = await buildRouter('/login');
    render(<RouterProvider router={router} />);
    expect(await screen.findByText(/redirecting to sign in/i)).toBeInTheDocument();
  });

  it('/auth/callback calls FHIR.oauth2.ready and redirects to /patient/$pid', async () => {
    // Return a client whose .request() resolves to an empty bundle so the
    // patient-route cards (mounted after the redirect) don't blow up the
    // tree with "client.request is not a function" warnings.
    readyMock.mockResolvedValue({
      patient: { id: '7' },
      request: () => Promise.resolve({ resourceType: 'Bundle', entry: [] }),
    });
    const router = await buildRouter('/auth/callback');
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(readyMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/patient/7');
    });
  });

  it('/auth/callback falls back to /dashboard when no patient in SMART context', async () => {
    readyMock.mockResolvedValue({
      patient: null,
      request: () => Promise.resolve({ resourceType: 'Bundle', entry: [] }),
    });
    const router = await buildRouter('/auth/callback');
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
  });

  it('/auth/callback shows an error message when FHIR.oauth2.ready rejects', async () => {
    readyMock.mockRejectedValue(new Error('PKCE state mismatch'));
    const router = await buildRouter('/auth/callback');
    render(<RouterProvider router={router} />);

    expect(await screen.findByText(/could not finish sign in/i)).toBeInTheDocument();
  });
});
