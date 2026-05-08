// Verifies that after the SMART round-trip lands successfully, the
// session is reused for subsequent patient picks (no second redirect
// to the OAuth provider login).
//
// 1. login to OpenEMR with ?v2=1
// 2. simulate a patient pick → SPA fires authorize() → drives the
//    OAuth provider login automatically (admin/pass)
// 3. callback completes, SPA lands back on main_v2.php
// 4. simulate a *second* patient pick — this should NOT redirect; it
//    should just render the second patient's cards immediately

import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

const consoleLog = [];
page.on('console', (msg) => {
  consoleLog.push(`[${msg.type()}] ${msg.text()}`);
});

// Helper: wait for a stable URL (no navigation for `quietMs`).
async function waitForStableUrl(quietMs = 1500, timeoutMs = 25000) {
  const start = Date.now();
  let lastUrl = page.url();
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(200);
    const u = page.url();
    if (u !== lastUrl) {
      lastUrl = u;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= quietMs) return u;
  }
  return lastUrl;
}

console.log('--- step 1: login via ?v2=1');
await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, { waitUntil: 'networkidle' });
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
await page.click('#login-button, button[type="submit"], input[type="submit"]');
await waitForStableUrl();
console.log('post-login URL:', page.url());

console.log('--- step 2: pick patient 1 (this should trigger authorize)');
await page.evaluate(() => {
  window.RTop.location = '../../patient_file/summary/demographics.php?set_pid=1';
});
await page.waitForTimeout(2000);
console.log('after pick 1 URL:', page.url());

// If we landed on the OAuth provider login screen, log in.
if (page.url().includes('/provider/login')) {
  console.log('--- step 2a: OAuth provider login screen — logging in');
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', PASS);
  // The submit button is `<button name="user_role" value="api">`.
  await page.click('button[name="user_role"][value="api"]');
  await waitForStableUrl(2500);
  console.log('after provider login URL:', page.url());

  // OpenEMR may show a scope-authorization (consent) page next.
  // Look for a submit/authorize button on whatever loaded.
  const proceedBtn = await page.$(
    'button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue"), input[type="submit"]',
  );
  if (proceedBtn) {
    console.log('--- step 2b: clicking authorize/proceed');
    await proceedBtn.click();
    await waitForStableUrl(2500);
    console.log('after consent URL:', page.url());
  }
}

const afterFirstPick = await page.evaluate(() => ({
  href: location.href,
  smartKeys: Object.keys(sessionStorage).filter((k) => k.startsWith('SMART_KEY') || k.includes('smart')),
  patientHeader: document.querySelector('[data-testid="patient-header"], h1, h2')?.textContent,
  bodyTop: document.body.innerText.slice(0, 200),
}));
console.log('after first pick:', JSON.stringify(afterFirstPick, null, 2));

console.log('--- step 3: pick patient 2 (this should NOT redirect)');
const urlBefore = page.url();
await page.evaluate(() => {
  window.RTop.location = '../../patient_file/summary/demographics.php?set_pid=2';
});
await page.waitForTimeout(2500);
const urlAfter = page.url();
console.log('URL before:', urlBefore);
console.log('URL after:', urlAfter);
const reauthorized =
  urlAfter !== urlBefore &&
  (urlAfter.includes('/oauth2/') ||
    urlAfter.includes('/provider/login') ||
    urlAfter.includes('/dashboard/auth/callback'));
console.log('reauthorized?', reauthorized);

const afterSecondPick = await page.evaluate(() => ({
  href: location.href,
  patientHeader: document.querySelector('[data-testid="patient-header"], h1, h2')?.textContent,
  activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
}));
console.log('after second pick:', JSON.stringify(afterSecondPick, null, 2));

await page.screenshot({ path: 'debug-smart-reuse.png' });
console.log('screenshot at debug-smart-reuse.png');

console.log('--- selected console lines from the run:');
for (const line of consoleLog.filter((l) => l.includes('error') || l.includes('SMART') || l.includes('FHIR')).slice(0, 30)) {
  console.log('  ', line);
}

await browser.close();
