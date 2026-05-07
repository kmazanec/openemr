// Repro for the patient-pick flow. Logs in via ?v2=1, opens the
// Patient Finder tab, simulates a row click by invoking the same JS
// the finder runs (top.RTop.location = "demographics.php?set_pid=N"),
// and dumps the resulting tab state.

import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';
const TARGET_PID = process.env.OEMR_PID ?? '1';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('console', (msg) => console.log(`[browser ${msg.type()}]`, msg.text()));
page.on('pageerror', (err) => console.log('[browser pageerror]', err.message));

console.log('navigating to login with v2=1');
await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, { waitUntil: 'networkidle' });
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.click('#login-button, button[type="submit"], input[type="submit"]'),
]);
await page.waitForTimeout(1500);
console.log('post-login URL:', page.url());

// Probe what RTop looks like in window.top.
const probeBefore = await page.evaluate(() => {
  const w = window;
  const r = w.RTop;
  return {
    rType: typeof r,
    rKeys: r ? Object.keys(r) : null,
    rDescriptors: r
      ? Object.getOwnPropertyDescriptors(r)
      : null,
    hasLocationSetter:
      r && Object.getOwnPropertyDescriptor(r, 'location')?.set !== undefined,
    hasSetLocation: typeof r?.setLocation === 'function',
  };
});
console.log('RTop probe:', JSON.stringify(probeBefore, null, 2));

// Now simulate the finder calling top.RTop.location = "demographics.php?set_pid=1"
const result = await page.evaluate((pid) => {
  const url = `../../patient_file/summary/demographics.php?set_pid=${encodeURIComponent(pid)}`;
  try {
    window.RTop.location = url;
    return { assigned: window.RTop.location, ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}, TARGET_PID);
console.log('after assign:', JSON.stringify(result, null, 2));

await page.waitForTimeout(800);

const tabs = await page.evaluate(() => {
  const w = window;
  return {
    state: w.__OE_DASHBOARD_TABS__?.getState(),
    activeTabText: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  };
});
console.log('tabs after assignment:', JSON.stringify(tabs, null, 2));

await page.screenshot({ path: 'debug-patient-pick.png' });
console.log('screenshot at debug-patient-pick.png');
await browser.close();
