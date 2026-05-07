// One-off Playwright debug harness for the Calendar-iframe-blank
// issue. Drives the live dev compose stack at http://localhost:8300/
// (NOT the standalone Vite dev server), logs in via ?v2=1, then
// dumps the iframe state.
//
// Run with: cd dashboard && node scripts/debug-iframe.mjs

import { chromium } from 'playwright';

const BASE = process.env.OEMR_BASE ?? 'http://localhost:8300';
const USER = process.env.OEMR_USER ?? 'admin';
const PASS = process.env.OEMR_PASS ?? 'pass';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('console', (msg) => {
  console.log(`[browser ${msg.type()}]`, msg.text());
});
page.on('pageerror', (err) => {
  console.log('[browser pageerror]', err.message);
});

console.log('navigating to login with v2=1');
await page.goto(`${BASE}/interface/login/login.php?site=default&v2=1`, {
  waitUntil: 'networkidle',
});

console.log('filling login form');
await page.fill('#authUser', USER);
await page.fill('#clearPass', PASS);
// keep v2=1 hidden field if present, then submit
const v2Hidden = await page.$('input[name="v2"]');
if (!v2Hidden) {
  // some templates omit the hidden; inject if needed
  await page.evaluate(() => {
    const f = document.forms[0];
    if (f && !f.querySelector('input[name="v2"]')) {
      const i = document.createElement('input');
      i.type = 'hidden';
      i.name = 'v2';
      i.value = '1';
      f.appendChild(i);
    }
  });
}
await Promise.all([
  page.waitForLoadState('networkidle'),
  page.click('#login-button, button[type="submit"], input[type="submit"]'),
]);

console.log('post-login URL:', page.url());

// Wait a beat for the SPA to mount and seed tabs.
await page.waitForTimeout(1500);

const dump = await page.evaluate(() => {
  const root = document.getElementById('dashboard-root');
  const rootRect = root?.getBoundingClientRect();
  const shell = document.querySelector('.patient-shell');
  const shellRect = shell?.getBoundingClientRect();
  const tabContent = document.querySelector('.tab-content');
  const tabContentRect = tabContent?.getBoundingClientRect();
  const wrappers = Array.from(document.querySelectorAll('[data-testid="legacy-iframe-wrapper"]'));
  const iframes = wrappers.map((w) => {
    const iframe = w.querySelector('iframe');
    const r = w.getBoundingClientRect();
    return {
      hidden: w.hidden,
      classes: w.className,
      style: w.getAttribute('style'),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      iframeSrc: iframe?.getAttribute('src'),
      iframeRect: iframe ? (() => {
        const ir = iframe.getBoundingClientRect();
        return { x: ir.x, y: ir.y, w: ir.width, h: ir.height };
      })() : null,
    };
  });
  return {
    href: location.href,
    bodyClass: document.body.className,
    rootRect: rootRect ? { w: rootRect.width, h: rootRect.height } : null,
    rootStyles: root ? {
      display: getComputedStyle(root).display,
      position: getComputedStyle(root).position,
      flex: getComputedStyle(root).flex,
      height: getComputedStyle(root).height,
    } : null,
    shellRect: shellRect ? { w: shellRect.width, h: shellRect.height } : null,
    tabContentRect: tabContentRect ? { w: tabContentRect.width, h: tabContentRect.height } : null,
    tabContentStyles: tabContent ? {
      position: getComputedStyle(tabContent).position,
      flex: getComputedStyle(tabContent).flex,
      height: getComputedStyle(tabContent).height,
    } : null,
    iframes,
    activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    OE_DEFAULT_TABS: window.OE_DEFAULT_TABS,
  };
});

console.log(JSON.stringify(dump, null, 2));

await page.screenshot({ path: 'debug-iframe.png', fullPage: false });
console.log('screenshot at debug-iframe.png');

await browser.close();
