import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fhirclient is loaded dynamically inside getClient() so we can stub
// import.meta.env per test before the module evaluates.
const VARS = [
  'VITE_OIDC_ISSUER',
  'VITE_OIDC_CLIENT_ID',
  'VITE_OIDC_REDIRECT_URI',
  'VITE_OIDC_SCOPE',
] as const;

function setEnv(values: Partial<Record<(typeof VARS)[number], string | undefined>>): void {
  for (const key of VARS) {
    const value = values[key];
    if (value === undefined) {
      vi.stubEnv(key, '');
    } else {
      vi.stubEnv(key, value);
    }
  }
}

const VALID_ENV = {
  VITE_OIDC_ISSUER: 'https://emr.example.com/oauth2/default',
  VITE_OIDC_CLIENT_ID: 'test-client-id',
  VITE_OIDC_REDIRECT_URI: 'https://emr.example.com/dashboard/auth/callback',
  VITE_OIDC_SCOPE: 'openid fhirUser launch/patient offline_access',
};

describe('getOidcConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws a descriptive error when VITE_OIDC_ISSUER is missing', async () => {
    setEnv({ ...VALID_ENV, VITE_OIDC_ISSUER: undefined });
    const { getOidcConfig } = await import('./fhir');
    expect(() => getOidcConfig()).toThrow(/VITE_OIDC_ISSUER/);
  });

  it('throws a descriptive error when VITE_OIDC_CLIENT_ID is missing', async () => {
    setEnv({ ...VALID_ENV, VITE_OIDC_CLIENT_ID: undefined });
    const { getOidcConfig } = await import('./fhir');
    expect(() => getOidcConfig()).toThrow(/VITE_OIDC_CLIENT_ID/);
  });

  it('throws a descriptive error when VITE_OIDC_REDIRECT_URI is missing', async () => {
    setEnv({ ...VALID_ENV, VITE_OIDC_REDIRECT_URI: undefined });
    const { getOidcConfig } = await import('./fhir');
    expect(() => getOidcConfig()).toThrow(/VITE_OIDC_REDIRECT_URI/);
  });

  it('throws a descriptive error when VITE_OIDC_SCOPE is missing', async () => {
    setEnv({ ...VALID_ENV, VITE_OIDC_SCOPE: undefined });
    const { getOidcConfig } = await import('./fhir');
    expect(() => getOidcConfig()).toThrow(/VITE_OIDC_SCOPE/);
  });

  it('returns the parsed config when every var is set', async () => {
    setEnv(VALID_ENV);
    const { getOidcConfig } = await import('./fhir');
    expect(getOidcConfig()).toStrictEqual({
      iss: VALID_ENV.VITE_OIDC_ISSUER,
      clientId: VALID_ENV.VITE_OIDC_CLIENT_ID,
      redirectUri: VALID_ENV.VITE_OIDC_REDIRECT_URI,
      scope: VALID_ENV.VITE_OIDC_SCOPE,
    });
  });

  it('error names every missing var when several are unset', async () => {
    setEnv({
      ...VALID_ENV,
      VITE_OIDC_ISSUER: undefined,
      VITE_OIDC_CLIENT_ID: undefined,
    });
    const { getOidcConfig } = await import('./fhir');
    let message = '';
    try {
      getOidcConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/VITE_OIDC_ISSUER/);
    expect(message).toMatch(/VITE_OIDC_CLIENT_ID/);
  });
});
