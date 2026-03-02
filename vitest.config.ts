import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for node-based tests.
 */
export default defineConfig({
  test: {
    environment: "node",
  },
});
