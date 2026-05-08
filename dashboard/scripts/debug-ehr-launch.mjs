// Verify the SMART EHR launch round-trip.
//   1. login to OpenEMR with ?v2=1
//   2. simulate a patient pick via top.RTop.location = ".../set_pid=1"
//   3. SPA fires authorize() with the OE_SMART_LAUNCH token →
//      OAuth server skips the login screen → callback → cards render
//   4. simulate a second pick → no auth dance, just renders

import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';
const PID1 = process.env.OEMR_PID1 ?? '1';
const PID2 = process.env.OEMR_PID2 ?? '2';

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const browserLog = [];
page.on('console', (msg) => {
  browserLog.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => browserLog.push(`[pageerror] ${err.message}`));

const fhirNet = [];
const launchNet = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/fhir/') && !url.includes('.well-known')) {
    fhirNet.push({ phase: 'req', method: req.method(), url, headers: req.headers() });
  }
  if (url.includes('main_v2_launch.php')) {
    launchNet.push({ phase: 'req', url });
  }
});
page.on('response', async (r) => {
  const url = r.url();
  if (url.includes('/fhir/') && !url.includes('.well-known')) {
    let body = '';
    try { body = (await r.text()).slice(0, 200); } catch {}
    fhirNet.push({ phase: 'res', status: r.status(), url, body });
  }
  if (url.includes('main_v2_launch.php')) {
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch {}
    launchNet.push({ phase: 'res', status: r.status(), url, body });
  }
});

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

const initial = await page.evaluate(() => ({
  href: location.href,
  smartLaunch: window.OE_SMART_LAUNCH,
  defaultTabs: window.OE_DEFAULT_TABS,
}));
console.log('initial state:', JSON.stringify(initial, null, 2));

console.log('--- step 2: pick patient', PID1, '(should authorize without a second login)');
await page.evaluate((pid) => {
  window.RTop.location = `../../patient_file/summary/demographics.php?set_pid=${encodeURIComponent(pid)}`;
}, PID1);

// Wait for the redirect chain to settle.
const landed1 = await waitForStableUrl(2000, 20000);
console.log('landed at:', landed1);

const sawProviderLogin = browserLog.some((l) => l.toLowerCase().includes('sign in')) ||
  landed1.includes('/provider/login');
console.log('saw provider login screen?', sawProviderLogin);

const tabState1 = await page.evaluate(() => {
  return {
    href: location.href,
    smartKeys: Object.keys(sessionStorage).filter(
      (k) => k.startsWith('SMART_KEY') || k.startsWith('smart-')
    ),
    activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.textContent),
    bodyText: document.body.innerText.slice(0, 300),
  };
});
console.log('after first pick:', JSON.stringify(tabState1, null, 2));

console.log('--- step 3: pick patient', PID2, '(should NOT redirect at all)');
const urlBefore = page.url();
await page.evaluate((pid) => {
  // After the first pick we should be back on main_v2.php with the
  // shims re-installed. RTop should be defined; if not, fall back
  // to top.set_pid (which the boot shim layer also wires up).
  const w = window;
  if (w.RTop && typeof Object.getOwnPropertyDescriptor(w.RTop, 'location')?.set === 'function') {
    w.RTop.location = `../../patient_file/summary/demographics.php?set_pid=${encodeURIComponent(pid)}`;
  } else if (typeof w.set_pid === 'function') {
    w.set_pid(pid);
  } else {
    throw new Error('Neither RTop.location nor set_pid is available on window after auth');
  }
}, PID2);
await page.waitForTimeout(1500);
const urlAfter = page.url();
console.log('URL before:', urlBefore);
console.log('URL after:', urlAfter);

const tabState2 = await page.evaluate(() => ({
  href: location.href,
  activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  bodyText: document.body.innerText.slice(0, 300),
}));
console.log('after second pick:', JSON.stringify(tabState2, null, 2));

await page.screenshot({ path: 'debug-ehr-launch.png' });
console.log('screenshot at debug-ehr-launch.png');

console.log('--- main_v2_launch.php traffic:');
for (const r of launchNet) {
  console.log(`  ${r.phase} ${r.status ?? ''} ${r.url}`);
  if (r.body) console.log(`    body: ${r.body}`);
}

console.log('--- FHIR network traffic:');
for (const r of fhirNet.slice(0, 12)) {
  if (r.phase === 'req') {
    console.log(`  REQ ${r.method} ${r.url}`);
    console.log(`     authorization: ${r.headers.authorization ?? '(none)'}`);
    console.log(`     accept: ${r.headers.accept ?? '(none)'}`);
  } else {
    console.log(`  RES ${r.status} ${r.url}`);
    console.log(`     body: ${r.body}`);
  }
}

console.log('--- selected browser console output:');
for (const line of browserLog.filter((l) => l.match(/error|FHIR|SMART|launch|fail/i)).slice(0, 30)) {
  console.log('  ', line);
}

await browser.close();
