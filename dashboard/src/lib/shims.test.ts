import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { buildTopShims, installTopShims, type ShimRouter } from './shims';

interface MockRouter extends ShimRouter {
  navigateToPatient: Mock<(pid: string) => void>;
  navigateToDashboardRoot: Mock<() => void>;
}

function mockRouter(): MockRouter {
  return {
    navigateToPatient: vi.fn(),
    navigateToDashboardRoot: vi.fn(),
  };
}

function fakeWindow(globals: Record<string, unknown> = {}): Window & typeof globalThis {
  // Minimal Window stand-in: enough surface for the shims we test.
  // Cast through `unknown` because the structural intersection with
  // `globalThis` can't be honoured with this small a fake.
  const win = { ...globals } as unknown as Window & typeof globalThis;
  // top defaults to win itself — same shape as a real top-level page.
  (win as unknown as { top: Window }).top = win;
  return win;
}

describe('buildTopShims — set_pid', () => {
  it('navigates the router to the given patient (number)', () => {
    const router = mockRouter();
    const shims = buildTopShims({ router, win: fakeWindow() });

    shims.set_pid(123);

    expect(router.navigateToPatient).toHaveBeenCalledWith('123');
  });

  it('navigates the router to the given patient (numeric string)', () => {
    const router = mockRouter();
    const shims = buildTopShims({ router, win: fakeWindow() });

    shims.set_pid('456');

    expect(router.navigateToPatient).toHaveBeenCalledWith('456');
  });
});

describe('buildTopShims — clearPatient', () => {
  it('navigates the router to the dashboard root', () => {
    const router = mockRouter();
    const shims = buildTopShims({ router, win: fakeWindow() });

    shims.clearPatient();

    expect(router.navigateToDashboardRoot).toHaveBeenCalledOnce();
    expect(router.navigateToPatient).not.toHaveBeenCalled();
  });
});

describe('buildTopShims — restoreSession', () => {
  it('POSTs to /library/restoreSession.php with same-origin credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const shims = buildTopShims({
      router: mockRouter(),
      win: fakeWindow({ webroot_url: '/openemr' }),
      fetchImpl,
    });

    await shims.restoreSession();

    expect(fetchImpl).toHaveBeenCalledWith('/openemr/library/restoreSession.php', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });

  it('uses an empty webroot when window.webroot_url is unset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const shims = buildTopShims({
      router: mockRouter(),
      win: fakeWindow(),
      fetchImpl,
    });

    await shims.restoreSession();

    expect(fetchImpl).toHaveBeenCalledWith('/library/restoreSession.php', expect.any(Object));
  });

  it('rejects when the server responds non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const shims = buildTopShims({
      router: mockRouter(),
      win: fakeWindow(),
      fetchImpl,
    });

    await expect(shims.restoreSession()).rejects.toThrow(/HTTP 500/);
  });
});

describe('installTopShims', () => {
  it('exposes the three top.* methods on the target window', () => {
    const win = fakeWindow();
    const shims = installTopShims({ router: mockRouter(), win });

    const top = (win as unknown as { top: Record<string, unknown> }).top;
    expect(top['restoreSession']).toBe(shims.restoreSession);
    expect(top['set_pid']).toBe(shims.set_pid);
    expect(top['clearPatient']).toBe(shims.clearPatient);
  });
});
