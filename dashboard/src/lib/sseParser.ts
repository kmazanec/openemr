// Minimal SSE-frame parser tailored for the agent's
// `event: <type>\ndata: <json>\n\n` framing. We can't use the browser's
// EventSource API because the agent's briefing endpoint is a POST (the
// envelope rides in the body); EventSource only supports GET. So we
// open a fetch streaming response and feed its chunks through this
// parser.
//
// The parser is written as a stateful class so a partial frame
// straddling a network chunk boundary stays buffered until the next
// chunk completes it. Tests feed it chunk by chunk to exercise that
// boundary explicitly.

export interface ParsedSseFrame {
  // The `event:` line value, or 'message' when the frame omitted one.
  // The agent always sets the line, so we expect the explicit type.
  event: string;
  data: string;
}

export class SseParser {
  // Carries the partial line at the end of the most recent chunk
  // (everything after the final newline). Drained on the next chunk.
  private buffer = '';
  // Frame-in-progress fields we accumulate across `event:` and `data:`
  // lines until a blank line terminates the frame.
  private currentEvent: string | null = null;
  private currentData: string[] = [];

  /**
   * Feed a network chunk in and pull complete frames out. Returns
   * frames in arrival order; the trailing partial frame (if any) is
   * retained for the next call.
   */
  feed(chunk: string): ParsedSseFrame[] {
    this.buffer += chunk;
    const frames: ParsedSseFrame[] = [];
    let nlIdx = this.buffer.indexOf('\n');
    while (nlIdx !== -1) {
      const rawLine = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      // Strip the optional CR for CRLF clients/proxies.
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        // Frame terminator. Emit if we accumulated anything.
        if (this.currentEvent !== null || this.currentData.length > 0) {
          frames.push({
            event: this.currentEvent ?? 'message',
            data: this.currentData.join('\n'),
          });
        }
        this.currentEvent = null;
        this.currentData = [];
      } else if (line.startsWith(':')) {
        // SSE comment — keep-alive heartbeat; ignore.
      } else if (line.startsWith('event:')) {
        this.currentEvent = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        // SSE spec strips a single leading space after `data:`. The
        // agent emits exactly `data: <json>` so we follow that.
        const v = line.slice('data:'.length);
        this.currentData.push(v.startsWith(' ') ? v.slice(1) : v);
      }
      // All other field names (id:, retry:) are unused by the agent
      // and intentionally dropped on the floor.
      nlIdx = this.buffer.indexOf('\n');
    }
    return frames;
  }
}
