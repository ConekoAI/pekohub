/**
 * Public-chat SSE consumer hook (PR-C2).
 *
 * Drives a single round-trip conversation with a public principal:
 * `sendMessage(text)` opens a `fetch` + SSE stream, ingests the
 * dual-channel events, and folds chunks into assistant bubbles
 * broken at iteration boundaries.
 *
 * Mirrors `peko-desktop/src/pages/Chat.tsx`'s reducer shape so the
 * SPA bubble UI matches desktop UX:
 *
 *   - `chunk` events extend the current assistant bubble.
 *   - `iteration` events start a NEW bubble (mirrors the desktop's
 *     per-iteration break; see `mergeAssistantChunks`).
 *   - `done` ends the stream; subsequent chunks would start a new
 *     bubble.
 *   - `error` writes an inline error card with the backend-provided
 *     message and a `code` field (e.g. `quota_exceeded`).
 *
 * The hook owns:
 *   - `messages: ChatMessage[]` — user + assistant + error turns.
 *   - `streaming: boolean` — true while a fetch is open.
 *   - `awaitingToken: boolean` — true after an `iteration` event
 *     until the next chunk arrives; drives a "Thinking…" pill.
 *   - `error: string | null` — fatal failure (network down, 5xx).
 *
 * Cancellation: `abort()` closes the underlying fetch. Subsequent
 * `sendMessage` calls open a fresh stream.
 */

import { useCallback, useRef, useState } from "react";
import { api } from "~/lib/api";
import { parseSseStream, readerToIterable, type StreamEvent } from "~/lib/sse";

export interface ChatMessage {
  /** Discriminator: "user" for human turns, "assistant" for the
   *  principal, "error" for inline quota / runtime errors. */
  kind: "user" | "assistant" | "error";
  /** Bubble text. For assistant bubbles, content accumulates across
   *  chunks within the same iteration; for user / error it's a
   *  single string. */
  text: string;
  /** Per-bubble iteration stamp (assistant only). 1-based; matches
   *  the runtime's `IterationBoundary` event (PR-A). Bubbles without
   *  an iteration either predate the boundary marker (legacy
   *  transcripts) or are not from a stream — collapse them into the
   *  previous bubble in the reducer. */
  iteration?: number;
  /** Error code, if any (PR-B3 quota: "quota_exceeded"; runtime
   *  errors leave this undefined). */
  code?: string;
  /** Optional reason: "daily" | "weekly" (PR-B3 quota). Raw string
   *  pass-through — backend can add new buckets without a frontend
   *  redeploy; the UI uses it for the tooltip text only. */
  reason?: string;
}

interface UsePublicChatArgs {
  owner: string;
  principalName: string;
  /** Optional ToS-acknowledged flag. PR-C4: TermsGate persists
   *  acknowledgments to localStorage and re-sends them on every
   *  message so the server's 428 path doesn't trip on a returning
   *  user. */
  tosAcknowledged?: boolean;
}

interface UsePublicChatReturn {
  messages: ChatMessage[];
  streaming: boolean;
  awaitingToken: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  abort: () => void;
  clear: () => void;
}

export function usePublicChat({
  owner,
  principalName,
  tosAcknowledged,
}: UsePublicChatArgs): UsePublicChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [awaitingToken, setAwaitingToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track the current fetch so `abort()` can cancel mid-stream.
  const abortRef = useRef<AbortController | null>(null);
  // Live iteration stamp (1-based; runtime emits the first
  // `IterationBoundary` at the start of iteration 1). Lives in a ref
  // so the SSE loop body can mutate it without forcing a re-render.
  const currentIterationRef = useRef<number | undefined>(undefined);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setAwaitingToken(false);
  }, []);

  const clear = useCallback(() => {
    abort();
    setMessages([]);
    setError(null);
    currentIterationRef.current = undefined;
  }, [abort]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || streaming) return;

      // Optimistic append — the user bubble shows immediately.
      setMessages((prev) => [...prev, { kind: "user", text: trimmed }]);
      setStreaming(true);
      setAwaitingToken(false);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      // Each new message starts a fresh iteration stamp. The runtime
      // emits `IterationBoundary { iteration: 1 }` at the very start
      // of the first iteration; if that marker arrives before any
      // chunk, `foldEvent` will overwrite this default.
      currentIterationRef.current = 1;

      let response: Response;
      try {
        response = await api.publicChat(owner, principalName, {
          message: trimmed,
          tos_acknowledged: tosAcknowledged,
        });
      } catch (err) {
        // Network error or pre-flight rejection.
        setError(err instanceof Error ? err.message : "Network error");
        setStreaming(false);
        return;
      }

      if (!response.ok || response.body === null) {
        // 4xx/5xx pre-stream. Try to read a JSON body with `{error}`.
        let detail = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { error?: string };
          if (typeof body.error === "string") detail = body.error;
        } catch {
          // ignore parse errors
        }
        setError(detail);
        setStreaming(false);
        return;
      }

      // Walk the SSE stream. Each event folds into the message list.
      try {
        const reader = response.body.getReader();
        for await (const event of parseSseStream(readerToIterable(reader))) {
          if (controller.signal.aborted) break;
          foldEvent(event);
        }
      } catch (err) {
        // Stream parse error or fetch abort.
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Stream failed");
        }
      } finally {
        setStreaming(false);
        setAwaitingToken(false);
        if (abortRef.current === controller) abortRef.current = null;
      }

      function foldEvent(event: StreamEvent) {
        switch (event.kind) {
          case "chunk": {
            setAwaitingToken(false);
            setMessages((prev) => {
              const next = prev.slice();
              const last = next[next.length - 1];
              // Extend the trailing assistant bubble. If the trailing
              // bubble isn't an assistant bubble (e.g. an error card),
              // start a new one.
              if (
                last !== undefined &&
                last.kind === "assistant" &&
                last.iteration === currentIterationRef.current
              ) {
                next[next.length - 1] = {
                  ...last,
                  text: last.text + event.delta,
                };
              } else {
                next.push({
                  kind: "assistant",
                  text: event.delta,
                  iteration: currentIterationRef.current,
                });
              }
              return next;
            });
            return;
          }
          case "iteration": {
            // Bump the iteration stamp so the next chunk starts a
            // NEW assistant bubble. Flipping awaitingToken drives
            // the "Thinking…" pill.
            currentIterationRef.current = event.iteration;
            setAwaitingToken(true);
            return;
          }
          case "done": {
            setStreaming(false);
            setAwaitingToken(false);
            return;
          }
          case "error": {
            setMessages((prev) => [
              ...prev,
              {
                kind: "error",
                text: event.message,
                code: event.code,
                reason: event.reason,
              },
            ]);
            setStreaming(false);
            setAwaitingToken(false);
            return;
          }
        }
      }
    },
    [owner, principalName, tosAcknowledged, streaming],
  );

  return { messages, streaming, awaitingToken, error, sendMessage, abort, clear };
}