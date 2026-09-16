/**
 * Public peko profile header.
 *
 * Renders the peko's public face: display name, owner, status and the
 * capabilities the runtime chose to advertise. No runtime metadata
 * leaks — the public endpoint returns only what `/peko/:owner/:name`
 * needs to render.
 */

import { Cpu, Share2 } from 'lucide-react';
import type { PublicProfile } from '@pekohub/shared';
import { Avatar, Badge, CopyButton, StatusPill } from '~/components/ui';

interface ProfileHeaderProps {
  profile: PublicProfile;
  shareUrl?: string;
}

export function ProfileHeader({ profile, shareUrl }: ProfileHeaderProps) {
  const { liveInstance } = profile;

  return (
    <section className="panel overflow-hidden">
      <div className="bg-brand-fade px-6 pb-6 pt-7">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl border border-peko-400/25 bg-ink-900/80">
            <BotGlyph />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="display truncate text-2xl">{liveInstance.publicName}</h1>
              <StatusPill status={liveInstance.status} />
            </div>

            <div className="mt-2.5 flex items-center gap-2">
              <Avatar
                name={liveInstance.owner.name}
                src={liveInstance.owner.avatarUrl}
                size="xs"
              />
              <span className="text-[13px] text-slate-400">
                hosted by{' '}
                <span className="font-medium text-slate-300">{liveInstance.owner.name}</span>
              </span>
            </div>
          </div>

          {shareUrl && (
            <CopyButton value={shareUrl} label="Share" className="btn-secondary btn-sm flex-shrink-0" />
          )}
        </div>

        {liveInstance.description && (
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-slate-300">
            {liveInstance.description}
          </p>
        )}

        {liveInstance.capabilities.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-1">capabilities</span>
            {liveInstance.capabilities.map((capability: string) => (
              <span
                key={capability}
                className="rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-2xs text-slate-400"
              >
                {capability}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.06] px-6 py-3">
        <span className="flex items-center gap-1.5 font-mono text-2xs text-slate-600">
          <Cpu className="h-3 w-3" />
          runtime-hosted
        </span>
        <span className="flex items-center gap-1.5 font-mono text-2xs text-slate-600">
          <Share2 className="h-3 w-3" />
          messages relayed, never stored by the hub
        </span>
        {liveInstance.tosRequired && (
          <Badge tone="warn">terms required</Badge>
        )}
      </div>
    </section>
  );
}

/** Node mark — same motif as the logo, in brand gradient. */
function BotGlyph() {
  return (
    <svg viewBox="0 0 32 32" className="h-7 w-7">
      <defs>
        <linearGradient id="profile-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="0.5" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <circle
        cx="16"
        cy="16"
        r="12"
        fill="none"
        stroke="url(#profile-mark)"
        strokeOpacity="0.35"
        strokeWidth="1.5"
        strokeDasharray="2 3"
      />
      <circle cx="16" cy="16" r="5.5" fill="url(#profile-mark)" />
    </svg>
  );
}
