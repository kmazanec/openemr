import { useEffect, useState, type ReactElement } from 'react';
import { authorize } from '../lib/fhir';

export function LoginRoute(): ReactElement {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authorize().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
    });
  }, []);

  if (error !== null) {
    return (
      <div role="alert">
        <h1>Could not start sign in</h1>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div role="status">
      <p>Redirecting to sign in…</p>
    </div>
  );
}
