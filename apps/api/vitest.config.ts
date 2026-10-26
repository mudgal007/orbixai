import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits decorator metadata, which NestJS dependency injection needs (esbuild does not).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/env.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
