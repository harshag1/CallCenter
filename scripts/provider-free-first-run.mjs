#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const web = join(root, "web");
const args = new Set(process.argv.slice(2));
const supportedArgs = new Set(["--check", "--skip-install"]);

if ([...args].some((arg) => !supportedArgs.has(arg))) {
  process.stderr.write("Usage: npm run demo:offline -- [--check|--skip-install]\n");
  process.exit(2);
}

function supportedNode(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 13) || (major === 20 && minor >= 19);
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
}

function cleanChildEnvironment() {
  const clean = { ...process.env, HACC_PROVIDER_FREE_DEMO: "1" };
  for (const name of Object.keys(clean)) {
    if (
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|DATABASE_URL|PRIVATE_KEY|WEBHOOK_SECRET)$/i.test(name) ||
      /^(?:OPENAI|XAI|GEMINI|GOOGLE|TWILIO|RESEND|POSTGRES|SUPABASE)_/i.test(name)
    ) {
      delete clean[name];
    }
  }
  return clean;
}

function run(command, commandArgs) {
  const outcome = spawnSync(command, commandArgs, {
    cwd: web,
    env: cleanChildEnvironment(),
    stdio: "inherit",
  });
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0) process.exit(outcome.status ?? 1);
}

if (!supportedNode(process.versions.node)) {
  throw new Error(
    `Node ${process.versions.node} is unsupported; install Node 20.19+, 22.13+, or 24+ first`
  );
}

requireFile(join(web, "package.json"), "web package metadata");
requireFile(join(web, "package-lock.json"), "locked dependency manifest");
requireFile(
  join(root, "examples", "flows", "service-appointment-lifecycle.json"),
  "offline example flow"
);

const webPackage = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
if (webPackage.scripts?.["demo:offline"] !== "tsx scripts/offline-flow-demo.ts") {
  throw new Error("web demo:offline entry point is missing or unexpected");
}

process.stdout.write([
  "Harsha's Amazing Call Center — provider-free first run",
  "Prerequisites: Node 20.19+, 22.13+, or 24+ and npm.",
  "Safety: no .env file, application secret, provider, database, telephony, email, or paid API is used.",
  "Spend: $0 expected. Dependency installation may contact the public npm registry.",
  "Child processes receive a credential-stripped environment.",
  "",
].join("\n"));

if (args.has("--check")) {
  process.stdout.write("READY: prerequisites and provider-free demo entry point verified.\n");
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
if (!args.has("--skip-install")) {
  process.stdout.write("Installing locked web dependencies without lifecycle scripts…\n\n");
  run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
}

process.stdout.write("\nRunning the deterministic developer trace…\n\n");
run(npm, ["run", "--silent", "demo:offline", "--", "--view"]);
