import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAuth } from './useAuth';
import { createTestQueryClient } from '~/test/utils';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useAuth', () => {
  it('should return user data when authenticated', async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toMatchObject({
      namespace: 'testuser',
      displayName: 'Test User',
      email: 'test@example.com',
    });
  });
});
