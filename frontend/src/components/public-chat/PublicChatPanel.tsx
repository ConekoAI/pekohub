/**
 * Public chat surface.
 *
 * Composes the message list, the composer and the ToS gate, and owns
 * the SSE consumer via `usePublicChat`. The "Thinking…" pill between
 * iterations matches the desktop client's `awaitingToken` affordance.
 *
 * The hub relays every frame; nothing here is persisted on the hub
 * side — the runtime writes the transcript.
 */

import { useEffect, useRef, useState } from 'react';
import type { PublicProfile } from '@pekohub/shared';
import { usePublicChat } from '~/hooks/usePublicChat';
import { PublicChatMessage } from './PublicChatMessage';
import { PublicChatInput } from './PublicChatInput';
import { TermsGate, hasAcknowledged } from './TermsGate';
import { Spinner, StatusDot } from '~/components/ui';

interface PublicChatPanelProps {
  profile: PublicProfile;
}

export function PublicChatPanel({ profile }: PublicChatPanelProps) {
  const { liveInstance } = profile;
  const ownerName = liveInstance.owner.name;

  const [tosAcknowledged, setTosAcknowledged] = useState<boolean>(() =>
    liveInstance.tosRequired
      ? hasAcknowledged(liveInstance.owner.id, liveInstance.publicName)
      : true,
  );

  const { messages, streaming, awaitingToken, error, sendMessage, abort } = usePublicChat({
    owner: ownerName,
    pekoName: liveInstance.publicName,
    tosAcknowledged: tosAcknowledged || undefined,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, awaitingToken]);

  const offline = liveInstance.status === 'offline';
  const requiresTos =
    liveInstance.tosRequired &&
    liveInstance.tosText !== null &&
    liveInstance.tosText !== undefined &&
    !tosAcknowledged;

  return (
    <section className="card flex flex-col overflow-hidden">
      {/* Frame header */}
      <header className="flex items-center gap-2.5 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
        <StatusDot status={liveInstance.status} />
        <span className="font-mono text-2xs text-slate-500">
          {ownerName}/{liveInstance.publicName}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {streaming && (
            <span className="flex items-center gap-1.5 font-mono text-2xs text-peko-300">
              <Spinner className="h-3 w-3" />
              streaming
            </span>
          )}
          {streaming && (
            <button
              onClick={abort}
              className="font-mono text-2xs text-slate-500 transition-colors hover:text-rose-300"
            >
              stop
            </button>
          )}
        </span>
      </header>

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="flex min-h-[24rem] max-h-[60vh] flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-5"
      >
        {messages.length === 0 && !streaming && (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.03]">
              <span className="h-2.5 w-2.5 rounded-full bg-brand-gradient" />
            </div>
            <p className="mt-4 text-sm text-slate-400">
              Say hello to {liveInstance.publicName}.
            </p>
            <p className="mt-1.5 max-w-xs text-2xs leading-relaxed text-slate-600">
              Messages travel through the PekoHub relay to the runtime hosting this peko. The hub
              does not keep a copy.
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <PublicChatMessage
            key={index}
            message={message}
            ownerName={ownerName}
            pekoName={liveInstance.publicName}
          />
        ))}

        {awaitingToken && (
          <div className="flex items-center gap-2 pl-1">
            <span className="flex gap-1">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-peko-400/70"
                  style={{ animationDelay: `${dot * 150}ms` }}
                />
              ))}
            </span>
            <span className="font-mono text-2xs text-slate-500">thinking…</span>
          </div>
        )}
      </div>

      {/* Fatal error banner (network / pre-stream 4xx-5xx) */}
      {error !== null && (
        <div className="border-t border-rose-400/25 bg-rose-500/[0.07] px-4 py-2.5 text-[13px] text-rose-200">
          {error}
        </div>
      )}

      {/* Gate or composer */}
      {requiresTos && liveInstance.tosText !== null && liveInstance.tosText !== undefined ? (
        <div className="border-t border-white/[0.06] bg-white/[0.02] p-4">
          <TermsGate
            owner={liveInstance.owner.id}
            pekoName={liveInstance.publicName}
            tosText={liveInstance.tosText}
            onAccept={() => setTosAcknowledged(true)}
          />
        </div>
      ) : offline ? (
        <div className="border-t border-white/[0.06] bg-white/[0.02] px-4 py-4 text-center text-[13px] text-slate-500">
          This peko is offline right now. Try again when its runtime is back.
        </div>
      ) : (
        <PublicChatInput
          onSend={sendMessage}
          streaming={streaming}
          placeholder={`Message ${liveInstance.publicName}…`}
        />
      )}
    </section>
  );
}
