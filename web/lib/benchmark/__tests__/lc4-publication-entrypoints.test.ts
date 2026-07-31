import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

const PUBLICATION_ENTRYPOINTS = Object.freeze([
  "scripts/lc4-development-public-results.ts",
  "scripts/lc4-launch-benchmark.ts",
  "scripts/lc4-launch-benchmark-visual.ts",
]);

describe("LC4 publication entrypoints", () => {
  it.each(PUBLICATION_ENTRYPOINTS)(
    "remains executable through the Node 24 tsx CommonJS transform: %s",
    (entrypoint) => {
      const source = readFileSync(resolve(process.cwd(), entrypoint), "utf8");

      expect(() => transformSync(source, {
        format: "cjs",
        loader: "ts",
        target: "node24",
      })).not.toThrow();
    },
  );
});
