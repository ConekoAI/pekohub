/**
 * Public peko profile header: display name, ID, owner, status and the
 * capabilities the runtime chose to advertise. No runtime metadata
 * leaks — the public endpoint returns only what `/@owner/name` needs
 * to render.
 */

import type { PublicProfile } from '@pekohub/shared';
import { Avatar, CopyButton, StatusPill, Tile } from '~/components/ui';

interface ProfileHeaderProps {
  profile: PublicProfile;
  /** The peko's ID, `@alice/ada`. */
  id?: string;
  shareUrl?: string;
}

export function ProfileHeader({ profile, id, shareUrl }: ProfileHeaderProps) {
  const { liveInstance } = profile;

  return (
    <section>
      <div className="flex flex-wrap items-start gap-5">
        <Tile avatar={liveInstance.avatar} name={liveInstance.publicName} size="lg" />
        <div className="min-w-[13rem] flex-1">
          <h1 className="h-page truncate">{liveInstance.publicName}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
            {id && <span>{id}</span>}
            {id && <span aria-hidden>·</span>}
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <Avatar name={liveInstance.owner.name} src={liveInstance.owner.avatarUrl} size="xs" />
              {liveInstance.owner.name}
            </span>
            <span aria-hidden>·</span>
            <StatusPill status={liveInstance.status} />
          </p>
        </div>
        {shareUrl && <CopyButton value={shareUrl} label="Share" className="btn-ghost btn-sm flex-shrink-0" />}
      </div>

      {liveInstance.description && (
        <p className="mt-6 text-[15px] leading-relaxed text-slate-300">{liveInstance.description}</p>
      )}

      {liveInstance.capabilities.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-1.5">
          {liveInstance.capabilities.map((capability: string) => (
            <span key={capability} className="badge-neutral">
              {capability}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
