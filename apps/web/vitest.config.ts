import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";
import path from "node:path";

// `@munim-dev/*` as tsconfig `paths` resolves it: a development checkout's adapters/dev/env, else lib/server/no-dev.
const dev = path.resolve(__dirname, "../../adapters/dev/env");

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname), "@munim-dev": existsSync(dev) ? dev : path.resolve(__dirname, "lib/server/no-dev") } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
