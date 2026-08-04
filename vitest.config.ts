import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts', '**/testing.ts'],
    },
  },
  resolve: {
    // Tests run against source, not dist, so a stale build cannot hide a
    // failure. Anchored regexes rather than string prefixes, so a subpath
    // import is not rewritten by the bare-specifier rule.
    alias: [
      { find: /^@exitliquidity\/core$/, replacement: source('./packages/core/src/index.ts') },
      { find: /^@exitliquidity\/solana$/, replacement: source('./packages/solana/src/index.ts') },
      {
        find: /^@exitliquidity\/parsers$/,
        replacement: source('./packages/parsers/src/index.ts'),
      },
      {
        find: /^@exitliquidity\/parsers\/testing$/,
        replacement: source('./packages/parsers/src/testing.ts'),
      },
      {
        find: /^@exitliquidity\/clickhouse$/,
        replacement: source('./packages/clickhouse/src/index.ts'),
      },
      {
        find: /^@exitliquidity\/pricing$/,
        replacement: source('./packages/pricing/src/index.ts'),
      },
    ],
  },
});
