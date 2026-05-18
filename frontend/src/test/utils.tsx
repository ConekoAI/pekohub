import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Create a test QueryClient with disabled retries and short stale time.
 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
    },
  });
}

/**
 * Render a component with QueryClientProvider.
 */
export function render(ui: ReactNode) {
  const queryClient = createTestQueryClient();

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return {
    ...rtlRender(<Wrapper>{ui}</Wrapper>),
    queryClient,
  };
}

/**
 * Render a component with just QueryClientProvider (alias for render).
 */
export function renderWithQuery(ui: ReactNode) {
  return render(ui);
}
