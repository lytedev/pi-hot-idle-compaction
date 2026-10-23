import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
  fmt: {
    printWidth: 100,
    ignorePatterns: ["node_modules/**", "package-lock.json"],
  },
});
