import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callEditor, messageForEditorError } from './dashboardEditor';

const ENDPOINT = '/test-editor.php';

beforeEach(() => {
  // Most tests stub the CSRF token via the explicit override; the
  // window-level read is verified by a dedicated case below.
  (window as unknown as { csrf_token_js?: unknown }).csrf_token_js = 'csrf-abc';
});

afterEach(() => {
  delete (window as unknown as { csrf_token_js?: unknown }).csrf_token_js;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('callEditor', () => {
  it('POSTs to the endpoint with action + csrf in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { uuid: 'a1' } }));
    const result = await callEditor(
      'save_allergy',
      { puuid: 'p1', title: 'Penicillin' },
      { endpointUrl: ENDPOINT, fetchFn: fetchMock as unknown as typeof fetch },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe(ENDPOINT);
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({
      action: 'save_allergy',
      csrf_token: 'csrf-abc',
      puuid: 'p1',
      title: 'Penicillin',
    });
    expect(result).toEqual({ ok: true, data: { ok: true, data: { uuid: 'a1' } } });
  });

  it('returns ok=false with the typed error code on a 4xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: 'validation_failed', messages: { title: ['required'] } }, 400),
    );
    const result = await callEditor(
      'save_problem',
      { puuid: 'p1', title: '' },
      { endpointUrl: ENDPOINT, fetchFn: fetchMock as unknown as typeof fetch },
    );
    expect(result).toEqual({
      ok: false,
      code: 'validation_failed',
      messages: { title: ['required'] },
    });
  });

  it('falls back to network_error on a transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    const result = await callEditor(
      'save_allergy',
      { puuid: 'p1', title: 'x' },
      { endpointUrl: ENDPOINT, fetchFn: fetchMock as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: false, code: 'network_error' });
  });

  it('returns malformed_response when the body is not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>nope</html>', { status: 200 }));
    const result = await callEditor(
      'save_allergy',
      { puuid: 'p1' },
      { endpointUrl: ENDPOINT, fetchFn: fetchMock as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: false, code: 'malformed_response' });
  });

  it('refuses to call when window.csrf_token_js is missing and no override is given', async () => {
    delete (window as unknown as { csrf_token_js?: unknown }).csrf_token_js;
    const fetchMock = vi.fn();
    const result = await callEditor(
      'save_allergy',
      { puuid: 'p1' },
      { endpointUrl: ENDPOINT, fetchFn: fetchMock as unknown as typeof fetch },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, code: 'no_csrf' });
  });
});

describe('messageForEditorError', () => {
  it('returns empty string on a successful result', () => {
    expect(messageForEditorError({ ok: true, data: {} })).toBe('');
  });

  it('returns a friendly message for known codes', () => {
    expect(messageForEditorError({ ok: false, code: 'validation_failed' })).toMatch(
      /correct the highlighted/i,
    );
    expect(messageForEditorError({ ok: false, code: 'csrf_failed' })).toMatch(
      /session expired/i,
    );
    expect(messageForEditorError({ ok: false, code: 'network_error' })).toMatch(
      /Could not reach the server/i,
    );
  });

  it('falls back to the generic message for unknown codes', () => {
    expect(messageForEditorError({ ok: false, code: 'totally_unknown_code' })).toMatch(
      /Something went wrong/i,
    );
  });
});
