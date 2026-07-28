import { createFileRoute } from '@tanstack/react-router';
import { useAuth } from '~/hooks/useAuth';
import { AppShell } from '~/components/AppShell';

/**
 * PR #7 stub: the full Discover page (search input, category chips,
 * card grid, "Add to my desktop" deep-link button) is PR #8. This
 * stub exists today so AppShell's nav link doesn't 404, and so the
 * signed-in vs signed-out states render the same empty shell.
 */
export const Route = createFileRoute('/discover')({
  component: DiscoverPage,
});

function DiscoverPage() {
  const { user, isLoading, isAuthenticated } = useAuth();

  return (
    <AppShell>
      <h1 className="text-2xl font-bold text-gray-900">Discover</h1>
      <p className="mt-2 text-gray-600">
        Browse public principals across the PekoHub network.
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500">
        {isLoading
          ? 'Loading...'
          : isAuthenticated && user
            ? 'Discovery UI lands in PR #8 — search input + card grid + deep-link "Add to my desktop" button.'
            : 'Sign in to follow and add public principals.'}
      </div>
    </AppShell>
  );
}