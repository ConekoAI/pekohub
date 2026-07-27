/**
 * Chat composer (PR-C3).
 *
 * Plain textarea + Send button. Submit on Enter; Shift+Enter inserts
 * a newline. Disabled while `streaming` (no concurrent messages —
 * mirrors desktop behavior).
 */

import { useState } from "react";
import { Send } from "lucide-react";

interface PublicChatInputProps {
  onSend: (text: string) => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function PublicChatInput({
  onSend,
  streaming,
  disabled,
  placeholder,
}: PublicChatInputProps) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || streaming || disabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="flex items-end gap-2 border-t border-gray-200 bg-white p-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder={
          placeholder ??
          "Type a message — Enter to send, Shift+Enter for newline"
        }
        rows={1}
        disabled={disabled === true || streaming}
        className="input min-h-[44px] resize-none"
      />
      <button
        onClick={handleSubmit}
        disabled={disabled === true || streaming || text.trim().length === 0}
        className="btn-primary h-11 w-11 flex-shrink-0"
        aria-label="Send"
      >
        <Send className="h-4 w-4" />
      </button>
    </div>
  );
}