import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests must never reach paid or external APIs. Any test that wants an
    // external call must use one of the fake adapters in tests/fakes.
    globals: false,
    reporters: ['default'],
  },
});
