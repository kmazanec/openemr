import { createContext, useContext } from 'react';
import type { Client } from './fhir';

export class NotAuthenticatedError extends Error {
  override readonly name = 'NotAuthenticatedError';

  constructor(message = 'No FHIR session') {
    super(message);
  }
}

export class AuthExpiredError extends Error {
  override readonly name = 'AuthExpiredError';

  constructor(message = 'FHIR session expired') {
    super(message);
  }
}

export const FhirSessionContext = createContext<Client | null | undefined>(undefined);

export function useFhir(): Client {
  const value = useContext(FhirSessionContext);
  if (value === undefined || value === null) {
    throw new NotAuthenticatedError();
  }
  return value;
}
