import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Next.js resolves the marker package with the `react-server` condition.
    // Vitest runs in plain Node, where the package's default export
    // intentionally throws. Alias only the test resolver to the empty marker;
    // production builds still enforce the real server-only boundary.
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./lib/test-support/server-only.ts", import.meta.url)),
    },
  },
});
