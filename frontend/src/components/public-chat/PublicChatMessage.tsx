/**
 * Single chat bubble.
 *
 * Assistant bubbles render markdown (`react-markdown` + `remark-gfm`).
 * The trust boundary ends at the runtime: chunk payloads come from the
 * peko's own run, so they are treated as trusted content in the same
 * way the desktop client treats them.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, TriangleAlert } from 'lucide-react';
import type { ChatMessage as ChatMessageT } from '~/hooks/usePublicChat';
import { Spinner } from '~/components/ui';

interface PublicChatMessageProps {
  message: ChatMessageT;
  ownerName: string;
  pekoName: string;
}

export function PublicChatMessage({ message, ownerName, pekoName }: PublicChatMessageProps) {
  if (message.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-peko-400/20 bg-peko-400/[0.09] px-4 py-2.5 text-sm leading-relaxed text-peko-50">
          {message.text}
        </div>
      </div>
    );
  }

  if (message.kind === 'error') {
    if (message.code === 'quota_exceeded') {
      return (
        <div className="mx-auto w-full max-w-md rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-4">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-200">
                {message.reason === 'daily'
                  ? 'Daily message limit reached'
                  : message.reason === 'weekly'
                    ? 'Weekly message limit reached'
                    : 'Message limit reached'}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-amber-200/70">{message.text}</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto w-full max-w-md rounded-xl border border-rose-400/25 bg-rose-500/[0.07] p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-400" />
          <p className="text-[13px] leading-relaxed text-rose-200">{message.text}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-brand-gradient" aria-hidden />
        <span className="font-mono text-2xs text-slate-500">
          {ownerName}/{pekoName}
        </span>
        {message.iteration !== undefined && (
          <span className="rounded border border-white/[0.07] bg-white/[0.03] px-1 py-px font-mono text-[10px] text-slate-600">
            iter {message.iteration}
          </span>
        )}
      </div>
      <div className="max-w-[90%] rounded-2xl rounded-tl-md border border-white/[0.07] bg-white/[0.03] px-4 py-3">
        {message.text.length === 0 ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
