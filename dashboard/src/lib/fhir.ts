import FHIR from 'fhirclient/lib/entry/browser';
import type Client from 'fhirclient/lib/Client';
import type { fhirclient } from 'fhirclient/lib/types';

export interface OidcConfig {
  iss: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

const REQUIRED_VARS = [
  'VITE_OIDC_ISSUER',
  'VITE_OIDC_CLIENT_ID',
  'VITE_OIDC_REDIRECT_URI',
  'VITE_OIDC_SCOPE',
] as const;

export function getOidcConfig(): OidcConfig {
  const env = import.meta.env as Record<string, string | undefined>;

  const missing = REQUIRED_VARS.filter((key) => {
    const value = env[key];
    return value === undefined || value === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required dashboard OIDC env var(s): ${missing.join(', ')}. ` +
        `See dashboard/.env.example.`,
    );
  }

  return {
    iss: env.VITE_OIDC_ISSUER as string,
    clientId: env.VITE_OIDC_CLIENT_ID as string,
    redirectUri: env.VITE_OIDC_REDIRECT_URI as string,
    scope: env.VITE_OIDC_SCOPE as string,
  };
}

export function buildAuthorizeParams(config: OidcConfig): fhirclient.AuthorizeParams {
  return {
    iss: config.iss,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scope: config.scope,
    pkceMode: 'required',
  };
}

export async function authorize(): Promise<void> {
  await FHIR.oauth2.authorize(buildAuthorizeParams(getOidcConfig()));
}

export async function completeAuthorization(): Promise<Client> {
  return FHIR.oauth2.ready();
}

export { FHIR };
export type { Client };
