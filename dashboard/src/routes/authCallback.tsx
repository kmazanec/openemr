import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from '@tanstack/react-router';
import { completeAuthorization } from '../lib/fhir';

type Status = 'pending' | 'error';

export function AuthCallbackRoute(): ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    completeAuthorization()
      .then((client) => {
        if (cancelled) return;
        const pid = client.patient?.id ?? null;
        const target = pid !== null ? `/patient/${pid}` : '/dashboard';
        void router.navigate({ to: target });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setErrorMessage(message);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (status === 'error') {
    return (
      <div role="alert">
        <h1>Could not finish sign in</h1>
        <p>{errorMessage}</p>
      </div>
    );
  }

  return (
    <div role="status">
      <p>Finishing sign in…</p>
    </div>
  );
}
