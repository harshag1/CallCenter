#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { runFlowScenario } from "../lib/agent/tools/flow-testing";

type Options = Readonly<{
  flow: string;
  scenario: string;
  view: boolean;
}>;

function usage(): string {
  return "usage: npm run flow:scenario -- --flow ABS --scenario ABS [--view]";
}

function absolutePath(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} requires one path`);
  const normalized = resolve(value);
  if (!isAbsolute(normalized)) throw new Error(`${label} must resolve to an absolute path`);
  return normalized;
}

function options(argv: readonly string[]): Options {
  let flow: string | null = null;
  let scenario: string | null = null;
  let view = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--view") {
      if (view) throw new Error("--view may appear only once");
      view = true;
      continue;
    }
    if (argument === "--flow" || argument === "--scenario") {
      const target = absolutePath(argv[index + 1], argument);
      if (argument === "--flow") {
        if (flow) throw new Error("--flow may appear only once");
        flow = target;
      } else {
        if (scenario) throw new Error("--scenario may appear only once");
        scenario = target;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!flow || !scenario) throw new Error("--flow and --scenario are required");
  return Object.freeze({ flow, scenario, view });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function render(
  flowPath: string,
  scenarioPath: string,
  result: Extract<ReturnType<typeof runFlowScenario>, { ok: true }>,
): string {
  const lines = [
    "HACC provider-free scenario",
    `Flow: ${basename(flowPath)}`,
    `Scenario: ${basename(scenarioPath)}`,
    "",
  ];
  for (const raw of result.trace) {
    const event = record(raw);
    const state = record(event.state);
    const type = typeof event.type === "string" ? event.type : "event";
    const path = typeof event.path === "string" ? ` ${event.path}` : "";
    const receipt = typeof event.receipt_id === "string" ? ` ${event.receipt_id}` : "";
    lines.push(`${String(event.index ?? "-").padStart(2, "0")}  ${type}${path}${receipt}`);
    if (type === "enter_step") {
      lines.push(`    tools: ${strings(event.available_tools).join(", ") || "none"}`);
    }
    if (type === "interrupt") {
      lines.push(`    recovered: ${strings(event.recovered_receipt_ids).join(", ") || "none"}`);
    }
    if (type === "reconcile_action") {
      lines.push(`    proof: ${String(event.proof_id ?? "missing")} -> ${String(event.status ?? "unknown")}`);
    }
    if (typeof state.status === "string") {
      lines.push(`    state: ${state.status}; active: ${String(state.current_step ?? "none")}`);
    }
  }
  const final = record(result.final);
  lines.push(
    "",
    `FINAL  ${String(final.status ?? "unknown")}; active: ${String(final.current_step ?? "none")}`,
    `  completed: ${strings(final.completed_steps).length}`,
    `  checkpoints: ${Array.isArray(final.checkpoints) ? final.checkpoints.length : 0}`,
    `  receipts: ${Array.isArray(final.action_receipts) ? final.action_receipts.length : 0}`,
    "SAFETY  provider calls: 0; database writes: 0; expected spend: $0",
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const parsed = options(process.argv.slice(2));
  const [flow, scenario] = await Promise.all([
    readFile(parsed.flow, "utf8").then((value) => JSON.parse(value) as unknown),
    readFile(parsed.scenario, "utf8").then((value) => JSON.parse(value) as unknown),
  ]);
  const result = runFlowScenario(flow, scenario);
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(parsed.view
    ? render(parsed.flow, parsed.scenario, result)
    : `${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${usage()}\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
