import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api, type HubNotification, type NotificationList } from '~/lib/api';
import { relativeTime } from '~/lib/format';

/** How often the bell checks for news while a page is open. */
const POLL_MS = 60_000;

/**
 * The signed-in account's notifications: offers to take a peko, sign-ins,
 * moderators' actions. Opening the list marks what it shows as read; the
 * newly read stay highlighted until it closes.
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.listNotifications(),
    refetchInterval: POLL_MS,
  });
  const unread = list.data?.unread ?? 0;
  const items = list.data?.notifications ?? [];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const unreadIds = items.filter((item) => !item.readAt).map((item) => item.id);
    setFresh(new Set(unreadIds));
    if (unreadIds.length === 0) return;
    const now = new Date().toISOString();
    queryClient.setQueryData<NotificationList>(['notifications'], (data) =>
      data && {
        unread: Math.max(0, data.unread - unreadIds.length),
        notifications: data.notifications.map((item) =>
          unreadIds.includes(item.id) ? { ...item, readAt: now } : item,
        ),
      },
    );
    void api.markNotificationsRead(unreadIds).catch(() => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });
  };

  const openItem = (item: HubNotification) => {
    setOpen(false);
    if (item.path) void navigate({ to: item.path });
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        className="btn-icon relative"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-peko-600 px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2.5rem)] animate-scale-in overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-lifted"
        >
          <p className="border-b border-ink-700 px-3.5 py-2.5 text-sm font-medium text-slate-100">Notifications</p>
          {items.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-slate-500">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto p-1.5">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    role="menuitem"
                    onClick={() => openItem(item)}
                    className={`w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05] ${
                      fresh.has(item.id) ? 'bg-white/[0.04]' : ''
                    }`}
                  >
                    <p className="text-sm text-slate-200">{item.text}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{relativeTime(item.createdAt)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
