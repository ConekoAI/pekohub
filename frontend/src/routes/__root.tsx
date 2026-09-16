import { createRootRoute, Link, Outlet, useRouter } from '@tanstack/react-router';
import { Compass, RefreshCw, TriangleAlert } from 'lucide-react';
import { Layout } from '~/components/Layout';
import { Backdrop } from '~/components/ui';

export const Route = createRootRoute({
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

function NotFound() {
  return (
    <div className="relative isolate">
      <Backdrop />
      <div className="mx-auto max-w-lg px-4 py-28 text-center sm:px-6">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03]">
          <Compass className="h-6 w-6 text-slate-500" />
        </div>
        <p className="eyebrow mt-6">404</p>
        <h1 className="display mt-2 text-2xl">Nothing lives at this address</h1>
        <p className="lede mx-auto mt-3 max-w-sm">
          The link may be stale, or the peko may have been unexposed since it was shared.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <Link to="/pekos" className="btn-primary">
            Browse pekos
          </Link>
          <Link to="/" className="btn-secondary">
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  return (
    <div className="relative isolate">
      <Backdrop />
      <div className="mx-auto max-w-lg px-4 py-28 text-center sm:px-6">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-500/[0.08]">
          <TriangleAlert className="h-6 w-6 text-rose-400" />
        </div>
        <p className="eyebrow mt-6 text-rose-300">unhandled error</p>
        <h1 className="display mt-2 text-2xl">This page fell over</h1>
        <p className="mx-auto mt-3 max-w-md break-words font-mono text-2xs leading-relaxed text-slate-500">
          {error.message}
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => {
              void router.invalidate();
              reset();
            }}
            className="btn-primary"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
          <Link to="/" className="btn-secondary">
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
