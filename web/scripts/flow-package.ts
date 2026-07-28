import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  analyzeFlowV2Import,
  createImmutableFlowV2Export,
  materializeFlowV2Import,
  serializeFlowV2Export,
} from "../lib/flow-package";
import { canonicalJson } from "../lib/conversation-kernel";

type Command = "inspect" | "export" | "import";
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function usage(): never {
  throw new Error([
    "Usage:",
    "  npx tsx scripts/flow-package.ts inspect <flow-or-export.json> [--catalog <catalog.json>]",
    "  npx tsx scripts/flow-package.ts export <flow-or-export.json> [--out <new-file.json>]",
    "  npx tsx scripts/flow-package.ts import <flow-or-export.json> --catalog <catalog.json> --dry-run",
    "  npx tsx scripts/flow-package.ts import <flow-or-export.json> --catalog <catalog.json> --out <new-flow.json>",
    "",
    "A catalog is either [\"tool_name\"] or {\"tools\":[\"tool_name\"]}. Output files are",
    "created exclusively; this command never overwrites an existing file.",
  ].join("\n"));
}

function parseArgs(argv: readonly string[]): {
  command: Command;
  source: string;
  catalog?: string;
  out?: string;
  dryRun: boolean;
} {
  const [command, source, ...rest] = argv;
  if (!["inspect", "export", "import"].includes(command ?? "") || !source) usage();
  let catalog: string | undefined;
  let out: string | undefined;
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--catalog" && rest[index + 1]) {
      catalog = rest[++index];
    } else if (value === "--out" && rest[index + 1]) {
      out = rest[++index];
    } else {
      usage();
    }
  }
  if (command === "export" && (catalog || dryRun)) usage();
  if (command === "inspect" && (out || dryRun)) usage();
  if (command === "import" && (!catalog || (dryRun === !!out))) usage();
  return { command: command as Command, source, catalog, out, dryRun };
}

async function readJson(path: string): Promise<unknown> {
  const source = resolve(path);
  const metadata = await stat(source);
  if (!metadata.isFile() || metadata.size > MAX_SOURCE_BYTES) {
    throw new Error(`input must be a regular JSON file no larger than ${MAX_SOURCE_BYTES} bytes`);
  }
  const text = await readFile(source, "utf8");
  return JSON.parse(text) as unknown;
}

function parseCatalog(input: unknown): string[] {
  const candidate = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { tools?: unknown }).tools)
      ? (input as { tools: unknown[] }).tools
      : null;
  if (!candidate || !candidate.every((tool) => typeof tool === "string" && tool.length > 0)) {
    throw new Error("catalog must be a JSON string array or an object with a string-array tools field");
  }
  if (candidate.length > 4096 || candidate.some((tool) => !/^[a-z][a-z0-9_.-]{1,63}$/.test(tool))) {
    throw new Error("catalog may contain at most 4096 valid tool names");
  }
  return candidate;
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const target = resolve(path);
  try {
    await access(target, constants.F_OK);
    throw new Error(`refusing to overwrite existing file: ${target}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("refusing to overwrite")) throw error;
  }
  await writeFile(target, `${contents}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = await readJson(args.source);
  const availableTools = args.catalog ? parseCatalog(await readJson(args.catalog)) : undefined;
  const plan = analyzeFlowV2Import(source, { availableTools });

  if (args.command === "inspect") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.exitCode = plan.valid && plan.catalog.status !== "incomplete" ? 0 : 1;
    return;
  }

  if (args.command === "export") {
    const exported = createImmutableFlowV2Export(source);
    const serialized = serializeFlowV2Export(exported);
    if (args.out) await writeExclusive(args.out, serialized);
    else process.stdout.write(`${serialized}\n`);
    return;
  }

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.exitCode = plan.readyForInstall ? 0 : 1;
    return;
  }

  const flow = materializeFlowV2Import(plan);
  await writeExclusive(args.out!, canonicalJson(flow));
  process.stdout.write(`${JSON.stringify({
    installed: resolve(args.out!),
    flow_sha256: plan.flowSha256,
    tool_dependencies: plan.catalog.required.length,
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
