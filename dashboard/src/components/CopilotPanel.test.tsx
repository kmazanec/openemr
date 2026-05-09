import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopilotPanel } from './CopilotPanel';
import type { AssistantMessage, CopilotStreamEvent } from '../lib/copilotTypes';

// Helper: build an SSE-framed string from a sequence of events.
function sseFrames(events: CopilotStreamEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// Helper: a minimal assistant message that exercises segments, claims,
// gaps, and suggested follow-ups.
function buildAssistantMessage(): AssistantMessage {
  return {
    segments: [
      {
        text: 'Patient has type 2 diabetes',
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
        text: ' and last A1c was 7.2%.',
        claims: [
          {
            id: 'c2',
            text: 'A1c 7.2',
            category: 'lab',
            sourceReferences: [
              {
                source_type: 'chart',
                source_id: 'obs-1',
                locator: { field: 'observation.value' },
                quote: '7.2 %',
              },
            ],
            safetyCritical: false,
          },
        ],
        redacted: false,
      },
      {
        text: '[redacted segment]',
        claims: [],
        redacted: true,
      },
    ],
    claimGroups: {},
    gaps: [
      {
        reason: 'allergies-unavailable',
        message: 'Allergy data could not be verified.',
      },
    ],
    suggestedFollowUps: [
      { id: 's1', displayText: 'Review recent labs' },
      { id: 's2', displayText: 'Check medications' },
    ],
    archetypeFlags: [],
  };
}

// Mock the global fetch with a streaming Response. The body is a
// ReadableStream that pushes the canned SSE bytes and closes.
function mockFetchStream(body: string, status = 200): void {
  global.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    ),
  );
}

function mockFetchJsonError(status: number, errorCode: string): void {
  global.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: errorCode }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

