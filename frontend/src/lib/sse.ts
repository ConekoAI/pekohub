/**
 * SSE line parser for the public-chat endpoint (PR-C2).
 *
 * The backend emits two parallel channels on the same stream:
 *
 *   1. Default `data:` channel — chunk envelopes `{chunk, done}`
 *      and the terminal `done: true` frame.
 *   2. Named `event:` channels — `iteration` carrying
 *      `{iteration: number}` (PR-B2 boundary marker) and `error`
 *      carrying `{code, reason, message}` for quota failures
 *      (PR-B3) or generic runtime errors.
 *
 * The browser's `EventSource` API splits `event:` lines into typed
 * listeners but the data payload format is opaque. Here we parse
 * with `fetch` + a `ReadableStream` reader because we need POST
 * with a body — `EventSource` only does GET.
 *
 * Wire shape (verbatim from
 * `backend/src/services/tunnel-router.ts:proxyStream`):
 *
 *   data: {"chunk":"hello","done":false}\n\n
 *   data: {"done":true}\n\n
 *   event: iteration\ndata: {"iteration":2}\n\n
 *   event: error\ndata: {"code":"quota_exceeded","reason":"daily","message":"..."}\n\n
 *
 * The parser is a pure function over an async iterator of raw lines,
 * so it's unit-testable without DOM/fetch.
 */

export type StreamEvent =
  | { kind: "chunk"; delta: string }
  | { kind: "iteration"; iteration: number }
  | { kind: "done" }
  | { kind: "error"; code?: string; reason?: string; message: string };

/**
 * Parse a single SSE frame (one or more lines separated by `\n`,
 * terminated by a blank line). Returns null if the frame contains
 * only comments (lines starting with `:`) or no `data:` payload —
 * the caller should discard those without emitting an event.
 */
export function parseSseFrame(frame: string): StreamEvent | null {
  let eventName: string | null = null;
  let dataLines: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }

  const payload = dataLines.join("\n");
  if (payload === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Non-JSON payload. Surface as a generic error event so the SPA
    // can render a fallback rather than silently dropping frames.
    return { kind: "error", message: payload };
  }

  if (eventName === "iteration") {
    const obj = parsed as { iteration?: unknown };
    if (typeof obj.iteration !== "number" || !Number.isFinite(obj.iteration)) {
      return { kind: "error", message: "Malformed iteration event" };
    }
    return { kind: "iteration", iteration: obj.iteration };
  }

  if (eventName === "error") {
    const obj = parsed as { code?: unknown; reason?: unknown; message?: unknown };
    return {
      kind: "error",
      code: typeof obj.code === "string" ? obj.code : undefined,
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
      message:
        typeof obj.message === "string"
          ? obj.message
          : "Unknown error from runtime",
    };
  }

  // Default channel — `data:` only, no `event:` name. Match the
  // chunk envelope OR the bare `done` envelope.
  const obj = parsed as { chunk?: unknown; done?: unknown };
  if (obj.done === true) return { kind: "done" };
  if (typeof obj.chunk === "string") return { kind: "chunk", delta: obj.chunk };
  // Unknown shape on default channel — surface as error.
  return { kind: "error", message: "Unrecognized SSE payload" };
}

/**
 * Wrap a `ReadableStreamDefaultReader` into an `AsyncIterable<Uint8Array>`.
 * `ReadableStreamDefaultReader` does not implement `[Symbol.asyncIterator]`
 * in TypeScript's `lib.dom.d.ts`, so we expose a tiny adapter here.
 * (Some upstreams do implement it; pinning the adapter keeps the
 * generator input contract tight regardless of TS lib version.)
 */
export async function* readerToIterable(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    yield value;
  }
}

/**
 * Parse an SSE byte stream into a sequence of `StreamEvent`s.
 * Splits the stream on blank-line frame boundaries. Use with any
 * `AsyncIterable<Uint8Array>` (e.g. a `ReadableStreamDefaultReader`
 * obtained via `response.body.getReader()`).
 */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array>,
  decoder: TextDecoder = new TextDecoder(),
): AsyncGenerator<StreamEvent> {
  let buffer = "";
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    // SSE frames end on `\n\n` (or `\r\n\r\n`). Walk the buffer and
    // emit any complete frames, leaving the tail for the next chunk.
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSseFrame(frame);
      if (event !== null) yield event;
    }
  }
  // Flush any trailing frame without a final blank line.
  if (buffer.trim() !== "") {
    const event = parseSseFrame(buffer);
    if (event !== null) yield event;
  }
}