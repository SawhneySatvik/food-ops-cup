import { defineConfig } from "vitest/config";

// One embedded cluster per run (tests/global-setup.ts); each test file works on its own database clone.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
