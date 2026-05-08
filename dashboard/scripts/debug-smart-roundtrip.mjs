// Drives the full SMART OIDC round-trip:
//   1. login to OpenEMR with ?v2=1
//   2. simulate a patient pick via top.RTop.location = ".../set_pid=1"
//   3. RequireFhirSession should auto-launch authorize() (full-page redirect)
//   4. OpenEMR's OAuth2 server (already trusted by the open session) should
//      issue a code and redirect back to /dashboard/auth/callback
//   5. /auth/callback runs ready(), stores the SMART session, and redirects
//      to /interface/main/main_screen.php?v2=1
//   6. main_screen.php redirects to main_v2.php with a fresh token_main
//   7. SPA boots, AppShell renders, Patient Dashboard tab body shows the
//      cards (FHIR fetches now succeed)

import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';
const TARGET_PID = process.env.OEMR_PID ?? '1';

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
page.on('console', (msg) => console.log(`[browser ${msg.type()}]`, msg.text()));
page.on('pageerror', (err) => console.log('[browser pageerror]', err.message));

console.log('--- step 1: login via ?v2=1');
await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, { waitUntil: 'networkidle' });
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.click('#login-button, button[type="submit"], input[type="submit"]'),
]);
await page.waitForTimeout(1500);
console.log('post-login URL:', page.url());

console.log('--- step 2: simulate patient pick via RTop.location =');
await page.evaluate((pid) => {
  const url = `../../patient_file/summary/demographics.php?set_pid=${encodeURIComponent(pid)}`;
  window.RTop.location = url;
}, TARGET_PID);

console.log('--- step 3-6: wait for the redirect chain to settle');
// We expect: SPA mounts → RequireFhirSession sees no session → authorize()
// → OAuth authorize endpoint → consent (auto-pass for trusted public client)
// → /dashboard/auth/callback → main_screen.php?v2=1 → main_v2.php?token_main=
let landedAt = null;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500);
  const url = page.url();
  if (url.includes('main_v2.php?token_main=') && i > 4) {
    // Allow at least a couple of redirect ticks; the very first URL
    // tick is still on the original main_v2 before authorize() fires.
    const inSession = await page.evaluate(() => {
      const keys = Object.keys(sessionStorage);
      return keys.some((k) => k.startsWith('SMART_KEY') || k.startsWith('smart-'));
    });
    if (inSession) {
      landedAt = url;
      break;
    }
  }
}
console.log('landed at:', landedAt ?? page.url());
console.log('current URL:', page.url());

const summary = await page.evaluate(() => {
  return {
    href: location.href,
    activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.textContent),
    hasDashboardPane: !!document.querySelector('[data-testid="dashboard-pane"]'),
    sessionStorageKeys: Object.keys(sessionStorage),
    bodyText: document.body.innerText.slice(0, 200),
  };
});
console.log('summary:', JSON.stringify(summary, null, 2));

await page.screenshot({ path: 'debug-smart-roundtrip.png', fullPage: false });
console.log('screenshot at debug-smart-roundtrip.png');

await browser.close();
