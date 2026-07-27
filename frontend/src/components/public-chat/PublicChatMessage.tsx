/**
 * Single chat bubble (PR-C3).
 *
 * Mirrors `peko-desktop/src/pages/Chat.tsx`'s `MessageBubble` shape
 * — user / assistant / error variants. Assistant bubbles render
 * markdown via `react-markdown` + `remark-gfm` (no `rehype-sanitize`
 * because the runtime's chunk payloads are server-trusted, but the
 * runtime itself runs the principal's tools and may emit arbitrary
 * markdown; the SPA trust boundary ends at the runtime, which is
 * already a trusted origin).
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Loader2, User as UserIcon, Bot } from "lucide-react";
import type { ChatMessage as ChatMessageT } from "~/hooks/usePublicChat";

interface PublicChatMessageProps {
  message: ChatMessageT;
  ownerName: string;
  principalName: string;
}

export function PublicChatMessage({
  message,
  ownerName,
  principalName,
}: PublicChatMessageProps) {
  if (message.kind === "user") {
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-peko-50 px-4 py-2.5 text-sm text-gray-900">
          {message.text}
        </div>
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-100">
          <UserIcon className="h-4 w-4 text-gray-500" />
        </div>
      </div>
    );
  }

  if (message.kind === "error") {
    // Quota errors get a dedicated card; everything else renders as
    // a generic error pill.
    if (message.code === "quota_exceeded") {
      return (
        <div className="mx-auto max-w-md rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-medium text-amber-900">
                {message.reason === "daily"
                  ? "Daily message limit reached"
                  : message.reason === "weekly"
                    ? "Weekly message limit reached"
                    : "Message limit reached"}
              </p>
              <p className="mt-1 text-sm text-amber-800">
                {message.text}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex gap-2">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-100">
          <AlertCircle className="h-4 w-4 text-red-600" />
        </div>
        <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-900">
          {message.text}
        </div>
      </div>
    );
  }

  // Assistant bubble
  return (
    <div className="flex gap-2">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-peko-100">
        <Bot className="h-4 w-4 text-peko-700" />
      </div>
      <div className="max-w-[80%]">
        <div className="mb-1 text-xs text-gray-500">
          {ownerName}/{principalName}
          {message.iteration !== undefined && (
            <span className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
              iter {message.iteration}
            </span>
          )}
        </div>
        <div className="markdown-body rounded-2xl rounded-tl-sm bg-gray-50 px-4 py-2.5 text-sm text-gray-900">
          {message.text.length === 0 ? (
            <Loader2 className="h-4 w-4 animate-spin text-peko-600" />
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.text}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}