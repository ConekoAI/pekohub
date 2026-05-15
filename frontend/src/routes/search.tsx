import { createFileRoute, useSearch as useRouteSearch } from '@tanstack/react-router';
import { SearchBar } from '~/components/SearchBar';
import { BundleCard } from '~/components/BundleCard';
import { useSearch } from '~/hooks/useSearch';
import { z } from 'zod';

const searchSchema = z.object({
  q: z.string().default(''),
});

export const Route = createFileRoute('/search')({
  validateSearch: searchSchema,
  component: SearchPage,
});

function SearchPage() {
  const { q } = useRouteSearch({ from: '/search' });
  const search = useSearch({
    q,
    page: 1,
    perPage: 20,
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <SearchBar initialQuery={q} onSearch={() => {}} />
      </div>

      {search.isLoading && <div className="text-center text-gray-500">Searching...</div>}

      {search.data && (
        <>
          <p className="mb-4 text-sm text-gray-500">
            {search.data.total} results for &ldquo;{q}&rdquo;
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {search.data.items.map((bundle) => (
              <BundleCard key={`${bundle.namespace}/${bundle.name}`} bundle={bundle} />
            ))}
          </div>
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
