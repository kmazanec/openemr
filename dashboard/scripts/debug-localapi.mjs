// Verify that we can reach FHIR endpoints with just the OpenEMR
// session cookie + the APICSRFTOKEN header that main_v2.php
// already injects on `window.api_csrf_token_js`. This is the
// "LocalApi" auth path used by main.php's own background-services.
// If it works, we don't need a SMART OAuth flow at all for the
// SPA-hosted-inside-main_v2.php case.

import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';
const PID = process.env.OEMR_PID ?? '1';

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, { waitUntil: 'networkidle' });
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
await page.click('#login-button, button[type="submit"], input[type="submit"]');
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1000);

const probe = await page.evaluate(async (pid) => {
  const w = window;
  const csrf = w.api_csrf_token_js;
  const root = w.webroot_url || '';
  const site = w.site_id_js || 'default';
  const url = `${root}/apis/${site}/fhir/Patient/${encodeURIComponent(pid)}`;
  const r = await fetch(url, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/fhir+json',
      APICSRFTOKEN: csrf,
    },
  });
  const text = await r.text();
  return {
    csrfPresent: typeof csrf === 'string' && csrf.length > 0,
    url,
    status: r.status,
    ok: r.ok,
    contentType: r.headers.get('content-type'),
    body: text.slice(0, 500),
  };
}, PID);

console.log(JSON.stringify(probe, null, 2));

// Also try a Bundle search to confirm list endpoints work.
const probe2 = await page.evaluate(async (pid) => {
  const w = window;
  const csrf = w.api_csrf_token_js;
  const url = `${w.webroot_url || ''}/apis/${w.site_id_js || 'default'}/fhir/AllergyIntolerance?patient=${encodeURIComponent(pid)}`;
  const r = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/fhir+json', APICSRFTOKEN: csrf },
  });
  const text = await r.text();
  return { url, status: r.status, body: text.slice(0, 300) };
}, PID);
console.log(JSON.stringify(probe2, null, 2));

// Try Patient list with an identifier filter (legacy pid → uuid).
const probe3 = await page.evaluate(async (pid) => {
  const w = window;
  const csrf = w.api_csrf_token_js;
  const candidates = [
    `${w.webroot_url || ''}/apis/${w.site_id_js || 'default'}/fhir/Patient?identifier=${encodeURIComponent(pid)}`,
    `${w.webroot_url || ''}/apis/${w.site_id_js || 'default'}/fhir/Patient?_id=${encodeURIComponent(pid)}`,
    `${w.webroot_url || ''}/apis/${w.site_id_js || 'default'}/api/patient/${encodeURIComponent(pid)}`,
  ];
  const out = [];
  for (const url of candidates) {
    const r = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', APICSRFTOKEN: csrf },
    });
    const text = await r.text();
    out.push({ url, status: r.status, body: text.slice(0, 300) });
  }
  return out;
}, PID);
console.log(JSON.stringify(probe3, null, 2));

await browser.close();
