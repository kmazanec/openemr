import { useCallback, useEffect, useRef, useState } from 'react';
import { SseParser } from './sseParser';
import { restoreTopSession } from './restoreTopSession';
import type {
  AssistantMessage,
  CopilotStreamEvent,
  SuggestedFollowUp,
} from './copilotTypes';

// The Co-Pilot proxy URL inside OpenEMR. Same-origin with the dashboard
// SPA when both are served by Apache, so the OpenEMR PHP session
// cookie is sent automatically with `credentials: 'same-origin'`. The
// proxy mints the agent JWT itself.
const PROXY_URL =
  '/interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php';


export type CopilotTurn =
  | { kind: 'user'; text: string }
  | {
      kind: 'progress';
      requestId: string;
      stages: {
        stage: 'retrieve' | 'synthesize' | 'verify' | 'format';
        label: string;
        status: 'pending' | 'started' | 'completed';
      }[];
      narration: string | null;
    }
  | { kind: 'thinking'; requestId: string; narration: string | null }
  | { kind: 'assistant'; message: AssistantMessage }
  | { kind: 'error'; code: string };

export interface CopilotState {
  turns: CopilotTurn[];
  conversationId: string;
  // True between submit and the terminal `done` / `error` event.
  inFlight: boolean;
  // Surfaced separately from the in-thread error turn so the composer
  // can show a transient banner without polluting the bubble history.
  lastTransportError: string | null;
}

export interface UseCopilotStreamArgs {
  pid: number;
  siteId: string;
  // Optional override for tests — Playwright tests intercept this URL
  // to feed canned SSE frames.
  proxyUrl?: string;
}

const DEFAULT_PROGRESS_STAGES: CopilotTurn = {
  kind: 'progress',
  requestId: '',
  stages: [
    { stage: 'retrieve', label: 'Reading the chart', status: 'pending' },
    { stage: 'synthesize', label: 'Composing briefing', status: 'pending' },
    { stage: 'verify', label: 'Verifying citations', status: 'pending' },
    { stage: 'format', label: 'Finalizing', status: 'pending' },
  ],
  narration: null,
};

function freshProgress(requestId: string): CopilotTurn {
  return {
    kind: 'progress',
    requestId,
    stages: DEFAULT_PROGRESS_STAGES.kind === 'progress'
      ? DEFAULT_PROGRESS_STAGES.stages.map((s) => ({ ...s }))
      : [],
    narration: null,
  };
}

function newConversationId(pid: number): string {
  return `conv-${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newRequestId(pid: number): string {
  return `req-${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Drives a Clinical Co-Pilot conversation: opens a streaming POST to
 * the agent proxy on `submit`, parses SSE frames, and reduces them
 * into a thread of turns.
 *
 * Auth: same-origin POST with the OpenEMR PHP session cookie. The
 * proxy validates the session, mints a 5-minute JWT for the agent,
 * and forwards. No bearer token is held in the SPA.
 */
export interface PendingUpload {
  documentUuid: string;
  docType: string;
  canonicalExt: string;
}

export function useCopilotStream({
  pid,
  siteId,
  proxyUrl = PROXY_URL,
}: UseCopilotStreamArgs): {
  state: CopilotState;
  submit: (input: {
    task: 'default_briefing' | 'follow_up';
    question?: string;
    pendingUploads?: PendingUpload[];
  }) => void;
  reset: () => void;
  loadConversation: (conversationId: string) => Promise<boolean>;
} {
  const [state, setState] = useState<CopilotState>(() => ({
    turns: [],
    conversationId: newConversationId(pid),
    inFlight: false,
    lastTransportError: null,
  }));
  // Hold a ref to the in-flight AbortController so a fresh submit can
  // cancel a previous one (and unmount aborts cleanly).
  const abortRef = useRef<AbortController | null>(null);

  // Reset on patient switch — the conversation belongs to (user, pid).
  useEffect(() => {
    setState({
      turns: [],
      conversationId: newConversationId(pid),
      inFlight: false,
      lastTransportError: null,
    });
    abortRef.current?.abort();
    abortRef.current = null;
  }, [pid]);

  // Abort any in-flight stream when the hook unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const submit = useCallback(
    (input: {
      task: 'default_briefing' | 'follow_up';
      question?: string;
      pendingUploads?: PendingUpload[];
    }) => {
      // Cancel any in-flight turn before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const requestId = newRequestId(pid);
      const isBriefing = input.task === 'default_briefing';
      const placeholder: CopilotTurn = isBriefing
        ? freshProgress(requestId)
        : { kind: 'thinking', requestId, narration: null };

      setState((prev) => ({
        ...prev,
        inFlight: true,
        lastTransportError: null,
        turns: [
          ...prev.turns,
          ...(input.question !== undefined && input.question !== ''
            ? [{ kind: 'user', text: input.question } as CopilotTurn]
            : []),
          placeholder,
        ],
      }));

      const body = JSON.stringify({
        conversationId: state.conversationId,
        requestId,
        siteId,
        patient: { pid, uuid: '' },
        task: input.task,
        ...(input.question !== undefined && input.question !== ''
          ? { question: input.question }
          : {}),
        ...(input.pendingUploads !== undefined && input.pendingUploads.length > 0
          ? { pendingUploads: input.pendingUploads }
          : {}),
      });

      const url = `${proxyUrl}?action=briefing&pid=${encodeURIComponent(String(pid))}`;
      const parser = new SseParser();

      void (async () => {
        try {
          restoreTopSession();
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body,
            signal: controller.signal,
          });
          if (!response.ok || response.body === null) {
            // Pre-stream error (401/403/502/etc.). The proxy returns
            // JSON `{error: code}`; surface the code to the UI.
            let code = `http_${response.status}`;
            try {
              const j = (await response.json()) as { error?: unknown };
              if (typeof j.error === 'string') code = j.error;
            } catch {
              // Body wasn't JSON; keep the http_<status> code.
            }
            setState((prev) => ({
              ...prev,
              inFlight: false,
              lastTransportError: code,
              turns: replacePlaceholder(prev.turns, requestId, {
                kind: 'error',
                code,
              }),
            }));
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const frames = parser.feed(chunk);
            for (const frame of frames) {
              let parsed: CopilotStreamEvent | null = null;
              try {
                parsed = JSON.parse(frame.data) as CopilotStreamEvent;
              } catch {
                continue;
              }
              const event = parsed;
              setState((prev) => reduce(prev, event, requestId));
            }
          }
          // Stream closed cleanly.
          setState((prev) => ({ ...prev, inFlight: false }));
        } catch (err) {
          if (controller.signal.aborted) {
            // Caller-initiated cancel — leave state alone except to
            // mark the run as no longer in-flight.
            setState((prev) => ({ ...prev, inFlight: false }));
            return;
          }
          const message = err instanceof Error ? err.message : 'network';
          setState((prev) => ({
            ...prev,
            inFlight: false,
            lastTransportError: message,
            turns: replacePlaceholder(prev.turns, requestId, {
              kind: 'error',
              code: 'network_error',
            }),
          }));
        }
      })();
    },
    [pid, proxyUrl, siteId, state.conversationId],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({
      turns: [],
      conversationId: newConversationId(pid),
      inFlight: false,
      lastTransportError: null,
    });
  }, [pid]);

  const loadConversation = useCallback(
    async (conversationId: string): Promise<boolean> => {
      abortRef.current?.abort();
      const params = new URLSearchParams({
        action: 'latest_conversation',
        pid: String(pid),
        conversation: conversationId,
      });
      try {
        const response = await fetch(`${proxyUrl}?${params.toString()}`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return false;
        const payload = (await response.json()) as {
          conversationId?: string;
          thread?: Array<
            | { role: 'assistant'; message: AssistantMessage }
            | { role: 'user'; text: string }
          >;
        };
        if (typeof payload.conversationId !== 'string') return false;
        const items = Array.isArray(payload.thread) ? payload.thread : [];
        const turns: CopilotTurn[] = [];
        for (const item of items) {
          if (item.role === 'user' && typeof item.text === 'string') {
            turns.push({ kind: 'user', text: item.text });
          } else if (item.role === 'assistant' && item.message) {
            turns.push({ kind: 'assistant', message: item.message });
          }
        }
        setState({
          turns,
          conversationId: payload.conversationId,
          inFlight: false,
          lastTransportError: null,
        });
        return true;
      } catch {
        return false;
      }
    },
    [pid, proxyUrl],
  );

  return { state, submit, reset, loadConversation };
}

