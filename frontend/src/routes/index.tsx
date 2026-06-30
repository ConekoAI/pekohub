import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { SearchBar } from '~/components/SearchBar';
import { BundleCard } from '~/components/BundleCard';
import { useSearch } from '~/hooks/useSearch';
import { Package, Sparkles, Wrench } from 'lucide-react';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();

  const search = useSearch({
    q: '',
    page: 1,
    perPage: 20,
  });

  const handleSearch = (query: string) => {
    if (query) {
      navigate({ to: '/search', search: { q: query } });
    }
  };

  return (
    <div>
      {/* Hero */}
      <section className="bg-gradient-to-b from-peko-50 to-white py-20">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            Discover & Share Agents
          </h1>
          <p className="mt-4 text-lg text-gray-600">
            The public registry for Pekobot principals and extensions.
          </p>
          <div className="mt-8 flex justify-center">
            <SearchBar onSearch={handleSearch} />
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <CategoryCard
              icon={<Package className="h-6 w-6" />}
              title="Principals"
              description="Agents and multi-agent orchestrations"
            />
            <CategoryCard
              icon={<Wrench className="h-6 w-6" />}
              title="Extensions"
              description="Skills, MCPs, gateways"
            />
            <CategoryCard
              icon={<Sparkles className="h-6 w-6" />}
              title="Trending"
              description="Most popular this week"
            />
          </div>
        </div>
      </section>

      {/* Trending bundles */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-gray-900">Trending</h2>
          {search.isLoading && (
            <div className="mt-6 text-center text-gray-500">Loading...</div>
          )}
          {search.data && search.data.items.length > 0 && (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {search.data.items.map((bundle) => (
                <BundleCard key={`${bundle.namespace}/${bundle.name}`} bundle={bundle} />
              ))}
            </div>
          )}
          {search.data?.items.length === 0 && (
            <div className="mt-6 text-center text-gray-500">No bundles found.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function CategoryCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="card p-4 hover:shadow-md transition-shadow cursor-pointer">
      <div className="text-peko-600">{icon}</div>
      <h3 className="mt-2 font-semibold text-gray-900">{title}</h3>
      <p className="mt-1 text-sm text-gray-500">{description}</p>
    </div>
  );
}
