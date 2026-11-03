import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, afterAll } from 'vitest';
import { server } from './mocks/server.js';

// Start MSW before all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

// Tests run signed in unless they say otherwise: the site asks who is
// signed in only when it holds a token.
beforeEach(() => localStorage.setItem('pekohub_token', 'test-token'));

// Reset handlers after each test
afterEach(() => {
  server.resetHandlers();
  cleanup();
});

// Close server after all tests
afterAll(() => server.close());
