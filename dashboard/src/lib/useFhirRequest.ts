import { useCallback, useEffect, useState } from 'react';
import { AuthExpiredError, useFhir } from './auth';

export interface FhirRequestResult<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  retry: () => void;
}

export function useFhirRequest<T>(url: string): FhirRequestResult<T> {
  const client = useFhir();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [version, setVersion] = useState<number>(0);

  const retry = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .request<T>(url)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toFhirError(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, url, version]);

  return { data, error, loading, retry };
}

function toFhirError(err: unknown): Error {
  if (isHttpStatus(err, 401)) {
    return new AuthExpiredError();
  }
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === 'string' ? err : 'FHIR request failed');
}

function isHttpStatus(err: unknown, status: number): boolean {
  if (err === null || typeof err !== 'object') return false;
  const candidate = err as { status?: unknown };
  return candidate.status === status;
}
