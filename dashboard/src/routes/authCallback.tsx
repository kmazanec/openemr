import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from '@tanstack/react-router';
import { completeAuthorization } from '../lib/fhir';

type Status = 'pending' | 'error';

// SMART OIDC callback. Two boot scenarios:
//   1. The SPA is hosted at /dashboard/auth/callback (Apache rewrite,
//      T1.6). We're at the *real* /dashboard/auth/callback URL with
//      ?code=&state= in the search string. After ready() completes,
//      we redirect — via a real navigation — to main_v2_resume.php,
//      which mints a fresh token_main and 302s back to main_v2.php
//      so the SPA shell re-mounts with the user's tabs intact. The
//      SMART session lives in window.sessionStorage and survives the
//      redirect chain.
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
          const origin = window.location.origin;
          window.location.replace(
            `${origin}/interface/main/tabs/main_v2_resume.php`,
          );
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
