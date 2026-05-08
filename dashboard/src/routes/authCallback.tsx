import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from '@tanstack/react-router';
import { completeAuthorization } from '../lib/fhir';

type Status = 'pending' | 'error';

// SMART OIDC callback. Two boot scenarios:
//   1. The SPA is hosted at /dashboard/auth/callback (Apache rewrite,
//      T1.6). We're at the *real* /dashboard/auth/callback URL with
//      ?code=&state= in the search string. After ready() completes,
//      we redirect — via a real navigation — back to main_screen.php?v2=1
//      so the legacy session minting flow gets us a fresh token_main
//      and lands us on main_v2.php with the SMART session in
//      sessionStorage.
//   2. We're invoked from inside the memory router (tests, future
//      direct deep link). After ready() completes, navigate via the
//      memory router to /patient/$pid (or /dashboard if no patient).
export function AuthCallbackRoute(): ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    completeAuthorization()
      .then((client) => {
        if (cancelled) return;
        const isRealCallback =
          typeof window !== 'undefined' &&
          window.location.pathname.endsWith('/auth/callback');
        if (isRealCallback) {
          // Bounce through main_screen.php to get a fresh token_main
          // and end up on main_v2.php — the SMART session lives in
          // sessionStorage, which survives the redirect.
          const origin = window.location.origin;
          window.location.replace(`${origin}/interface/main/main_screen.php?v2=1`);
          return;
        }
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
