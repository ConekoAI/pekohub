import { useEffect } from 'react';
import { createRootRoute, Link, Outlet, useMatches, useRouter } from '@tanstack/react-router';
import { Layout } from '~/components/Layout';
import { reportError } from '~/lib/error-reporting';

export const Route = createRootRoute({
  component: () => (
    <Layout>
      <DocumentTitle />
      <Outlet />
    </Layout>
  ),
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

const DEFAULT_TITLE = 'PekoHub — pekos and the seeds they grow from';

/** The tab title from the deepest route that names one in its `head`. */
function DocumentTitle() {
  const matches = useMatches();
  const title = [...matches]
    .reverse()
    .map((match) => (match.meta as { title?: string }[] | undefined)?.find((m) => m?.title)?.title)
    .find(Boolean);
  useEffect(() => {
    document.title = title ?? DEFAULT_TITLE;
  }, [title]);
  return null;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md animate-fade-up px-5 py-32 text-center">
      <p className="text-sm font-medium text-slate-500">404</p>
      <h1 className="h-page mt-2">Nothing lives at this address</h1>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        <Link to="/" className="btn-primary">
          Home
        </Link>
      </div>
    </div>
  );
}

function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  // The router catches render and loader errors, so the SDK's global
  // handlers never see them.
  useEffect(() => reportError(error), [error]);

  return (
    <div className="mx-auto max-w-md animate-fade-up px-5 py-32 text-center">
      <h1 className="h-page">Something went wrong</h1>
      <p className="mt-3 break-words font-mono text-xs text-slate-500">{error.message}</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={() => {
            void router.invalidate();
            reset();
          }}
          className="btn-primary"
        >
          Try again
        </button>
        <Link to="/" className="btn-ghost">
          Home
        </Link>
      </div>
    </div>
  );
}
