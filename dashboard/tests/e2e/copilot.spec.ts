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

  test('clicking an extracted_document chip opens the side drawer with a bbox overlay', async ({
    page,
  }) => {
    const docSseBody =
      `event: meta\ndata: ${JSON.stringify({
        type: 'meta',
        conversationId: 'conv-d',
        requestId: 'req-d',
        siteId: 'default',
      })}\n\nevent: assistantMessage\ndata: ${JSON.stringify({
        type: 'assistantMessage',
        message: {
          segments: [
            {
              text: 'Intake form lists penicillin allergy',
              claims: [
                {
                  id: 'cd1',
                  text: 'penicillin allergy',
                  category: 'allergy',
                  sourceReferences: [
                    {
                      source_type: 'extracted_document',
                      source_id: 'art-1',
                      locator: {
                        page: 1,
                        bbox: [120, 340, 380, 60],
                      },
                      quote: 'Penicillin — hives',
                      meta: { document_uuid: 'doc-uuid-e2e' },
                    },
                  ],
                  safetyCritical: true,
                },
              ],
              redacted: false,
            },
          ],
          claimGroups: {},
          gaps: [],
          suggestedFollowUps: [],
          archetypeFlags: [],
        },
      })}\n\nevent: done\ndata: ${JSON.stringify({
        type: 'done',
        persistedAt: '2026-05-08T00:00:00Z',
      })}\n\n`;

    await page.route(
      '**/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: docSseBody,
        });
      },
    );

    // A 1×1 PNG so the image branch can decode and lay out a real
    // wrapper in the browser. The actual pixels are irrelevant — the
    // bbox overlay positions in CSS percentages relative to the
    // wrapper, and we only assert "an overlay is present and
    // percent-positioned".
    const onePxPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    const pngBuffer = Buffer.from(onePxPngBase64, 'base64');

    let docFetched = false;
    await page.route(
      '**/interface/modules/custom_modules/oe-module-clinical-copilot/public/document_view.php**',
      async (route) => {
        docFetched = true;
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: pngBuffer,
        });
      },
    );

    await page.goto('/#/copilot/42');
    const chip = page.getByTestId('copilot-chip').first();
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveAttribute('data-source-type', 'extracted_document');

    // Drawer not open before the click.
    await expect(page.getByTestId('copilot-doc-drawer')).toHaveCount(0);

    await chip.click();

    // Drawer mounts, the document_view.php endpoint is hit, and the
    // image wrapper renders.
    await expect(page.getByTestId('copilot-doc-drawer')).toBeVisible();
    await expect.poll(() => docFetched).toBe(true);
    await expect(page.getByTestId('copilot-doc-image-wrapper')).toBeVisible();

    // The bbox overlay is positioned in percentages (normalized
    // 0..1000 grid → CSS percent), which proves the bbox math wired
    // through end-to-end.
    const overlay = page.getByTestId('copilot-doc-bbox');
    await expect(overlay).toBeVisible();
    const left = await overlay.evaluate((el) => (el as HTMLElement).style.left);
    expect(left).toMatch(/%$/);

    // The drawer closes on Escape.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('copilot-doc-drawer')).toHaveCount(0);
  });

  test('clicking a guideline chip opens the guideline drawer with publication + quote', async ({
    page,
  }) => {
    const guidelineSseBody =
      `event: meta\ndata: ${JSON.stringify({
        type: 'meta',
        conversationId: 'conv-g',
        requestId: 'req-g',
        siteId: 'default',
      })}\n\nevent: assistantMessage\ndata: ${JSON.stringify({
        type: 'assistantMessage',
        message: {
          segments: [
            {
              text: 'USPSTF recommends statin therapy',
              claims: [
                {
                  id: 'cg1',
                  text: 'statin recommendation',
                  category: 'diagnosis',
                  sourceReferences: [
                    {
                      source_type: 'guideline',
                      source_id: 'uspstf-statin-2026',
                      locator: { section: 'Recommendation 1' },
                      quote:
                        'For adults aged 40-75 years with one or more CVD risk factors, prescribe a statin for primary prevention.',
                      meta: {
                        publication: 'USPSTF',
                        title: 'Statin Use for Primary Prevention',
                        year: 2026,
                        url: 'https://example.org/uspstf',
                      },
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
          suggestedFollowUps: [],
          archetypeFlags: [],
        },
      })}\n\nevent: done\ndata: ${JSON.stringify({
        type: 'done',
        persistedAt: '2026-05-08T00:00:00Z',
      })}\n\n`;

    await page.route(
      '**/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: guidelineSseBody,
        });
      },
    );

    await page.goto('/#/copilot/42');
    const chip = page.getByTestId('copilot-chip').first();
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveAttribute('data-source-type', 'guideline');
    await chip.click();

    await expect(page.getByTestId('copilot-guideline-drawer')).toBeVisible();
    await expect(page.getByTestId('copilot-guideline-publication')).toContainText('USPSTF');
    await expect(page.getByTestId('copilot-guideline-quote')).toContainText(
      'prescribe a statin',
    );
    await expect(page.getByTestId('copilot-guideline-link')).toHaveAttribute(
      'href',
      'https://example.org/uspstf',
    );

    // Closes on the close button.
    await page.getByTestId('copilot-guideline-close').click();
    await expect(page.getByTestId('copilot-guideline-drawer')).toHaveCount(0);
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
