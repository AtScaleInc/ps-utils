import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for node-based tests.
 */
export default defineConfig({
  test: {
    environment: "node",
    // `dist/` holds a compiled copy of every test. Without this, vitest globs it
    // too and each test runs twice — once from source, once from a stale build —
    // which doubles every failure and reports results for code that may predate
    // the working tree.
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
