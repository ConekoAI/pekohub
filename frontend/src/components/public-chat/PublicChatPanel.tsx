/**
 * PublicChatPanel — chat surface for the share-link page (PR-C3).
 *
 * Composes the bubble list + composer + ToS gate. Owns the
 * `usePublicChat` hook so the route component stays declarative.
 * The "Thinking…" pill between iterations matches the desktop UX
 * (see `peko-desktop/src/pages/Chat.tsx` for the source pattern).
 */

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { PublicProfile } from "@pekohub/shared";
import { usePublicChat } from "~/hooks/usePublicChat";
import { PublicChatMessage } from "./PublicChatMessage";
import { PublicChatInput } from "./PublicChatInput";
import { TermsGate, hasAcknowledged } from "./TermsGate";
import { useState } from "react";

interface PublicChatPanelProps {
  profile: PublicProfile;
}

export function PublicChatPanel({ profile }: PublicChatPanelProps) {
  const { liveInstance } = profile;
  const ownerName = liveInstance.owner.name;
  const [tosAcknowledged, setTosAcknowledged] = useState<boolean>(() =>
    liveInstance.tosRequired ? hasAcknowledged(liveInstance.owner.id, liveInstance.publicName) : true,
  );

  const {
    messages,
    streaming,
    awaitingToken,
    error,
    sendMessage,
  } = usePublicChat({
    owner: liveInstance.owner.name,
    pekoName: liveInstance.publicName,
    tosAcknowledged: tosAcknowledged || undefined,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, awaitingToken]);

  const offline = liveInstance.status === "offline";
  const requiresTos =
    liveInstance.tosRequired &&
    liveInstance.tosText !== null &&
    liveInstance.tosText !== undefined &&
    !tosAcknowledged;

  return (
    <div className="card flex flex-col overflow-hidden">
      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-4"
      >
        {messages.length === 0 && !streaming && (
          <div className="mx-auto my-8 max-w-sm text-center text-sm text-gray-500">
            Say hello to {liveInstance.publicName}.
          </div>
        )}
        {messages.map((m, i) => (
          <PublicChatMessage
            key={i}
            message={m}
            ownerName={ownerName}
            pekoName={liveInstance.publicName}
          />
        ))}
        {/* Thinking pill — surfaced between iterations. Mirrors
            desktop's awaitingToken pattern. */}
        {awaitingToken && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Loader2 className="h-3 w-3 animate-spin text-peko-600" />
            <span>Thinking…</span>
          </div>
        )}
      </div>

      {/* Error banner (network / pre-stream 4xx-5xx) */}
      {error !== null && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900">
          {error}
        </div>
      )}

      {/* ToS gate or composer */}
      {requiresTos && liveInstance.tosText !== null && liveInstance.tosText !== undefined ? (
        <div className="border-t border-gray-200 bg-gray-50 p-4">
          <TermsGate
            owner={liveInstance.owner.name}
            pekoName={liveInstance.publicName}
            tosText={liveInstance.tosText}
            onAccept={() => setTosAcknowledged(true)}
          />
        </div>
      ) : offline ? (
        <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 text-center text-sm text-gray-500">
          This peko is offline. Try again later.
        </div>
      ) : (
        <PublicChatInput
          onSend={sendMessage}
          streaming={streaming}
          placeholder={`Message ${liveInstance.publicName}…`}
        />
      )}
    </div>
  );
}