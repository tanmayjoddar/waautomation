import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests must never reach paid or external APIs. Any test that wants an
    // external call must use one of the fake adapters in tests/fakes.
    globals: false,
    reporters: ["default"],
    // The tests under tests/db/ run against a real Supabase project: a single
    // test makes several round trips (create client, insert, upsert, call an RPC,
    // clean up) and each one can take about a second on a cold project. Vitest's
    // 5s default fails them even though nothing is wrong.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
