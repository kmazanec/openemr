import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  buildLeftNavShims,
  buildRTopShims,
  buildTopShims,
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

describe('buildTopShims — restoreSession', () => {
  // restoreSession is a no-op in the SPA host. The legacy
  // /library/restoreSession.php is a PHP-rendered JS file (not an
  // HTTP endpoint), so any attempt to POST to it 500s. Legacy
  // iframe AJAX traffic keeps the PHP session alive on its own;
  // the SPA never has to ping anything.
  it('resolves without invoking fetch (no-op contract)', async () => {
    const fetchImpl = vi.fn();
    const shims = buildTopShims({
      router: mockRouter(),
      win: fakeWindow(),
      fetchImpl,
    });

    await expect(shims.restoreSession()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
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
