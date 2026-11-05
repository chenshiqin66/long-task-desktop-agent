import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Bash spawn/kill on Windows is slow and can contend across files.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
