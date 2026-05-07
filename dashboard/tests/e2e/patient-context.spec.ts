import { expect, test } from '@playwright/test';

// T3.5 — Patient context flow end-to-end.
//
// Simulates a legacy iframe calling top.left_nav.setPatient(...) once
// the SPA is mounted. The shim, installed at boot, should activate
// the Patient Dashboard tab in the SPA's tabs store. We don't drive
// the real OpenEMR patient finder here — that flow requires the dev
// compose stack and a live session. The cards' FHIR session also
// fails in this standalone Vite environment (no /metadata server),
// which sends the router to /login. To keep this test focused on
// the shim → tabs-store contract (which is what T3.5 is about), we
// assert the store state directly via window.__OE_DASHBOARD_TABS__.
test('left_nav.setPatient activates the Patient Dashboard tab', async ({ page }) => {
  await page.goto('/');

  await page.waitForFunction(() => {
    const w = window as unknown as {
      left_nav?: { setPatient?: unknown };
      __OE_DASHBOARD_TABS__?: unknown;
    };
    return (
      typeof w.left_nav?.setPatient === 'function' && w.__OE_DASHBOARD_TABS__ !== undefined
    );
  });

  await page.evaluate(() => {
    const w = window as unknown as {
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
    w.left_nav.setPatient('Robert Kowalski', 42, '12345', 'main', '1971-06-08');
  });

  const activeId = await page.evaluate(() => {
    const w = window as unknown as {
      __OE_DASHBOARD_TABS__: { getState: () => { activeId: string | null } };
    };
    return w.__OE_DASHBOARD_TABS__.getState().activeId;
  });

  expect(activeId).toBe('__dashboard');
});
