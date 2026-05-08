import { expect, test } from '@playwright/test';

// E2E for the Clinical Co-Pilot tab. Like the existing patient-context
// spec, this test runs against the standalone Vite dev server (no
// OpenEMR), so it can't hit a real agent service. We mock agent.php at
// the network layer with canned SSE frames; the panel sees the same
// stream a live agent would emit.
//
// Auth coverage: the test installs a fake OpenEMR session cookie and
// then asserts the panel's POST to agent.php carried it. That cookie
// is the credential the proxy mints the agent JWT against — so
// proving it's on the wire is the load-bearing auth assertion for
// the SPA → agent → upstream chain.

const SSE_BODY = `event: meta\ndata: ${JSON.stringify({
  type: 'meta',
  conversationId: 'conv-test-1',
  requestId: 'req-test-1',
  siteId: 'default',
})}\n\nevent: progress\ndata: ${JSON.stringify({
  type: 'progress',
  stage: 'retrieve',
  label: 'Reading the chart',
  status: 'completed',
})}\n\nevent: assistantMessage\ndata: ${JSON.stringify({
  type: 'assistantMessage',
  message: {
    segments: [
      {
        text: 'Patient is a 54-year-old with type 2 diabetes',
        claims: [
          {
            id: 'c1',
            text: 'Type 2 diabetes',
            category: 'diagnosis',
            sourceReferences: [
              {
                source_type: 'chart',
                source_id: 'cond-1',
                locator: { field: 'condition.code' },
                quote: 'E11.9',
              },
            ],
            safetyCritical: false,
          },
        ],
        redacted: false,
      },
      {
        text: ' and an A1c of 7.4% measured last month.',
        claims: [
          {
            id: 'c2',
            text: 'A1c 7.4',
            category: 'lab',
            sourceReferences: [
              {
                source_type: 'chart',
                source_id: 'obs-1',
                locator: { field: 'observation.value' },
                quote: '7.4 %',
              },
            ],
            safetyCritical: false,
          },
        ],
        redacted: false,
      },
    ],
    claimGroups: {},
    gaps: [],
    suggestedFollowUps: [
      { id: 's1', displayText: 'Show recent labs' },
      { id: 's2', displayText: 'Review medications' },
    ],
    archetypeFlags: [],
  },
})}\n\nevent: done\ndata: ${JSON.stringify({
  type: 'done',
  persistedAt: '2026-05-08T12:00:00Z',
})}\n\n`;

test.describe('Clinical Co-Pilot panel', () => {
  test('streams the briefing and renders citations + follow-ups', async ({ page, context }) => {
    const proxyCalls: Array<{
      url: string;
      method: string;
      body: string;
      cookieHeader: string | null;
      credentials: string;
    }> = [];

    await page.route(
      '**/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php**',
      async (route) => {
        const req = route.request();
        proxyCalls.push({
          url: req.url(),
          method: req.method(),
          body: req.postData() ?? '',
          cookieHeader: req.headers().cookie ?? null,
          // Playwright doesn't expose the fetch's credentials mode
          // directly, but presence of a cookie header is the proof
          // that `same-origin` was honored.
          credentials: req.headers().cookie !== undefined ? 'sent' : 'absent',
        });
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: SSE_BODY,
        });
      },
    );

    // Install an OpenEMR session cookie *before* the SPA mounts, so
    // the panel's first fetch carries it. Playwright cookies attached
    // to the context are automatically sent with same-origin requests.
    await context.addCookies([
      {
        name: 'OpenEMR',
        value: 'fake-session-id-for-test',
        domain: 'localhost',
        path: '/',
      },
    ]);

    await page.goto('/#/copilot/42');

    // The status line goes through "Loading…" → "Composing…" → the
    // assistant bubble appears.
    await expect(page.getByTestId('copilot-bubble-assistant')).toBeVisible({
      timeout: 10_000,
    });

    // Prose text shows both un-redacted segments concatenated.
    const prose = page.getByTestId('copilot-prose');
    await expect(prose).toContainText('Patient is a 54-year-old with type 2 diabetes');
    await expect(prose).toContainText('A1c of 7.4%');

    // Citation chips render with the chart source-type styling.
    await expect(page.getByTestId('copilot-chip').first()).toHaveAttribute(
      'data-source-type',
      'chart',
    );

    // Suggested follow-ups render as buttons under the bubble.
    await expect(page.getByTestId('copilot-suggestion').first()).toContainText(
      'Show recent labs',
    );

    // The proxy was called once with cookies and the right envelope.
    expect(proxyCalls.length).toBeGreaterThan(0);
    const first = proxyCalls[0]!;
    expect(first.method).toBe('POST');
    expect(first.url).toContain('action=briefing');
    expect(first.url).toContain('pid=42');
    // The OpenEMR session cookie is the load-bearing credential here.
    expect(first.cookieHeader ?? '').toContain('OpenEMR=fake-session-id-for-test');
    // The envelope shape matches the agent's `briefingRequestSchema`.
    const envelope = JSON.parse(first.body) as {
      task: string;
      patient: { pid: number };
      conversationId: string;
    };
    expect(envelope.task).toBe('default_briefing');
    expect(envelope.patient.pid).toBe(42);
    expect(envelope.conversationId).toMatch(/^conv-42-/);
  });

  test('renders a typed error bubble when the proxy returns 401', async ({ page }) => {
    await page.route(
      '**/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php**',
      async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'missingsession' }),
        });
      },
    );

    await page.goto('/#/copilot/42');

    await expect(page.getByTestId('copilot-bubble-error')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('copilot-bubble-error')).toContainText(
      'Authorization check failed',
    );
  });

  test('clicking a suggested follow-up sends a follow_up turn through the proxy', async ({ page }) => {
    const captured: string[] = [];
    await page.route(
      '**/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php**',
      async (route) => {
        captured.push(route.request().postData() ?? '');
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: SSE_BODY,
        });
      },
    );

    await page.goto('/#/copilot/42');
    await expect(page.getByTestId('copilot-bubble-assistant')).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId('copilot-suggestion').first().click();

    // The user bubble appears with the chip's text.
    await expect(page.getByTestId('copilot-bubble-user')).toContainText('Show recent labs');

    // A second proxy call fired with task=follow_up.
    await expect.poll(() => captured.length).toBeGreaterThanOrEqual(2);
    const lastBody = captured[captured.length - 1]!;
    const env = JSON.parse(lastBody) as { task: string; question?: string };
    expect(env.task).toBe('follow_up');
    expect(env.question).toBe('Show recent labs');
  });
});
