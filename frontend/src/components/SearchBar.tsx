import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';

interface SearchBarProps {
  initialQuery?: string;
  onSearch: (query: string) => void;
  placeholder?: string;
  size?: 'md' | 'lg';
  /** Focus the field on mount. Used by the empty directory states. */
  autoFocus?: boolean;
}

/**
 * Search input. Controlled locally and submitted on Enter (and on
 * blur-free form submit) so we never fire a request per keystroke from
 * the hero.
 */
export function SearchBar({
  initialQuery = '',
  onSearch,
  placeholder = 'Search pekos…',
  size = 'lg',
  autoFocus = false,
}: SearchBarProps) {
  const [value, setValue] = useState(initialQuery);

  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSearch(value.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="group relative w-full">
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 transition-colors group-focus-within:text-peko-300"
        aria-hidden
      />
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label="Search"
        className={
          size === 'lg'
            ? 'input-lg pl-11 pr-24 shadow-card transition-shadow focus:shadow-glow'
            : 'input pl-10 pr-20'
        }
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            setValue('');
            onSearch('');
          }}
          className="absolute right-[4.75rem] top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition-colors hover:text-slate-300"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="submit"
        className={
          size === 'lg'
            ? 'btn-primary btn-sm absolute right-2 top-1/2 -translate-y-1/2 px-3.5 py-2'
            : 'btn-primary btn-sm absolute right-1.5 top-1/2 -translate-y-1/2'
        }
      >
        Search
      </button>
    </form>
  );
}
