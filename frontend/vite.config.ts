import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => ({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // In dev the SPA calls the API on its own origin; forward it to the
    // backend (`VITE_DEV_API`, default the local backend on :3000).
    proxy: Object.fromEntries(
      ['/v1', '/oauth', '/health', '/docs'].map((path) => [
        path,
        process.env.VITE_DEV_API ?? 'http://localhost:3000',
      ]),
    ),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  define: {
    __API_BASE__: JSON.stringify(mode === 'production' ? process.env.VITE_API_BASE_URL ?? '' : ''),
  },
}));
