import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => ({
  test: {
    // Load .env into the test process so integration tests sign session cookies
    // with the same SESSION_SECRET the running dev server verifies against.
    env: loadEnv(mode, process.cwd(), ''),
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
}));
