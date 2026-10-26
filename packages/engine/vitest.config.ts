import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/env.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
