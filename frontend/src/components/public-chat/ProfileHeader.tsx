/**
 * Profile header card (PR-C3).
 *
 * Renders the principal's display name + owner avatar + description +
 * status pill. Mirrors the desktop profile-modal style (rounded-xl
 * card, peko-50 owner-avatar tint).
 */

import { Bot, Wifi, WifiOff, Clock, AlertTriangle } from "lucide-react";
import type { PublicProfile } from "@pekohub/shared";

interface ProfileHeaderProps {
  profile: PublicProfile;
}

export function ProfileHeader({ profile }: ProfileHeaderProps) {
  const { instance } = profile;
  const status = instance.status;
  const ownerAvatar = instance.owner.avatarUrl;
  const ownerInitial = instance.owner.name[0]?.toUpperCase() ?? "?";

  return (
    <div className="card p-5">
      <div className="flex items-start gap-4">
        <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-peko-100">
          <Bot className="h-7 w-7 text-peko-700" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-bold text-gray-900">
              {instance.publicName}
            </h1>
            <StatusPill status={status} />
          </div>
          <div className="mt-1 flex items-center gap-2">
            {ownerAvatar !== null && ownerAvatar !== undefined ? (
              <img
                src={ownerAvatar}
                alt={instance.owner.name}
                className="h-5 w-5 rounded-full object-cover"
              />
            ) : (
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 text-[10px] font-semibold text-gray-700">
                {ownerInitial}
              </span>
            )}
            <span className="text-sm text-gray-500">
              by {instance.owner.name}
            </span>
          </div>
          {instance.description !== null && instance.description !== undefined && (
            <p className="mt-3 text-sm leading-relaxed text-gray-700">
              {instance.description}
            </p>
          )}
          {instance.capabilities.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {instance.capabilities.map((cap: string) => (
                <span
                  key={cap}
                  className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                >
                  {cap}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: PublicProfile["instance"]["status"] }) {
  const map = {
    online: { icon: Wifi, label: "online", cls: "bg-emerald-50 text-emerald-700" },
    busy: { icon: Clock, label: "busy", cls: "bg-amber-50 text-amber-700" },
    error: { icon: AlertTriangle, label: "error", cls: "bg-red-50 text-red-700" },
    offline: { icon: WifiOff, label: "offline", cls: "bg-gray-100 text-gray-500" },
  } as const;
  const entry = (map as Record<typeof status, { icon: typeof Wifi; label: string; cls: string }>)[status];
  const Icon = entry.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${entry.cls}`}
    >
      <Icon className="h-3 w-3" />
      {entry.label}
    </span>
  );
}