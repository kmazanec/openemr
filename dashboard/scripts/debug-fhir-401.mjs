import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';
const PID = process.env.OEMR_PID ?? '1';

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.on('console', (m) => console.log(`[browser ${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

async function waitForStableUrl(quietMs = 1500, timeoutMs = 25000) {
  const start = Date.now();
  let lastUrl = page.url();
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(200);
    const u = page.url();
    if (u !== lastUrl) { lastUrl = u; lastChange = Date.now(); }
    if (Date.now() - lastChange >= quietMs) return u;
  }
  return lastUrl;
}

await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, { waitUntil: 'networkidle' });
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
await page.click('#login-button, button[type="submit"], input[type="submit"]');
await waitForStableUrl();

console.log('--- before any pick: sessionStorage:');
let s = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    out[k] = sessionStorage.getItem(k);
  }
  return out;
});
console.log(JSON.stringify(Object.keys(s)));

console.log('--- triggering EHR launch (pick patient', PID, ')');
await page.evaluate((pid) => {
  window.RTop.location = `../../patient_file/summary/demographics.php?set_pid=${encodeURIComponent(pid)}`;
}, PID);
await waitForStableUrl(2000, 25000);

console.log('--- post-redirect URL:', page.url());
console.log('--- post-redirect sessionStorage:');
s = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    out[k] = sessionStorage.getItem(k);
  }
  return out;
});
for (const [k, v] of Object.entries(s)) {
  console.log(`  ${k}: ${v.slice(0, 250)}`);
}

console.log('--- now mount the patient route via set_pid');
await page.evaluate((pid) => window.set_pid(pid), PID);
await page.waitForTimeout(500);

console.log('--- after second mount: sessionStorage:');
s = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    out[k] = sessionStorage.getItem(k);
  }
  return out;
});
for (const [k, v] of Object.entries(s)) {
  console.log(`  ${k}: ${v.slice(0, 250)}`);
}

await browser.close();
