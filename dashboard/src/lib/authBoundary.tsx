import {
  Component,
  useEffect,
  type ReactElement,
  type ReactNode,
} from 'react';
import { FhirSessionContext, NotAuthenticatedError } from './auth';
import type { Client } from './fhir';

export interface FhirSessionProviderProps {
  client: Client | null;
  children: ReactNode;
}

export function FhirSessionProvider({
  client,
  children,
}: FhirSessionProviderProps): ReactElement {
  return <FhirSessionContext.Provider value={client}>{children}</FhirSessionContext.Provider>;
}

interface AuthBoundaryProps {
  onUnauthenticated: () => void;
  children: ReactNode;
}

interface AuthBoundaryState {
  unauthenticated: boolean;
}

export class AuthBoundary extends Component<AuthBoundaryProps, AuthBoundaryState> {
  state: AuthBoundaryState = { unauthenticated: false };

  static getDerivedStateFromError(error: unknown): AuthBoundaryState | null {
    if (error instanceof NotAuthenticatedError) {
      return { unauthenticated: true };
    }
    return null;
  }

  componentDidCatch(error: unknown): void {
    if (!(error instanceof NotAuthenticatedError)) {
      // Re-throw so a global ErrorBoundary higher up the tree handles it.
      throw error;
    }
  }

  render(): ReactNode {
    if (this.state.unauthenticated) {
      return <RedirectToLogin onRedirect={this.props.onUnauthenticated} />;
    }
    return this.props.children;
  }
}

function RedirectToLogin({ onRedirect }: { onRedirect: () => void }): ReactElement {
  useEffect(() => {
    onRedirect();
  }, [onRedirect]);

  return (
    <div role="status">
      <p>Redirecting to sign in…</p>
    </div>
  );
}
