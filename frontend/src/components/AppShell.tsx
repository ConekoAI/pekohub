import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useAuth } from '~/hooks/useAuth';
import { Spinner } from '~/components/ui';
import { SignInModal } from '~/components/SignInModal';

/**
 * Auth-gated shell for the owner console: your pekos, seeds, runtimes,
 * and account (`/dashboard`, `/dashboard/seeds`, `/dashboard/runtimes`,
 * `/profile`).
 *
 * Renders a sub-nav across the signed-in area and — when no session
 * resolves — a sign-in gate instead of a half-rendered page. The route
 * stays mounted so the URL is shareable.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, isLoading, isAuthenticated } = useAuth();
  const [signInOpen, setSignInOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-32">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="mx-auto max-w-sm animate-fade-up px-5 py-32 text-center">
        <h1 className="h-page">Sign in to continue</h1>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button onClick={() => setSignInOpen(true)} className="btn-primary">
            Sign in
          </button>
        </div>
        <SignInModal isOpen={signInOpen} onClose={() => setSignInOpen(false)} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 sm:px-8">
      <nav className="flex items-center gap-6 border-b border-ink-700 pt-6">
        <SubNavLink to="/dashboard" label="Pekos" />
        <SubNavLink to="/dashboard/seeds" label="Seeds" />
        <SubNavLink to="/dashboard/runtimes" label="Runtimes" />
        <SubNavLink to="/profile" label="Account" />
      </nav>

      <div className="animate-fade-in pb-8 pt-10">{children}</div>
    </div>
  );
}

function SubNavLink({
  to,
  label,
}: {
  to: '/dashboard' | '/dashboard/seeds' | '/dashboard/runtimes' | '/profile';
  label: string;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      activeProps={{ className: 'tab tab-active' }}
      inactiveProps={{ className: 'tab' }}
    >
      {label}
    </Link>
  );
}
