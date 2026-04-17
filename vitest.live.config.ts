import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000, // Write txs + subgraph sync take longer than reads
    hookTimeout: 120_000, // beforeAll creates venues/markets on-chain
    globalSetup: ['./test/integration/helpers/globalSetup.ts'],
    fileParallelism: false, // Tests share on-chain state; prevent nonce conflicts
  },
});
