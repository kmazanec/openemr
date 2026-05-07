import { expect, test } from '@playwright/test';

// T3.5 — Patient context flow end-to-end.
//
// Simulates a legacy iframe calling top.left_nav.setPatient(...) once
// the SPA is mounted. The shim, installed at boot, should route the
// router to /patient/$pid. We don't drive the real OpenEMR patient
// finder here — that flow requires the dev compose stack and a live
// session. Instead, this test pins what the legacy contract is going
// to invoke: the call shape the patient finder uses today.
//
// The manual-smoke acceptance (search → click → land) lives in the
// MR description; this test is the automated complement.
test('left_nav.setPatient navigates the SPA to /patient/$pid', async ({ page }) => {
  await page.goto('/');

  // The shim is installed in App's useEffect; wait for it.
  await page.waitForFunction(() => {
    const w = window as unknown as { left_nav?: { setPatient?: unknown } };
    return typeof w.left_nav?.setPatient === 'function';
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

  await page.waitForURL(/\/patient\/42$/);
  expect(page.url()).toMatch(/\/patient\/42$/);
});
