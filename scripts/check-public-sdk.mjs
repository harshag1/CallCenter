import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "web", "node_modules", ".bin", "tsc");
const fixture = join(root, "examples", "sdk-consumer");
const scope = join(fixture, "node_modules", "@hacc");

function run(args, cwd = root) {
  execFileSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
}

rmSync(join(root, "packages", "hacc-core", "dist"), { recursive: true, force: true });
rmSync(join(root, "packages", "hacc-provider-sdk", "dist"), { recursive: true, force: true });
rmSync(join(fixture, "dist"), { recursive: true, force: true });
rmSync(join(fixture, "node_modules"), { recursive: true, force: true });

run([tsc, "-p", "packages/hacc-core/tsconfig.json"]);
run([tsc, "-p", "packages/hacc-provider-sdk/tsconfig.json"]);
run([process.execPath, "--test", "packages/hacc-core/test/core.test.mjs"]);
run([process.execPath, "--test", "packages/hacc-provider-sdk/test/provider.test.mjs"]);

mkdirSync(scope, { recursive: true });
symlinkSync(join(root, "packages", "hacc-core"), join(scope, "core"), "dir");
symlinkSync(join(root, "packages", "hacc-provider-sdk"), join(scope, "provider-sdk"), "dir");

try {
  run([tsc, "-p", "tsconfig.json"], fixture);
  run([process.execPath, "dist/index.js"], fixture);
} finally {
  rmSync(join(fixture, "node_modules"), { recursive: true, force: true });
  rmSync(join(fixture, "dist"), { recursive: true, force: true });
  rmSync(join(root, "packages", "hacc-core", "dist"), { recursive: true, force: true });
  rmSync(join(root, "packages", "hacc-provider-sdk", "dist"), { recursive: true, force: true });
}
