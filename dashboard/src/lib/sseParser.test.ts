import { describe, expect, it } from 'vitest';
import { SseParser } from './sseParser';

describe('SseParser', () => {
  it('parses a single complete frame', () => {
    const p = new SseParser();
    const frames = p.feed('event: meta\ndata: {"a":1}\n\n');
    expect(frames).toEqual([{ event: 'meta', data: '{"a":1}' }]);
  });

  it('parses multiple frames in one feed', () => {
    const p = new SseParser();
    const frames = p.feed(
      'event: meta\ndata: {"a":1}\n\n' + 'event: done\ndata: {"persistedAt":"x"}\n\n',
    );
    expect(frames).toEqual([
      { event: 'meta', data: '{"a":1}' },
      { event: 'done', data: '{"persistedAt":"x"}' },
    ]);
  });

  it('buffers a partial frame across feeds', () => {
    const p = new SseParser();
    const a = p.feed('event: meta\ndata: {"');
    expect(a).toEqual([]);
    const b = p.feed('a":1}\n\nevent: done\n');
    expect(b).toEqual([{ event: 'meta', data: '{"a":1}' }]);
    const c = p.feed('data: {}\n\n');
    expect(c).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('treats CRLF the same as LF', () => {
    const p = new SseParser();
    const frames = p.feed('event: meta\r\ndata: {"x":2}\r\n\r\n');
    expect(frames).toEqual([{ event: 'meta', data: '{"x":2}' }]);
  });

  it('strips a single leading space after `data:`', () => {
    const p = new SseParser();
    const frames = p.feed('event: x\ndata: {"a":1}\n\n');
    expect(frames[0]?.data).toBe('{"a":1}');
  });

  it('ignores SSE comment lines (keep-alive)', () => {
    const p = new SseParser();
    const frames = p.feed(': keep-alive\nevent: meta\ndata: {}\n\n');
    expect(frames).toEqual([{ event: 'meta', data: '{}' }]);
  });

  it('joins multiline data lines with a newline', () => {
    const p = new SseParser();
    const frames = p.feed('event: x\ndata: line1\ndata: line2\n\n');
    expect(frames).toEqual([{ event: 'x', data: 'line1\nline2' }]);
  });

  it('defaults event name to "message" when absent', () => {
    const p = new SseParser();
    const frames = p.feed('data: hi\n\n');
    expect(frames).toEqual([{ event: 'message', data: 'hi' }]);
  });
});
