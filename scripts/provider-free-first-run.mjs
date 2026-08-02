#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const web = join(root, "web");
const argv = process.argv.slice(2);
let checkOnly = false;
let skipInstall = false;
let jsonOutput = false;
let flowPath = null;
let scenarioPath = null;
let visualizationMode = false;
let outPath = null;

for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--check") checkOnly = true;
  else if (argument === "--skip-install") skipInstall = true;
  else if (argument === "--json") jsonOutput = true;
  else if (argument === "--visualize") visualizationMode = true;
  else if (argument === "--flow" || argument === "--scenario" || argument === "--out") {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      process.stderr.write(`${argument} requires one file path\n`);
      process.exit(2);
    }
    if (argument === "--flow") flowPath = resolve(root, value);
    else if (argument === "--scenario") scenarioPath = resolve(root, value);
    else outPath = resolve(root, value);
    index += 1;
  } else {
    process.stderr.write(
      "Usage: npm run demo:offline -- [--check|--skip-install|--json] " +
      "[--flow FILE --scenario FILE]\n" +
      "   or: npm run flow:visualize -- --flow FILE --out NEW.html\n"
    );
    process.exit(2);
  }
}

if (!visualizationMode && (flowPath === null) !== (scenarioPath === null)) {
  process.stderr.write("--flow and --scenario must be supplied together\n");
  process.exit(2);
}
if (visualizationMode && (!flowPath || !outPath || scenarioPath || jsonOutput || checkOnly)) {
  process.stderr.write("visualization requires --flow FILE and --out NEW.html only\n");
  process.exit(2);
}
if (!visualizationMode && outPath) {
  process.stderr.write("--out is only valid with flow:visualize\n");
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

const lockfilePath = join(web, "package-lock.json");
const dependencyFingerprint = createHash("sha256")
  .update(readFileSync(lockfilePath))
  .digest("hex");
const installStampPath = join(web, "node_modules", ".hacc-offline-install.json");
const installLockPath = join(
  tmpdir(),
  `hacc-offline-install-${createHash("sha256").update(root).digest("hex").slice(0, 16)}.lock`
);

function dependenciesCurrent() {
  if (!existsSync(join(web, "node_modules", "tsx", "dist", "cli.mjs"))) return false;
  try {
    const stamp = JSON.parse(readFileSync(installStampPath, "utf8"));
    return stamp.package_lock_sha256 === dependencyFingerprint;
  } catch {
    return false;
  }
}

function ownerAlive() {
  try {
    const owner = JSON.parse(readFileSync(join(installLockPath, "owner.json"), "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true;
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function acquireInstallLock() {
  const deadline = Date.now() + 5 * 60_000;
  while (true) {
    try {
      mkdirSync(installLockPath, { mode: 0o700 });
      writeFileSync(
        join(installLockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid })}\n`,
        { mode: 0o600 }
      );
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!ownerAlive()) {
        rmSync(installLockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for another provider-free dependency install");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function ensureDependencies() {
  if (dependenciesCurrent()) {
    process.stdout.write("Locked web dependencies already ready.\n");
    return;
  }
  process.stdout.write("Waiting for the locked dependency installer…\n");
  acquireInstallLock();
  try {
    if (dependenciesCurrent()) {
      process.stdout.write("Locked web dependencies became ready.\n");
      return;
    }
    process.stdout.write("Installing locked web dependencies without lifecycle scripts…\n\n");
    run(process.platform === "win32" ? "npm.cmd" : "npm", [
      "ci", "--ignore-scripts", "--no-audit", "--no-fund",
    ]);
    writeFileSync(
      installStampPath,
      `${JSON.stringify({ package_lock_sha256: dependencyFingerprint })}\n`,
      { mode: 0o600 }
    );
  } finally {
    rmSync(installLockPath, { recursive: true, force: true });
  }
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
if (webPackage.scripts?.["flow:visualize"] !== "tsx scripts/flow-visualize.ts") {
  throw new Error("web flow:visualize entry point is missing or unexpected");
}

process.stdout.write([
  "Harsha's Amazing Call Center — provider-free first run",
  "Prerequisites: Node 20.19+, 22.13+, or 24+ and npm.",
  "Safety: no .env file, application secret, provider, database, telephony, email, or paid API is used.",
  "Spend: $0 expected. Dependency installation may contact the public npm registry.",
  "Child processes receive a credential-stripped environment.",
  "",
].join("\n"));

if (checkOnly) {
  process.stdout.write("READY: prerequisites and provider-free demo entry point verified.\n");
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
if (!skipInstall) ensureDependencies();

if (visualizationMode) {
  process.stdout.write("\nRendering the offline flow view…\n\n");
  run(npm, [
    "run", "--silent", "flow:visualize", "--",
    "--flow", flowPath,
    "--out", outPath,
  ]);
} else if (flowPath && scenarioPath) {
  process.stdout.write("\nRunning the deterministic developer trace…\n\n");
  run(npm, [
    "run", "--silent", "flow:scenario", "--",
    "--flow", flowPath,
    "--scenario", scenarioPath,
    ...(jsonOutput ? [] : ["--view"]),
  ]);
} else {
  process.stdout.write("\nRunning the deterministic developer trace…\n\n");
  run(npm, ["run", "--silent", "demo:offline", "--", ...(jsonOutput ? [] : ["--view"])]);
}
