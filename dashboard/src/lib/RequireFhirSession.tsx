import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { authorize, completeAuthorization, type Client } from './fhir';
import { FhirSessionProvider } from './authBoundary';

type State =
  | { kind: 'pending' }
  | { kind: 'ready'; client: Client }
  | { kind: 'authorizing' }
  | { kind: 'error'; message: string };

export interface RequireFhirSessionProps {
  children: ReactNode;
  // Legacy integer pid the user is viewing. When present, we
  // request a launch token bound to that patient before kicking off
  // authorize(), so the resulting access token's context.patient is
  // populated and patient-scoped FHIR requests succeed.
  pid?: string;
}

// Hydrates the FHIR session at the root of any patient-scoped subtree.
//
// Three states matter:
//   1. ready — fhirclient.oauth2.ready() resolved with a session
//      (typically because /auth/callback already ran in this browser).
//      Render children with the live client.
//   2. pending — checking sessionStorage for an existing session.
//      Render a placeholder.
//   3. authorizing — no session; we kicked off the SMART OIDC dance
//      via authorize() and the browser is mid-redirect to OpenEMR's
//      authorization endpoint. Render a brief "Signing in…" placeholder
//      until the redirect fires.
//
// We deliberately do NOT navigate to /login here. The login route
// also auto-redirects to authorize(), so going through it is just
// extra hops; calling authorize() directly is the same UX with one
// fewer mount.
export function RequireFhirSession({ children, pid }: RequireFhirSessionProps): ReactElement {
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
        // No session — kick off the SMART authorize redirect. This
        // is a full-page navigation, so component teardown happens
        // naturally; we just need to render something during the
        // brief window before the browser leaves the page.
        setState({ kind: 'authorizing' });
        authorize(pid).catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : 'Unknown error';
          setState({ kind: 'error', message });
        });
      });
    return () => {
      cancelled = true;
    };
  }, [pid]);

  if (state.kind === 'pending') {
    return (
      <div role="status" className="p-3">
        <p>Loading patient…</p>
      </div>
    );
  }

  if (state.kind === 'authorizing') {
    return (
      <div role="status" className="p-3">
        <p>Signing in…</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div role="alert" className="p-3">
        <h2 className="h5">Couldn't sign in to FHIR</h2>
        <p className="text-muted">{state.message}</p>
      </div>
    );
  }

  return <FhirSessionProvider client={state.client}>{children}</FhirSessionProvider>;
}
