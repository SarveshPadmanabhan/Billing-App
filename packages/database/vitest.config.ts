import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { resolve } from 'node:path';

// These tests hit the real database; load the workspace .env.
config({ path: resolve(__dirname, '../../.env') });

export default defineConfig({
  test: {
    // The concurrency tests contend on shared sequence rows, so test files
    // must not run in parallel with each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
