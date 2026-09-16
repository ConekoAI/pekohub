/**
 * Chat composer.
 *
 * Auto-growing textarea: Enter sends, Shift+Enter inserts a newline.
 * Disabled while a stream is open (one message at a time, matching the
 * desktop client).
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CornerDownLeft } from 'lucide-react';
import { Kbd } from '~/components/ui';

interface PublicChatInputProps {
  onSend: (text: string) => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
}

const MAX_HEIGHT = 160;

export function PublicChatInput({
  onSend,
  streaming,
  disabled,
  placeholder,
}: PublicChatInputProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with content, up to MAX_HEIGHT, then scroll internally.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const blocked = disabled === true || streaming;

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || blocked) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="border-t border-white/[0.06] bg-white/[0.02] p-3.5">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={placeholder ?? 'Type a message…'}
          rows={1}
          disabled={blocked}
          className="textarea min-h-[2.75rem] py-2.5"
        />
        <button
          onClick={handleSubmit}
          disabled={blocked || text.trim().length === 0}
          className="btn-primary h-11 w-11 flex-shrink-0 rounded-lg p-0"
          aria-label="Send message"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>

      <p className="mt-2 flex items-center gap-1.5 font-mono text-2xs text-slate-600">
        <Kbd>
          <CornerDownLeft className="h-2.5 w-2.5" />
        </Kbd>
        <span>to send</span>
        <span className="text-slate-700">·</span>
        <Kbd>⇧</Kbd>
        <Kbd>
          <CornerDownLeft className="h-2.5 w-2.5" />
        </Kbd>
        <span>for a newline</span>
      </p>
    </div>
  );
}