function replacePlaceholder(
  turns: CopilotTurn[],
  requestId: string,
  next: CopilotTurn,
): CopilotTurn[] {
  // Replace the most recent placeholder turn (progress / thinking)
  // matching `requestId`. If none is found we append — that path only
  // triggers when a stream resumes after a placeholder was already
  // rolled into a real assistant bubble.
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (
      t !== undefined &&
      (t.kind === 'progress' || t.kind === 'thinking') &&
      t.requestId === requestId
    ) {
      const copy = turns.slice();
      copy[i] = next;
      return copy;
    }
  }
  return [...turns, next];
}

function reduce(
  state: CopilotState,
  event: CopilotStreamEvent,
  requestId: string,
): CopilotState {
  switch (event.type) {
    case 'meta': {
      // Adopt the agent-minted conversation id so follow-ups append to
      // the same row. A fresh `conversationId` from a follow-up turn
      // would only happen if the proxy minted a new row, which the
      // agent does not do for follow-ups — but being permissive here
      // means a recovered conversation hydrates correctly too.
      return { ...state, conversationId: event.conversationId };
    }
    case 'progress': {
      return {
        ...state,
        turns: state.turns.map((t) => {
          if (t.kind !== 'progress' || t.requestId !== requestId) return t;
          return {
            ...t,
            stages: t.stages.map((s) =>
              s.stage === event.stage ? { ...s, status: event.status } : s,
            ),
          };
        }),
      };
    }
    case 'supervisorNarration': {
      // Annotate the active in-flight placeholder with the narration so
      // the user sees the agent's intent rather than a dead spinner.
      // `synthesize` narrations are suppressed by the agent itself —
      // the resulting assistant message is its own end-of-turn signal.
      return {
        ...state,
        turns: state.turns.map((t) => {
          if (t.kind === 'progress' && t.requestId === requestId) {
            return { ...t, narration: event.text };
          }
          if (t.kind === 'thinking' && t.requestId === requestId) {
            return { ...t, narration: event.text };
          }
          return t;
        }),
      };
    }
    case 'assistantMessage': {
      return {
        ...state,
        turns: replacePlaceholder(state.turns, requestId, {
          kind: 'assistant',
          message: event.message,
        }),
      };
    }
    case 'error': {
      return {
        ...state,
        turns: replacePlaceholder(state.turns, requestId, {
          kind: 'error',
          code: event.code,
        }),
      };
    }
    case 'done':
    case 'pipelineEvent':
      // `done` is consumed by the outer fetch loop's `inFlight=false`
      // (set when the response body ends, which the agent does
      // immediately after `done`). pipelineEvent is not rendered here.
      return state;
  }
}

export type { AssistantMessage, SuggestedFollowUp };
