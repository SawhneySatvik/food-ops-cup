import { defineConfig } from "vitest/config";

// One embedded Postgres cluster per run (test/global-setup.ts); each test file works on its own clone.
// src/** is included so lanes that own src/ subdirectories (commit, runtoken, stream) can colocate tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: { NODE_ENV: "test" },
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
