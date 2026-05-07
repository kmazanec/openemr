import { describe, expect, it, vi } from 'vitest';
import { installShims } from './bootShims';
import { createTabsStore } from './tabsStore';

interface FakeRouter {
  navigate: ReturnType<typeof vi.fn>;
}

function fakeRouter(): FakeRouter {
  return { navigate: vi.fn(() => Promise.resolve()) };
}

function fakeWindow(): Window & typeof globalThis {
  const win = { fetch: vi.fn() } as unknown as Window & typeof globalThis;
  (win as unknown as { top: Window }).top = win;
  return win;
}

describe('installShims (boot integration)', () => {
  // T3.5 — closing the loop on the patient context flow. Once shims
  // are installed at boot, a legacy iframe (e.g. the patient finder)
  // calling top.left_nav.setPatient(...) lands the SPA on
  // /patient/$pid. This test pins that contract end-to-end through
  // the install layer (not just the build layer).
  it('exposes left_nav.setPatient on top after install, and a call routes to /patient/$pid', () => {
    const router = fakeRouter();
    const tabsStore = createTabsStore();
    const win = fakeWindow();

    installShims({ router: router, tabsStore, win });

    const topLikeWin = win as unknown as {
      left_nav: {
        setPatient: (
          name: string,
          pid: string | number,
          pubpid?: string,
          frname?: string,
          dob?: string,
        ) => void;
      };
    };
    expect(typeof topLikeWin.left_nav.setPatient).toBe('function');

    topLikeWin.left_nav.setPatient('Robert Kowalski', 42, '12345', 'main', '1971-06-08');

    expect(router.navigate).toHaveBeenCalledWith({
      to: '/patient/$pid',
      params: { pid: '42' },
    });
  });

  it('exposes top.set_pid after install', () => {
    const router = fakeRouter();
    const tabsStore = createTabsStore();
    const win = fakeWindow();

    installShims({ router: router, tabsStore, win });

    const topLikeWin = win as unknown as {
      set_pid: (pid: string | number) => void;
    };
    expect(typeof topLikeWin.set_pid).toBe('function');
    topLikeWin.set_pid(7);
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/patient/$pid',
      params: { pid: '7' },
    });
  });

  it('exposes top.dlgopen after install', () => {
    const router = fakeRouter();
    const tabsStore = createTabsStore();
    const win = fakeWindow();

    installShims({ router: router, tabsStore, win });

    const topLikeWin = win as unknown as { dlgopen: unknown };
    expect(typeof topLikeWin.dlgopen).toBe('function');
  });

  it('loadFrame call after install both registers the tab and navigates the router', () => {
    const router = fakeRouter();
    const tabsStore = createTabsStore();
    const win = fakeWindow();

    installShims({ router: router, tabsStore, win });

    const topLikeWin = win as unknown as {
      left_nav: { loadFrame: (id: string, name: string, url: string) => void };
    };
    topLikeWin.left_nav.loadFrame('framecal', 'cal', '/interface/main/calendar/index.php');

    const tabs = tabsStore.getState().tabs;
    expect(tabs.map((t) => t.id)).toContain('cal');
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/dashboard/legacy/$name',
      params: { name: 'cal' },
      search: { url: '/interface/main/calendar/index.php' },
    });
  });
});
