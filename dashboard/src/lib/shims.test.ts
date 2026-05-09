import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  buildLeftNavShims,
  buildRTopShims,
  buildTopShims,
  commitSessionPid,
  installLeftNavShims,
  installTopShims,
  type ShimRouter,
} from './shims';

interface MockRouter extends ShimRouter {
  navigateToPatient: Mock<(pid: string) => void>;
  navigateToDashboardRoot: Mock<() => void>;
  openLegacyTab: Mock<(name: string, url: string) => void>;
  setEncounter: Mock<(eid: string, date?: string, frname?: string) => void>;
  clearEncounter: Mock<() => void>;
}

function mockRouter(): MockRouter {
  return {
    navigateToPatient: vi.fn(),
    navigateToDashboardRoot: vi.fn(),
    openLegacyTab: vi.fn(),
    setEncounter: vi.fn(),
    clearEncounter: vi.fn(),
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

describe('installTopShims — restoreSession handling', () => {
  // restoreSession is intentionally NOT a shim we install. The real
  // implementation comes from main_v2.php's inlined
  // library/restoreSession.php and is the parallel-login support
  // backbone. We must not overwrite it. Tests pin both branches:
  //  - if a real one is already present, leave it alone
  //  - if not (standalone test host), install a no-op fallback
  it('preserves an existing restoreSession when main_v2.php inlined one', () => {
    const win = fakeWindow();
    const realRestoreSession = vi.fn(() => true);
    (win as unknown as { top: Record<string, unknown> }).top['restoreSession'] =
      realRestoreSession;

    installTopShims({ router: mockRouter(), win });

    const top = (win as unknown as { top: Record<string, unknown> }).top;
    expect(top['restoreSession']).toBe(realRestoreSession);
  });

  it('installs a no-op fallback when no restoreSession is present', () => {
    const win = fakeWindow();
    // Standalone host: no main_v2.php-inlined function. The fallback
    // returns true synchronously so legacy callers that
    // fire-and-forget `top.restoreSession()` don't crash.
    installTopShims({ router: mockRouter(), win });

    const top = (win as unknown as { top: Record<string, unknown> }).top;
    expect(typeof top['restoreSession']).toBe('function');
    expect((top['restoreSession'] as () => unknown)()).toBe(true);
  });
});

describe('installTopShims', () => {
  it('exposes set_pid and clearPatient on the target window', () => {
    const win = fakeWindow();
    const shims = installTopShims({ router: mockRouter(), win });

    const top = (win as unknown as { top: Record<string, unknown> }).top;
    expect(top['set_pid']).toBe(shims.set_pid);
    expect(top['clearPatient']).toBe(shims.clearPatient);
  });
});

describe('buildLeftNavShims — setPatient', () => {
  it('navigates to the patient route (number pid)', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.setPatient('Doe, Jane', 42, 'PUB-42', 'frJane', '1980-01-01');

    expect(router.navigateToPatient).toHaveBeenCalledWith('42');
  });

  it('navigates to the patient route (string pid)', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.setPatient('Doe, Jane', '42');

    expect(router.navigateToPatient).toHaveBeenCalledWith('42');
  });
});

describe('buildLeftNavShims — encounter handling', () => {
  it('setEncounter forwards eid + date + frname to the router', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.setEncounter('2026-05-07', 99, 'frEnc');

    expect(router.setEncounter).toHaveBeenCalledWith('99', '2026-05-07', 'frEnc');
  });

  it('setPatientEncounter forwards only the first entry of the parallel arrays', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.setPatientEncounter([100, 101], ['2026-05-07', '2026-05-06'], ['follow-up', 'phone']);

    expect(router.setEncounter).toHaveBeenCalledOnce();
    expect(router.setEncounter).toHaveBeenCalledWith('100', '2026-05-07');
  });

  it('setPatientEncounter is a no-op for empty arrays', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.setPatientEncounter([], [], []);

    expect(router.setEncounter).not.toHaveBeenCalled();
  });

  it('clearEncounter forwards to the router', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.clearEncounter();

    expect(router.clearEncounter).toHaveBeenCalledOnce();
  });
});

describe('buildLeftNavShims — loadFrame', () => {
  it('opens a legacy tab for the given name + url', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.loadFrame('framecal', 'cal', '/interface/main/calendar/index.php');

    expect(router.openLegacyTab).toHaveBeenCalledWith('cal', '/interface/main/calendar/index.php');
  });

  it('loadFrame2 has the same semantics as loadFrame', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    shims.loadFrame2('framecal', 'cal', '/x.php');

    expect(router.openLegacyTab).toHaveBeenCalledWith('cal', '/x.php');
  });
});

describe('buildLeftNavShims — no-ops', () => {
  it('removeOptionSelected does not throw and does not call the router', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    expect(() => {
      shims.removeOptionSelected(99);
    }).not.toThrow();
    expect(router.openLegacyTab).not.toHaveBeenCalled();
  });

  it('syncRadios does not throw and does not call the router', () => {
    const router = mockRouter();
    const shims = buildLeftNavShims({ router, win: fakeWindow() });

    expect(() => {
      shims.syncRadios();
    }).not.toThrow();
  });
});

