import { defineConfig } from "vitest/config";

// One embedded cluster per run (test/global-setup.ts); each DB test file works on its own clone.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
