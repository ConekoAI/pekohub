import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { LayoutDashboard, Radar, User as UserIcon, LockKeyhole, Boxes } from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';
import { Backdrop, Spinner } from '~/components/ui';
import { SignInModal } from '~/components/SignInModal';

/**
 * Auth-gated shell for owner-side routes (`/dashboard`, `/profile`).
 *
 * Renders the shared backdrop, a sub-nav across the signed-in area and
 * — when no session resolves — a full sign-in gate instead of a
 * half-rendered page. The route stays mounted so the URL is shareable.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const [signInOpen, setSignInOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="relative isolate">
        <Backdrop />
        <div className="mx-auto flex max-w-7xl items-center justify-center px-4 py-32">
          <Spinner className="h-6 w-6" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="relative isolate">
        <Backdrop />
        <div className="mx-auto max-w-xl px-4 py-24 sm:px-6">
          <div className="panel animate-fade-up p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-peko-400/25 bg-peko-400/10">
              <LockKeyhole className="h-6 w-6 text-peko-300" />
            </div>
            <h1 className="display mt-5 text-xl">Sign in to continue</h1>
            <p className="lede mx-auto mt-2 max-w-sm">
              Your pekos, exposure settings and API keys live behind a PekoHub account.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <button onClick={() => setSignInOpen(true)} className="btn-primary">
                Sign in
              </button>
              <Link to="/pekos" className="btn-secondary">
                Browse the directory
              </Link>
            </div>
            <p className="mt-5 font-mono text-2xs text-slate-600">
              GitHub or Google · no password to remember
            </p>
          </div>
        </div>
        <SignInModal isOpen={signInOpen} onClose={() => setSignInOpen(false)} />
      </div>
    );
  }

  return (
    <div className="relative isolate">
      <Backdrop />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <nav className="flex items-center gap-1 border-b border-white/[0.06] pt-4">
          <SubNavLink to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} label="Pekos" />
          <SubNavLink to="/pekos" icon={<Radar className="h-4 w-4" />} label="Discover" />
          <SubNavLink to="/templates" icon={<Boxes className="h-4 w-4" />} label="Templates" />
          <SubNavLink to="/profile" icon={<UserIcon className="h-4 w-4" />} label="Profile" />

          <div className="ml-auto flex items-center gap-2 pb-1">
            <span className="hidden font-mono text-2xs text-slate-600 sm:inline">
              @{user.namespace}
            </span>
            <button
              onClick={() => void logout()}
              className="btn-ghost btn-sm text-2xs uppercase tracking-wider"
            >
              Sign out
            </button>
          </div>
        </nav>

        <div className="animate-fade-in py-8">{children}</div>
      </div>
    </div>
  );
}

function SubNavLink({
  to,
  icon,
  label,
}: {
  to: '/dashboard' | '/pekos' | '/templates' | '/profile';
  icon: ReactNode;
  label: string;
}) {
  return (
    <Link to={to} activeProps={{ className: 'tab tab-active' }} inactiveProps={{ className: 'tab' }}>
      {icon}
      {label}
    </Link>
  );
}
