import { describe, it, expect, vi } from 'vitest';
import { probe } from './status';

describe('status probe', () => {
  it('is up on a JSON 2xx answer', async () => {
    const fetcher = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    expect((await probe('/health', fetcher as unknown as typeof fetch)).ok).toBe(true);
  });

  it('is down on an error status, a web page, or no answer', async () => {
    const error = vi.fn(async () => new Response('{"error":"x"}', { status: 503 }));
    expect((await probe('/health', error as unknown as typeof fetch)).ok).toBe(false);
    const html = vi.fn(async () => new Response('<!DOCTYPE html>', { status: 200 }));
    expect((await probe('/health', html as unknown as typeof fetch)).ok).toBe(false);
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await probe('/health', offline as unknown as typeof fetch)).ok).toBe(false);
  });
});
