import { expect, test } from '@playwright/test';

// E2E for the parent-menu / sub-nav routing shim.
//
// In the v2 shell main_v2.php still loads the legacy
// `tabs_view_model.js` (because other parts of the page consume its
// `app_view_model`), so `window.navigateTab` and
// `window.activateTabByName` are defined by the legacy code first.
// Our SPA's `installShims()` overwrites both at boot so a click on
// any parent-menu leaf — which Knockout dispatches via
// `menuActionClick` → `navigateTab(...)` — lands on our SPA tab
// strip rather than the orphan Knockout `tabsList`.
//
// We can't drive the real OpenEMR menu from here (no PHP), so the
// test simulates the dispatch by calling `window.navigateTab`
// directly with the same args `menuActionClick` would — that's the
// integration boundary we own.

test.describe('menu shim', () => {
  test('window.navigateTab opens a tab in the SPA strip with the menu-derived label', async ({
    page,
  }) => {
    await page.goto('/');

    // Wait for the SPA's shim install (the tabs store global is the
    // signal we use across the e2e suite — App.tsx exposes it once
    // shims are installed).
    await page.waitForFunction(() => {
      const w = window as unknown as { __OE_DASHBOARD_TABS__?: unknown };
      return w.__OE_DASHBOARD_TABS__ !== undefined;
    });

    // The legacy `menuActionClick` ends with:
    //   navigateTab(webroot_url + dataurl, data.target, function () {
    //     activateTabByName(data.target, true);
    //   }, xl("Loading") + " " + dataLabel);
    // We call that contract directly here.
    await page.evaluate(() => {
      const w = window as unknown as {
        navigateTab?: (
          url: string,
          name: string,
          afterLoadFunction?: () => void,
          loadingLabel?: string,
        ) => void;
        activateTabByName?: (name: string) => void;
      };
      w.navigateTab?.(
        '/interface/main/calendar/index.php',
        'cal',
        () => w.activateTabByName?.('cal'),
        'Loading Calendar',
      );
    });

    const state = await page.evaluate(() => {
      const w = window as unknown as {
        __OE_DASHBOARD_TABS__: {
          getState: () => {
            tabs: ReadonlyArray<{ id: string; label?: string; url?: string }>;
            activeId: string | null;
          };
        };
      };
      return w.__OE_DASHBOARD_TABS__.getState();
    });

    expect(state.activeId).toBe('cal');
    // The store may also carry seed tabs from main_v2.php (Calendar /
    // Message Inbox / etc.) in production. The dev-server harness
    // doesn't seed them, but the auto-restore-from-launch-pid path
    // can still open the dashboard tab from a prior test run's
    // sessionStorage. Filter to the tab id we just navigated to.
    const cal = state.tabs.find((t) => t.id === 'cal');
    expect(cal).toBeDefined();
    expect(cal?.label).toBe('Calendar');
    expect(cal?.url).toBe('/interface/main/calendar/index.php');
  });

  test('two consecutive menu clicks surface in the strip and activate the second', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as { __OE_DASHBOARD_TABS__?: unknown };
      return w.__OE_DASHBOARD_TABS__ !== undefined;
    });

    await page.evaluate(() => {
      const w = window as unknown as {
        navigateTab: (
          url: string,
          name: string,
          afterLoadFunction?: () => void,
          loadingLabel?: string,
        ) => void;
        activateTabByName: (name: string) => void;
      };
      w.navigateTab(
        '/interface/main/calendar/index.php',
        'cal',
        () => w.activateTabByName('cal'),
        'Loading Calendar',
      );
      w.navigateTab(
        '/interface/main/messages/messages.php',
        'msg',
        () => w.activateTabByName('msg'),
        'Loading Messages',
      );
    });

    const state = await page.evaluate(() => {
      const w = window as unknown as {
        __OE_DASHBOARD_TABS__: {
          getState: () => {
            tabs: ReadonlyArray<{ id: string; label?: string }>;
            activeId: string | null;
          };
        };
      };
      return w.__OE_DASHBOARD_TABS__.getState();
    });
    // Filter out any seeded/auto-restored tabs the harness may have
    // before our two clicks. We assert the order of the menu-driven
    // tabs and the active id, not the absolute strip composition.
    const ids = state.tabs.map((t) => t.id).filter((id) => id === 'cal' || id === 'msg');
    expect(ids).toEqual(['cal', 'msg']);
    const cal = state.tabs.find((t) => t.id === 'cal');
    const msg = state.tabs.find((t) => t.id === 'msg');
    expect(cal?.label).toBe('Calendar');
    expect(msg?.label).toBe('Messages');
    expect(state.activeId).toBe('msg');
  });

  test('re-clicking the same menu item navigates the existing tab in place (no duplicate)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as { __OE_DASHBOARD_TABS__?: unknown };
      return w.__OE_DASHBOARD_TABS__ !== undefined;
    });

    await page.evaluate(() => {
      const w = window as unknown as {
        navigateTab: (
          url: string,
          name: string,
          afterLoadFunction?: () => void,
          loadingLabel?: string,
        ) => void;
      };
      w.navigateTab('/cal?date=2026-05-09', 'cal', undefined, 'Loading Calendar');
      w.navigateTab('/cal?date=2026-05-10', 'cal', undefined, 'Loading Calendar');
    });

    const state = await page.evaluate(() => {
      const w = window as unknown as {
        __OE_DASHBOARD_TABS__: {
          getState: () => {
            tabs: ReadonlyArray<{ id: string; url?: string }>;
          };
        };
      };
      return w.__OE_DASHBOARD_TABS__.getState();
    });
    // Two clicks of the same name should reuse the existing tab —
    // exactly one "cal" entry in the strip regardless of any other
    // auto-opened tabs.
    const cals = state.tabs.filter((t) => t.id === 'cal');
    expect(cals).toHaveLength(1);
    expect(cals[0]?.url).toBe('/cal?date=2026-05-10');
  });
});