describe('buildRTopShims', () => {
  it('setLocation opens the "pat" legacy tab when the URL carries no set_pid', () => {
    const router = mockRouter();
    const shims = buildRTopShims({ router, win: fakeWindow() });

    shims.setLocation('/interface/foo.php');

    expect(router.openLegacyTab).toHaveBeenCalledWith('pat', '/interface/foo.php');
  });

  it('location setter routes set_pid URLs to navigateToPatient', () => {
    // This is the legacy patient-finder contract:
    //   top.RTop.location = "../../patient_file/summary/demographics.php?set_pid=42"
    // The setter must fire and route the SPA to /patient/42 (and
    // open the Patient Dashboard tab via the bootShims layer).
    const router = mockRouter();
    const shims = buildRTopShims({ router, win: fakeWindow() });

    shims.location = '../../patient_file/summary/demographics.php?set_pid=42';

    expect(router.navigateToPatient).toHaveBeenCalledWith('42');
    expect(router.openLegacyTab).not.toHaveBeenCalled();
  });

  it('setLocation routes set_pid URLs the same way as the location setter', () => {
    const router = mockRouter();
    const shims = buildRTopShims({ router, win: fakeWindow() });

    shims.setLocation('demographics.php?set_pid=7');

    expect(router.navigateToPatient).toHaveBeenCalledWith('7');
    expect(router.openLegacyTab).not.toHaveBeenCalled();
  });

  it('location setter without set_pid falls back to opening a "pat" tab', () => {
    const router = mockRouter();
    const shims = buildRTopShims({ router, win: fakeWindow() });

    shims.location = '/interface/something/else.php?foo=bar';

    expect(router.navigateToPatient).not.toHaveBeenCalled();
    expect(router.openLegacyTab).toHaveBeenCalledWith(
      'pat',
      '/interface/something/else.php?foo=bar',
    );
  });

  it('reading location returns the last-assigned URL', () => {
    const router = mockRouter();
    const shims = buildRTopShims({ router, win: fakeWindow() });

    shims.location = '/foo.php?set_pid=1';
    expect(shims.location).toBe('/foo.php?set_pid=1');
  });
});

describe('installLeftNavShims', () => {
  it('exposes left_nav and RTop on the target window', () => {
    const win = fakeWindow();
    const { leftNav, RTop } = installLeftNavShims({ router: mockRouter(), win });

    const top = (win as unknown as { top: Record<string, unknown> }).top;
    expect(top['left_nav']).toBe(leftNav);
    expect(top['RTop']).toBe(RTop);
  });
});

describe('commitSessionPid', () => {
  // C4: PolicyGate's PatientMismatch fired on every cross-patient briefing
  // because $_SESSION['pid'] lagged behind the SPA's in-memory state. The
  // commit helper hits library/ajax/set_pt.php with the standard
  // (set_pid + csrf_token_form) GET contract used by dynamic_finder.php.
  it('GETs set_pt.php with set_pid + csrf_token_form when both globals are present', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true } as Response));
    const win = fakeWindow({
      csrf_token_js: 'csrf-abc',
      webroot_url: '/openemr',
    });

    await commitSessionPid('42', win, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/openemr/library/ajax/set_pt.php?set_pid=42&csrf_token_form=csrf-abc');
    expect((opts as RequestInit).method).toBe('GET');
    expect((opts as RequestInit).credentials).toBe('same-origin');
  });

  it('skips the fetch when csrf_token_js is missing', async () => {
    const fetchImpl = vi.fn();
    const win = fakeWindow({ webroot_url: '/openemr' });

    await commitSessionPid('42', win, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips the fetch when fetchImpl is undefined (test/SSR safety)', async () => {
    const win = fakeWindow({ csrf_token_js: 'x', webroot_url: '/' });
    await expect(commitSessionPid('42', win, undefined)).resolves.toBeUndefined();
  });

  it('swallows fetch rejections (server-side fallback handles re-sync)', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('network')));
    const win = fakeWindow({ csrf_token_js: 'csrf', webroot_url: '' });

    await expect(
      commitSessionPid('1', win, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('buildTopShims — set_pid commits server-side session', () => {
  it('fires the commit GET before navigating', () => {
    const router = mockRouter();
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true } as Response));
    const win = fakeWindow({ csrf_token_js: 'tok', webroot_url: '/oe' });
    const shims = buildTopShims({
      router,
      win,
      fetchImpl,
    });

    shims.set_pid(7);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      '/oe/library/ajax/set_pt.php?set_pid=7&csrf_token_form=tok',
    );
    expect(router.navigateToPatient).toHaveBeenCalledWith('7');
  });
});

describe('buildLeftNavShims — setPatient commits server-side session', () => {
  it('fires the commit GET before navigating', () => {
    const router = mockRouter();
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true } as Response));
    const win = fakeWindow({ csrf_token_js: 'tok', webroot_url: '/oe' });
    const shims = buildLeftNavShims({
      router,
      win,
      fetchImpl,
    });

    shims.setPatient('Doe, Jane', '42');

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(router.navigateToPatient).toHaveBeenCalledWith('42');
  });
});

describe('buildRTopShims — set_pid URL commits server-side session', () => {
  it('fires the commit GET when location= URL carries set_pid', () => {
    const router = mockRouter();
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true } as Response));
    const win = fakeWindow({ csrf_token_js: 'tok', webroot_url: '/oe' });
    const shims = buildRTopShims({
      router,
      win,
      fetchImpl,
    });

    shims.location = '../../patient_file/summary/demographics.php?set_pid=104';

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      '/oe/library/ajax/set_pt.php?set_pid=104&csrf_token_form=tok',
    );
    expect(router.navigateToPatient).toHaveBeenCalledWith('104');
  });

  it('does NOT commit when location= URL has no set_pid', () => {
    const router = mockRouter();
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true } as Response));
    const win = fakeWindow({ csrf_token_js: 'tok', webroot_url: '/oe' });
    const shims = buildRTopShims({
      router,
      win,
      fetchImpl,
    });

    shims.location = '/interface/something/else.php';

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(router.openLegacyTab).toHaveBeenCalled();
  });
});
