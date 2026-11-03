import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useAuth } from './useAuth';
import { createTestQueryClient } from '~/test/utils';
import { server } from '~/test/mocks/server';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const ME = { id: 'user-1', namespace: 'testuser', displayName: 'Test User', email: 'test@example.com' };

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

  it('knows a visitor without a token is signed out at once, without asking the API', () => {
    localStorage.removeItem('pekohub_token');
    let asked = false;
    server.use(
      http.get('/v1/auth/me', () => {
        asked = true;
        return HttpResponse.json(ME);
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    // Settled on the first render: no spinner while a request is in flight.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(asked).toBe(false);
  });

  it('asks who is signed in with a plain GET: no Content-Type, so no CORS preflight', async () => {
    let contentType: string | null = 'unset';
    server.use(
      http.get('/v1/auth/me', ({ request }) => {
        contentType = request.headers.get('content-type');
        return HttpResponse.json(ME);
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(contentType).toBeNull();
  });

  it('refreshes an expired token instead of looking signed out', async () => {
    localStorage.setItem('pekohub_token', 'expired');
    server.use(
      http.get('/v1/auth/me', ({ request }) =>
        request.headers.get('authorization') === 'Bearer fresh'
          ? HttpResponse.json(ME)
          : HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
      http.post('/v1/auth/refresh', () => HttpResponse.json({ token: 'fresh' })),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(localStorage.getItem('pekohub_token')).toBe('fresh');
  });

  it('signs the visitor out when the refresh fails too', async () => {
    localStorage.setItem('pekohub_token', 'expired');
    server.use(
      http.get('/v1/auth/me', () => HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })),
      http.post('/v1/auth/refresh', () => HttpResponse.json({ error: 'Missing refresh token' }, { status: 401 })),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem('pekohub_token')).toBeNull();
  });
});
