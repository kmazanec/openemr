// Verify the same-origin SMART flow.
// 1. login to OpenEMR with ?v2=1
// 2. inspect what discovery URL fhirclient resolves to
// 3. check whether http://localhost:8300/oauth2/default/authorize accepts a request
// 4. attempt the EHR-launch-flow precondition: build a launch token via PHP
//    and verify the authorize endpoint accepts it.

import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.text().includes('FHIR') || msg.text().includes('SMART')) {
    console.log(`[browser ${msg.type()}]`, msg.text());
  }
});

await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, { waitUntil: 'networkidle' });
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
await page.click('#login-button, button[type="submit"], input[type="submit"]');
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1000);
console.log('post-login URL:', page.url());

// Smart-configuration on each origin.
const probe = await page.evaluate(async () => {
  const origin = location.origin;
  const cfgUrl = `${origin}/apis/default/fhir/.well-known/smart-configuration`;
  const r = await fetch(cfgUrl);
  return { cfgUrl, smart: await r.json() };
});
console.log('SMART config:', JSON.stringify(probe, null, 2));

// Hit the authorize endpoint at the *same origin* (port 8300) with bogus params
// and check the response — if it 400s with a normal OAuth error, the endpoint
// is willing to talk to us on this origin.
const authzAtSameOrigin = await page.evaluate(async () => {
  const origin = location.origin;
  const r = await fetch(`${origin}/oauth2/default/authorize?client_id=foo&response_type=code&redirect_uri=http://localhost:8300/cb`, {
    redirect: 'manual',
  });
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: (await r.text()).slice(0, 200) };
});
console.log('authorize at same origin:', JSON.stringify(authzAtSameOrigin, null, 2));

await browser.close();
