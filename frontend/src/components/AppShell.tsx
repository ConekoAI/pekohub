import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { LayoutDashboard, Search, User as UserIcon } from 'lucide-react';
import { useAuth } from '~/hooks/useAuth';

/**
 * PR #7: AppShell — auth-gated secondary nav for owner-side and
 * private-facing routes (Dashboard, Discover, Profile). The header
 * (logo + auth dropdown + GitHub link) still lives in `Layout` so the
 * nav stays consistent across public and private routes. AppShell
 * just adds the sub-nav below the header.
 *
 * Renders a friendly "sign in required" placeholder when the user
 * is not authenticated; the route itself is still mounted so the
 * URL is shareable, but the user can't act on it until they sign
 * in. The verify-only `Profile` route already follows this same
 * pattern; we're being consistent.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, isLoading, isAuthenticated, logout } = useAuth();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      {/* Sub-nav. Hidden on mobile (the user can already access
          these via the avatar menu) — keeps desktop focused. */}
      {isAuthenticated && user ? (
        <nav className="mt-4 flex items-center gap-1 border-b border-gray-200">
          <SubNavLink to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} label="Dashboard" />
          <SubNavLink to="/discover" icon={<Search className="h-4 w-4" />} label="Discover" />
          <SubNavLink to="/profile" icon={<UserIcon className="h-4 w-4" />} label="Profile" />
          <div className="ml-auto pb-2">
            <button
              onClick={() => void logout()}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Sign out
            </button>
          </div>
        </nav>
      ) : null}

      <div className="py-6">{children}</div>

      {/* Friendlier hint for unauthenticated visits. Only renders
          once the loading state has resolved so we don't flash a
          "sign in" prompt before the JWT check completes. */}
      {!isLoading && !isAuthenticated ? (
        <SignedOutPlaceholder />
      ) : null}
    </div>
  );
}

function SubNavLink({
  to,
  icon,
  label,
}: {
  to: '/dashboard' | '/discover' | '/profile';
  icon: ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      activeProps={{
        className:
          'flex items-center gap-2 border-b-2 border-peko-600 px-3 pb-2 pt-2 text-sm font-medium text-peko-600',
      }}
      inactiveProps={{
        className:
          'flex items-center gap-2 border-b-2 border-transparent px-3 pb-2 pt-2 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700',
      }}
    >
      {icon}
      {label}
    </Link>
  );
}

function SignedOutPlaceholder() {
  return (
    <div className="mt-12 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-600">
      <p>Sign in to manage your pekos, publish bundles, and invite collaborators.</p>
    </div>
  );
}