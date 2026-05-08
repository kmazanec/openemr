// Probes the SMART-on-FHIR auth path.

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
page.on('console', (msg) => console.log(`[browser ${msg.type()}]`, msg.text()));
page.on('pageerror', (err) => console.log('[browser pageerror]', err.message));

await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, { waitUntil: 'networkidle' });
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.click('#login-button, button[type="submit"], input[type="submit"]'),
]);
await page.waitForTimeout(2000);
console.log('post-login URL:', page.url());

// Probe 1 — try the FHIR discovery URL from inside the page.
const discovery = await page.evaluate(async () => {
  const candidates = [
    'https://localhost:9300/apis/default/fhir/.well-known/smart-configuration',
    'http://localhost:8300/apis/default/fhir/.well-known/smart-configuration',
    `${location.origin}/apis/default/fhir/.well-known/smart-configuration`,
  ];
  const results = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url);
      results.push({ url, status: r.status, ok: r.ok });
    } catch (e) {
      results.push({ url, error: String(e) });
    }
  }
  return results;
});
console.log('discovery probe:', JSON.stringify(discovery, null, 2));

// Probe 2 — registration endpoint test
const reg = await page.evaluate(async () => {
  const url = `${location.origin}/oauth2/default/registration`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_type: 'public',
        redirect_uris: [`${location.origin}/interface/main/tabs/main_v2.php`],
        client_name: 'Probe',
        scope: 'openid',
      }),
    });
    const text = await r.text();
    return { url, status: r.status, ok: r.ok, body: text.slice(0, 400) };
  } catch (e) {
    return { url, error: String(e) };
  }
});
console.log('registration probe:', JSON.stringify(reg, null, 2));

await browser.close();
