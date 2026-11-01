import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from '~/routeTree.gen';
import { createTestQueryClient } from '~/test/utils';

describe('document title', () => {
  it('comes from the deepest route that names one', async () => {
    const queryClient = createTestQueryClient();
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/download'] }), context: { queryClient } });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.title).toBe('Download Peko'));
  });
});
