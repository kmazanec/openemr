import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  VITE_OIDC_ISSUER: 'https://emr.example.com/apis/default/fhir',
  VITE_OIDC_CLIENT_ID: 'test-client-id',
  VITE_OIDC_REDIRECT_URI: 'https://emr.example.com/dashboard/auth/callback',
  VITE_OIDC_SCOPE: 'openid fhirUser launch/patient offline_access',
};

const ALL_UNSET: Record<(typeof VARS)[number], undefined> = {
  VITE_OIDC_ISSUER: undefined,
  VITE_OIDC_CLIENT_ID: undefined,
  VITE_OIDC_REDIRECT_URI: undefined,
  VITE_OIDC_SCOPE: undefined,
};

describe('getOidcConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('derives iss and redirectUri from window.location.origin when env vars are missing', async () => {
    // Vitest's jsdom environment pins location.origin to
    // http://localhost:3000 by default — assert that fallback.
    setEnv({
      ...ALL_UNSET,
      VITE_OIDC_CLIENT_ID: 'cached-client-id',
    });
    const { getOidcConfig } = await import('./fhir');
    const cfg = getOidcConfig();
    expect(cfg.iss).toBe(`${window.location.origin}/apis/default/fhir`);
    expect(cfg.redirectUri).toBe(`${window.location.origin}/dashboard/auth/callback`);
    expect(cfg.scope).toContain('patient/AllergyIntolerance.read');
  });

  it('reads clientId from localStorage when no env var is set', async () => {
    setEnv(ALL_UNSET);
    localStorage.setItem('oeDashboard.smartClientId', 'cached-id-from-storage');
    const { getOidcConfig } = await import('./fhir');
    expect(getOidcConfig().clientId).toBe('cached-id-from-storage');
  });

  it('throws when no clientId can be resolved from env or storage', async () => {
    setEnv(ALL_UNSET);
    const { getOidcConfig } = await import('./fhir');
    expect(() => getOidcConfig()).toThrow(/VITE_OIDC_CLIENT_ID/);
  });
});

describe('buildAuthorizeParams', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const baseConfig = {
    iss: 'http://localhost:8300/apis/default/fhir',
    clientId: 'test-client',
    redirectUri: 'http://localhost:8300/dashboard/auth/callback',
    scope: 'openid fhirUser launch launch/patient',
  };

  it('emits standalone-launch params when no SmartLaunch is supplied', async () => {
    const { buildAuthorizeParams } = await import('./fhir');
    expect(buildAuthorizeParams(baseConfig)).toMatchObject({
      iss: baseConfig.iss,
      clientId: baseConfig.clientId,
      redirectUri: baseConfig.redirectUri,
      scope: baseConfig.scope,
      pkceMode: 'required',
    });
    expect((buildAuthorizeParams(baseConfig) as { launch?: string }).launch).toBeUndefined();
  });

  it('emits EHR-launch params when SmartLaunch is supplied (iss = aud, launch token forwarded)', async () => {
    const { buildAuthorizeParams } = await import('./fhir');
    const smart = {
      launch: 'opaque-encrypted-launch-token',
      aud: 'http://localhost:8300/apis/default/fhir',
    };
    expect(buildAuthorizeParams(baseConfig, smart)).toMatchObject({
      iss: smart.aud,
      launch: smart.launch,
      clientId: baseConfig.clientId,
      redirectUri: baseConfig.redirectUri,
      scope: baseConfig.scope,
      pkceMode: 'required',
    });
  });
});

describe('ensureClientId', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns the env client_id when set, without hitting the network', async () => {
    setEnv({ ...ALL_UNSET, VITE_OIDC_CLIENT_ID: 'env-client-id' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ensureClientId } = await import('./fhir');
    await expect(ensureClientId()).resolves.toBe('env-client-id');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the localStorage cache when set, without hitting the network', async () => {
    setEnv(ALL_UNSET);
    localStorage.setItem('oeDashboard.smartClientId', 'cached-client-id');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ensureClientId } = await import('./fhir');
    await expect(ensureClientId()).resolves.toBe('cached-client-id');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('registers a new client and caches the returned client_id', async () => {
    setEnv(ALL_UNSET);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ client_id: 'fresh-client-id' }),
    } as unknown as Response);

    const { ensureClientId } = await import('./fhir');
    await expect(ensureClientId()).resolves.toBe('fresh-client-id');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/oauth2/default/registration`);
    expect(init.method).toBe('POST');
    expect(localStorage.getItem('oeDashboard.smartClientId')).toBe('fresh-client-id');
  });

  it('throws on registration failure', async () => {
    setEnv(ALL_UNSET);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const { ensureClientId } = await import('./fhir');
    await expect(ensureClientId()).rejects.toThrow(/Failed to register/);
  });
});