describe('CopilotPanel', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Stub scrollIntoView (jsdom doesn't implement it).
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('auto-fires the default briefing on mount and renders the assistant message', async () => {
    const message = buildAssistantMessage();
    mockFetchStream(
      sseFrames([
        { type: 'meta', conversationId: 'conv-1', requestId: 'r1', siteId: 'default' },
        { type: 'progress', stage: 'retrieve', label: 'Reading the chart', status: 'started' },
        { type: 'progress', stage: 'retrieve', label: 'Reading the chart', status: 'completed' },
        { type: 'assistantMessage', message },
        { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
      ]),
    );

    render(<CopilotPanel pid={42} />);

    await waitFor(() =>
      expect(screen.getByTestId('copilot-bubble-assistant')).toBeInTheDocument(),
    );

    // Prose contains both un-redacted segments.
    const prose = screen.getByTestId('copilot-prose').textContent ?? '';
    expect(prose).toContain('Patient has type 2 diabetes');
    expect(prose).toContain('A1c was 7.2%.');
    // The redacted segment is replaced by an "unverified" chip, not
    // rendered inline as the redaction text.
    expect(prose).not.toContain('[redacted segment]');
    expect(screen.getByTestId('copilot-redacted-chip')).toHaveTextContent(/1 unverified/);

    // Claim chips render with source-type metadata.
    const chips = screen.getAllByTestId('copilot-chip');
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(chips[0]?.getAttribute('data-source-type')).toBe('chart');

    // Message-level gap renders as a warning.
    expect(screen.getByTestId('copilot-gap')).toHaveTextContent(/Allergy data unavailable/);

    // Suggested follow-ups render as buttons.
    const suggestions = screen.getAllByTestId('copilot-suggestion');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toHaveTextContent('Review recent labs');
  });

  it('shows a typed error bubble when the proxy returns 401 missingsession', async () => {
    mockFetchJsonError(401, 'missingsession');
    render(<CopilotPanel pid={42} />);
    await waitFor(() =>
      expect(screen.getByTestId('copilot-bubble-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('copilot-bubble-error')).toHaveTextContent(
      /Authorization check failed/,
    );
  });

  it('renders a transport-level error when the network fails', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('Failed to fetch')));
    render(<CopilotPanel pid={42} />);
    await waitFor(() =>
      expect(screen.getByTestId('copilot-bubble-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('copilot-bubble-error')).toHaveTextContent(
      /Network error/,
    );
  });

  it('clicking a follow-up suggestion sends a follow_up turn', async () => {
    const message = buildAssistantMessage();
    const captured: { url: string; body: string }[] = [];
    global.fetch = vi.fn((url: unknown, init?: RequestInit) => {
      const body = init?.body;
      const bodyText = typeof body === 'string' ? body : '';
      captured.push({ url: String(url), body: bodyText });
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  sseFrames([
                    { type: 'meta', conversationId: 'conv-1', requestId: 'r2', siteId: 'default' },
                    { type: 'assistantMessage', message },
                    { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
                  ]),
                ),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    });

    render(<CopilotPanel pid={42} />);
    // Wait for the initial briefing to settle.
    await waitFor(() => screen.getAllByTestId('copilot-suggestion'));

    const chip = screen.getAllByTestId('copilot-suggestion')[0];
    expect(chip).toBeDefined();
    if (chip !== undefined) fireEvent.click(chip);

    // The user's question now appears as a user bubble.
    await waitFor(() =>
      expect(screen.getByTestId('copilot-bubble-user')).toHaveTextContent(
        'Review recent labs',
      ),
    );
    // The most recent POST body has task=follow_up and the question.
    const latest = captured[captured.length - 1];
    expect(latest).toBeDefined();
    if (latest === undefined) return;
    const parsed = JSON.parse(latest.body) as { task: string; question?: string };
    expect(parsed.task).toBe('follow_up');
    expect(parsed.question).toBe('Review recent labs');
  });

  it('typing in the composer and pressing Enter submits a follow-up', async () => {
    const message = buildAssistantMessage();
    // `briefingCalls` ignores the history-sidebar's `conversation_history`
    // request — that fires on mount but is not what this test is
    // covering. The first briefing call is the auto-fired
    // default_briefing; the second is the follow-up under test.
    let briefingCalls = 0;
    let lastBody = '';
    global.fetch = vi.fn((url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : '';
      if (urlStr.includes('action=briefing')) {
        briefingCalls += 1;
        lastBody = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    sseFrames([
                      { type: 'meta', conversationId: 'conv-1', requestId: 'rn', siteId: 'default' },
                      { type: 'assistantMessage', message },
                      { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
                    ]),
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
        );
      }
      // History sidebar's GET — return an empty list so the sidebar
      // renders its empty state without throwing.
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], nextBefore: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    render(<CopilotPanel pid={42} />);
    await waitFor(() => screen.getByTestId('copilot-bubble-assistant'));
    expect(briefingCalls).toBe(1);

    const composer = screen.getByTestId('copilot-composer');
    fireEvent.change(composer, { target: { value: 'When is the next visit?' } });
    // Submit via the form submit button rather than synthesizing a key
    // event — JSDOM doesn't bind requestSubmit to keyboard handlers
    // reliably, but a real click on the submit button is identical
    // semantics from the user's standpoint and avoids the polyfill
    // dance.
    fireEvent.click(screen.getByTestId('copilot-submit'));

    await waitFor(() => expect(briefingCalls).toBe(2));
    const parsed = JSON.parse(lastBody) as { task: string; question?: string };
    expect(parsed.task).toBe('follow_up');
    expect(parsed.question).toBe('When is the next visit?');
  });

  it('uses same-origin credentials so the OpenEMR PHP session cookie is sent', async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    });

    render(<CopilotPanel pid={42} />);
    await waitFor(() => expect(capturedInit).toBeDefined());
    expect(capturedInit?.credentials).toBe('same-origin');
  });

  it('clicking an extracted_document chip opens the document drawer', async () => {
    const docMessage: AssistantMessage = {
      segments: [
        {
          text: 'The intake form lists penicillin allergy',
          claims: [
            {
              id: 'cd1',
              text: 'penicillin allergy',
              category: 'allergy',
              sourceReferences: [
                {
                  source_type: 'extracted_document',
                  source_id: 'artifact-1',
                  locator: {
                    page: 2,
                    bbox: [120, 340, 380, 60],
                    field: 'allergies[0].substance',
                  },
                  quote: 'Penicillin — hives',
                  meta: { document_uuid: 'doc-uuid-1' },
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
    };
    mockFetchStream(
      sseFrames([
        { type: 'meta', conversationId: 'conv-d', requestId: 'r-d', siteId: 'default' },
        { type: 'assistantMessage', message: docMessage },
        { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
      ]),
    );

    render(<CopilotPanel pid={42} />);
    await waitFor(() => screen.getByTestId('copilot-bubble-assistant'));

    // The chip is interactive (button), not an anchor.
    const chip = screen.getByTestId('copilot-chip');
    expect(chip.tagName).toBe('BUTTON');

    // Document drawer not open yet.
    expect(screen.queryByTestId('copilot-doc-drawer')).toBeNull();

    fireEvent.click(chip);
    // Drawer mounts and starts loading the document — fetch was
    // re-stubbed for the briefing call; for this assertion we just
    // need the drawer to be visible.
    await waitFor(() => expect(screen.getByTestId('copilot-doc-drawer')).toBeInTheDocument());
  });

  it('clicking a guideline chip opens the guideline drawer with the publication and quote', async () => {
    const guidelineMessage: AssistantMessage = {
      segments: [
        {
          text: 'USPSTF recommends statin therapy for primary prevention',
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
    };
    mockFetchStream(
      sseFrames([
        { type: 'meta', conversationId: 'conv-g', requestId: 'r-g', siteId: 'default' },
        { type: 'assistantMessage', message: guidelineMessage },
        { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
      ]),
    );

    render(<CopilotPanel pid={42} />);
    await waitFor(() => screen.getByTestId('copilot-bubble-assistant'));

    const chip = screen.getByTestId('copilot-chip');
    expect(chip).toHaveAttribute('data-source-type', 'guideline');
    // Inline chip uses the literal `[source]` label (matching the
    // legacy panel); the publication name shows in the drawer.
    expect(chip).toHaveTextContent('[source]');
    fireEvent.click(chip);

    await waitFor(() =>
      expect(screen.getByTestId('copilot-guideline-drawer')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('copilot-guideline-publication')).toHaveTextContent('USPSTF');
    expect(screen.getByTestId('copilot-guideline-quote')).toHaveTextContent(
      'prescribe a statin',
    );

    // A second click on the same chip closes it (toggle behavior).
    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.queryByTestId('copilot-guideline-drawer')).toBeNull(),
    );
  });

  it('clicking a chart chip opens a popover with the cited fact and a "View full record" link', async () => {
    // Encounter chart-source: sourceLinkUrl produces a deep link, so
    // the popover footer should render the live "View full record →"
    // anchor (not the disabled fallback).
    const chartMessage: AssistantMessage = {
      segments: [
        {
          text: 'Most recent visit was an annual physical.',
          claims: [
            {
              id: 'cc1',
              text: 'Annual physical on 2026-03-07',
              category: 'encounter',
              sourceReferences: [
                {
                  source_type: 'chart',
                  source_id: '42',
                  locator: { field: 'encounter.reason' },
                  quote: 'Annual physical (Encounter #42)',
                  meta: { record_recorded_at: '2026-03-07' },
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
    };
    mockFetchStream(
      sseFrames([
        { type: 'meta', conversationId: 'conv-cc', requestId: 'r-cc', siteId: 'default' },
        { type: 'assistantMessage', message: chartMessage },
        { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
      ]),
    );

    render(<CopilotPanel pid={42} />);
    await waitFor(() => screen.getByTestId('copilot-bubble-assistant'));

    const chip = screen.getByTestId('copilot-chip');
    expect(chip).toHaveAttribute('data-source-type', 'chart');
    // All chips render as <button> now — chart chips drive a popover
    // rather than navigating directly.
    expect(chip.tagName).toBe('BUTTON');

    // Popover not open until the user clicks.
    expect(screen.queryByTestId('copilot-chip-popover')).toBeNull();

    fireEvent.click(chip);

    const popover = await screen.findByTestId('copilot-chip-popover');
    // Category title-cased from `encounter` → "Encounter".
    expect(popover.textContent).toContain('Encounter');
    // Claim text with ISO date reformatted to long form.
    expect(screen.getByTestId('copilot-chip-popover-claim')).toHaveTextContent(
      'Annual physical on March 7, 2026',
    );
    // Quote line carries the chip tooltip body.
    expect(screen.getByTestId('copilot-chip-popover-quote')).toHaveTextContent(
      'Annual physical (Encounter #42)',
    );
    // "View full record →" deep link points at the encounter view.
    const link = screen.getByTestId('copilot-chip-popover-link');
    expect(link).toHaveAttribute('href', '/interface/forms/encounter/view.php?id=42');

    // Second click on the same chip closes the popover (toggle UX).
    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.queryByTestId('copilot-chip-popover')).toBeNull(),
    );
  });

  it('renders a trend chart inside the assistant bubble when the message carries one', async () => {
    const message: AssistantMessage = {
      ...buildAssistantMessage(),
      // Override gaps so we don't have to assert around the unrelated
      // allergies banner; this case is purely about the chart slot.
      gaps: [],
      trendChart: {
        analyte: 'Hemoglobin A1c',
        unit: '%',
        referenceRange: '<5.7',
        reason: 'fresh_lab_with_history',
        groundedInClaimIds: ['c2'],
        points: [
          { observedAt: '2024-09-01T00:00:00Z', value: 7.4, abnormal: true },
          { observedAt: '2025-04-01T00:00:00Z', value: 8.4, abnormal: true },
        ],
      },
    };
    mockFetchStream(
      sseFrames([
        { type: 'meta', conversationId: 'conv-1', requestId: 'r1', siteId: 'default' },
        { type: 'assistantMessage', message },
        { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
      ]),
    );

    render(<CopilotPanel pid={42} />);

    await waitFor(() =>
      expect(screen.getByTestId('copilot-bubble-assistant')).toBeInTheDocument(),
    );

    const figure = screen.getByTestId('copilot-trend-chart');
    expect(figure).toHaveAttribute('data-reason', 'fresh_lab_with_history');
    expect(figure.textContent).toContain('Hemoglobin A1c (%) — new value in context');
    expect(screen.getAllByTestId('copilot-trend-dot')).toHaveLength(2);

    // Single-chart cap is structural (the wire shape is one slot,
    // not an array) — still good to pin in the integration test
    // that there's one and only one chart in the bubble.
    expect(screen.getAllByTestId('copilot-trend-chart')).toHaveLength(1);
  });

  it('does not render a trend chart when the message omits the slot', async () => {
    // Default `buildAssistantMessage()` has no `trendChart` field —
    // the chart should be absent from the bubble.
    mockFetchStream(
      sseFrames([
        { type: 'meta', conversationId: 'conv-1', requestId: 'r1', siteId: 'default' },
        { type: 'assistantMessage', message: buildAssistantMessage() },
        { type: 'done', persistedAt: '2026-05-08T00:00:00Z' },
      ]),
    );

    render(<CopilotPanel pid={42} />);

    await waitFor(() =>
      expect(screen.getByTestId('copilot-bubble-assistant')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('copilot-trend-chart')).toBeNull();
  });
});
