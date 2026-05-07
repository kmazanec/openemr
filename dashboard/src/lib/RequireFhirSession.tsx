import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import { completeAuthorization, type Client } from './fhir';
import { FhirSessionProvider } from './authBoundary';

type State =
  | { kind: 'pending' }
  | { kind: 'ready'; client: Client }
  | { kind: 'unauthenticated' };

export interface RequireFhirSessionProps {
  children: ReactNode;
}

// Hydrates the FHIR session at the root of any patient-scoped subtree.
// On first render, calls FHIR.oauth2.ready() (which reads the
// session-storage entry written by the /auth/callback route). On
// success, mounts <FhirSessionProvider> with the live client so the
// downstream cards' useFhirRequest hooks have an authenticated client
// to talk to. On failure, sends the user to /login.
export function RequireFhirSession({ children }: RequireFhirSessionProps): ReactElement {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'pending' });

  useEffect(() => {
    let cancelled = false;
    completeAuthorization()
      .then((client) => {
        if (cancelled) return;
        setState({ kind: 'ready', client });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: 'unauthenticated' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.kind === 'unauthenticated') {
      void router.navigate({ to: '/login' });
    }
  }, [state, router]);

  if (state.kind === 'pending') {
    return (
      <div role="status" className="p-3">
        <p>Loading patient…</p>
      </div>
    );
  }

  if (state.kind === 'unauthenticated') {
    return (
      <div role="status" className="p-3">
        <p>Redirecting to sign in…</p>
      </div>
    );
  }

  return <FhirSessionProvider client={state.client}>{children}</FhirSessionProvider>;
}
