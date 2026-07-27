/**
 * SSE parser unit tests (PR-C5).
 *
 * Pinned against the dual-channel shape emitted by
 * `backend/src/services/tunnel-router.ts:proxyStream`:
 *
 *   data: {"chunk":"hello","done":false}\n\n
 *   data: {"done":true}\n\n
 *   event: iteration\ndata: {"iteration":2}\n\n
 *   event: error\ndata: {"code":"quota_exceeded",...}\n\n
 *
 * Covers the pure parser — both the single-frame `parseSseFrame`
 * (deterministic, easy to assert on) and the byte-stream
 * `parseSseStream` (exercises the buffer-walk).
 */

import { describe, expect, it } from "vitest";
import { parseSseFrame, parseSseStream } from "../sse";

describe("parseSseFrame", () => {
  it("parses a default-channel chunk envelope", () => {
    const event = parseSseFrame(`data: {"chunk":"hello","done":false}`);
    expect(event).toEqual({ kind: "chunk", delta: "hello" });
  });

  it("parses the terminal done envelope", () => {
    const event = parseSseFrame(`data: {"done":true}`);
    expect(event).toEqual({ kind: "done" });
  });

  it("parses an iteration event with iteration number", () => {
    const event = parseSseFrame(`event: iteration\ndata: {"iteration":2}`);
    expect(event).toEqual({ kind: "iteration", iteration: 2 });
  });

  it("parses a quota_exceeded error event with reason", () => {
    const event = parseSseFrame(
      `event: error\ndata: ${JSON.stringify({
        code: "quota_exceeded",
        reason: "daily",
        message: "Daily limit reached",
      })}`,
    );
    expect(event).toEqual({
      kind: "error",
      code: "quota_exceeded",
      reason: "daily",
      message: "Daily limit reached",
    });
  });

  it("parses a generic runtime error event without code/reason", () => {
    const event = parseSseFrame(
      `event: error\ndata: ${JSON.stringify({ message: "Runtime crashed" })}`,
    );
    expect(event).toEqual({
      kind: "error",
      code: undefined,
      reason: undefined,
      message: "Runtime crashed",
    });
  });

  it("tolerates CRLF line endings (\\r\\n)", () => {
    const event = parseSseFrame(
      `event: iteration\r\ndata: {"iteration":3}\r\n`,
    );
    expect(event).toEqual({ kind: "iteration", iteration: 3 });
  });

  it("skips frames with only comments and no data", () => {
    const event = parseSseFrame(`: keepalive\n: another comment`);
    expect(event).toBeNull();
  });

  it("skips frames with no data line", () => {
    const event = parseSseFrame(`event: ping`);
    expect(event).toBeNull();
  });

  it("falls back to a generic error when payload is not JSON", () => {
    const event = parseSseFrame(`data: not-json`);
    expect(event).toEqual({ kind: "error", message: "not-json" });
  });

  it("flags a malformed iteration event", () => {
    const event = parseSseFrame(`event: iteration\ndata: {"iteration":"two"}`);
    expect(event).toEqual({ kind: "error", message: "Malformed iteration event" });
  });

  it("flags an unrecognized default-channel shape", () => {
    const event = parseSseFrame(`data: {"foo":"bar"}`);
    expect(event).toEqual({ kind: "error", message: "Unrecognized SSE payload" });
  });
});

describe("parseSseStream", () => {
  /** Helper to feed the parser an `AsyncIterable<Uint8Array>` from
   *  a plain string. */
  async function* chunksOf(input: string): AsyncGenerator<Uint8Array> {
    // Split mid-stream to exercise the buffer-walk (frames straddle
    // chunk boundaries). The chunks are arbitrary — chosen to make
    // sure the parser doesn't depend on alignment.
    const parts = [
      input.slice(0, 20),
      input.slice(20, 60),
      input.slice(60, 100),
      input.slice(100),
    ];
    for (const p of parts) {
      if (p.length > 0) yield new TextEncoder().encode(p);
    }
  }

  it("yields chunk + done in order", async () => {
    const events: Array<ReturnType<typeof parseSseFrame>> = [];
    const input = [
      `data: {"chunk":"hello","done":false}\n\n`,
      `data: {"chunk":" world","done":false}\n\n`,
      `data: {"done":true}\n\n`,
    ].join("");
    for await (const e of parseSseStream(chunksOf(input))) {
      events.push(e);
    }
    expect(events).toEqual([
      { kind: "chunk", delta: "hello" },
      { kind: "chunk", delta: " world" },
      { kind: "done" },
    ]);
  });

  it("emits iteration events alongside chunks", async () => {
    const events: Array<ReturnType<typeof parseSseFrame>> = [];
    const input = [
      `event: iteration\ndata: {"iteration":2}\n\n`,
      `data: {"chunk":"after iter 2","done":false}\n\n`,
      `data: {"done":true}\n\n`,
    ].join("");
    for await (const e of parseSseStream(chunksOf(input))) {
      events.push(e);
    }
    expect(events).toEqual([
      { kind: "iteration", iteration: 2 },
      { kind: "chunk", delta: "after iter 2" },
      { kind: "done" },
    ]);
  });

  it("flushes a trailing frame without a final blank line", async () => {
    const events: Array<ReturnType<typeof parseSseFrame>> = [];
    // Last frame has no trailing \n\n — parser should still flush.
    const input = `data: {"chunk":"hi","done":false}\n\ndata: {"done":true}`;
    for await (const e of parseSseStream(chunksOf(input))) {
      events.push(e);
    }
    expect(events).toEqual([
      { kind: "chunk", delta: "hi" },
      { kind: "done" },
    ]);
  });

  it("drops comment-only frames silently", async () => {
    const events: Array<ReturnType<typeof parseSseFrame>> = [];
    const input = [
      `: keepalive\n\n`,
      `data: {"done":true}\n\n`,
    ].join("");
    for await (const e of parseSseStream(chunksOf(input))) {
      events.push(e);
    }
    expect(events).toEqual([{ kind: "done" }]);
  });
});