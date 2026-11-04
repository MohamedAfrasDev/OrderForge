import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The manual real-model evaluation only (eval/intake/run.ts). Never part of `npm test` or CI.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["eval/intake/run.ts"],
    fileParallelism: false,
    testTimeout: 4 * 60 * 60 * 1000,
    hookTimeout: 60_000,
  },
});
