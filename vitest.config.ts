import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/harness/setup.ts"],
    testTimeout: 20000,
  },
});
