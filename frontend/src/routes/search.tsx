import { createFileRoute, useSearch as useRouteSearch, useNavigate } from '@tanstack/react-router';
import { SearchBar } from '~/components/SearchBar';
import { BundleCard } from '~/components/BundleCard';
import { useSearch } from '~/hooks/useSearch';
import { z } from 'zod';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const searchSchema = z.object({
  q: z.string().default(''),
});

export const Route = createFileRoute('/search')({
  validateSearch: searchSchema,
  component: SearchPage,
});

function SearchPage() {
  const { q } = useRouteSearch({ from: '/search' });
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const perPage = 20;

  const search = useSearch({
    q,
    page,
    perPage,
  });

  const handleSearch = (query: string) => {
    setPage(1);
    if (query) {
      navigate({ to: '/search', search: { q: query } });
    }
  };

  const totalPages = search.data?.totalPages ?? 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <SearchBar initialQuery={q} onSearch={handleSearch} />
      </div>

      {search.isLoading && <div className="text-center text-gray-500">Searching...</div>}

      {search.data && (
        <>
          <p className="mb-4 text-sm text-gray-500">
            {search.data.total} results for &ldquo;{q}&rdquo;
          </p>

          {search.data.items.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              No bundles found matching &ldquo;{q}&rdquo;
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {search.data.items.map((bundle) => (
                  <BundleCard key={`${bundle.namespace}/${bundle.name}`} bundle={bundle} />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-8 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="btn-secondary p-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>

                  <span className="text-sm text-gray-600">
                    Page {page} of {totalPages}
                  </span>

                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="btn-secondary p-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {search.isError && (
        <div className="text-center text-red-600">
          Error: {search.error.message}
        </div>
      )}
    </div>
  );
}
