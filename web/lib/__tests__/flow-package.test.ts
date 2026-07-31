import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeFlowV2Import,
  createImmutableFlowV2Export,
  flowToolDependencies,
  flowV2Digest,
  materializeFlowV2Import,
  serializeFlowV2Export,
} from "../flow-package";
import type { AgentFlow } from "../flow";

const EXAMPLES = [
  "../../../examples/flows/service-appointment-lifecycle.json",
  "../../../examples/flows/warranty-and-incident-intake.json",
  "../../../examples/flows/membership-return-resolution.json",
] as const;

function load(path: string = EXAMPLES[0]): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("Flow v2 immutable import and export", () => {
  it("round-trips every deep example with a canonical digest and closed tool catalog", () => {
    for (const path of EXAMPLES) {
      const source = load(path);
      const exported = createImmutableFlowV2Export(source);
      const names = exported.dependencies.tools.map((dependency) => dependency.name);
      const plan = analyzeFlowV2Import(JSON.parse(serializeFlowV2Export(exported)), {
        availableTools: names,
      });

      expect(plan.source).toBe("immutable_export");
      expect(plan.valid).toBe(true);
      expect(plan.readyForInstall).toBe(true);
      expect(plan.diagnostics).toEqual([]);
      expect(plan.flowSha256).toBe(exported.flow_sha256);
      expect(plan.catalog).toMatchObject({
        status: "complete",
        required: names,
        missing: [],
      });
      expect(materializeFlowV2Import(plan)).toEqual(exported.flow);
      expect(Object.isFrozen(exported)).toBe(true);
      expect(Object.isFrozen(exported.flow.nodes)).toBe(true);
      expect(Object.isFrozen(plan.flow)).toBe(true);
    }
  });

  it("makes the digest independent of object key order while preserving semantic values", () => {
    const source = load() as AgentFlow;
    const reordered = Object.fromEntries(Object.entries(source).reverse()) as AgentFlow;
    expect(flowV2Digest(reordered)).toBe(flowV2Digest(source));

    const changed = clone(source);
    changed.max_step_entries = (changed.max_step_entries ?? 0) + 1;
    expect(flowV2Digest(changed)).not.toBe(flowV2Digest(source));
  });

  it("reports action and reconciliation-query dependencies with exact source paths", () => {
    const source = load() as AgentFlow;
    const report = flowToolDependencies(source);
    const commit = report.tools.find((dependency) => dependency.name === "commit_service_appointment_operation");
    const lookup = report.tools.find((dependency) => dependency.name === "lookup_appointment_invocation");

    expect(commit?.usages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "step_tool",
        path: expect.stringContaining("appointment.commit.tools"),
      }),
      expect.objectContaining({
        kind: "action_policy",
        path: expect.stringContaining("appointment.commit.action_policies"),
      }),
    ]));
    expect(lookup?.usages).toEqual([
      expect.objectContaining({
        kind: "reconciliation_query",
        path: expect.stringContaining("reconciliation.queryTool"),
      }),
    ]);
  });

  it("fails dry-run when a required tool is missing and materialization stays closed", () => {
    const exported = createImmutableFlowV2Export(load());
    const available = exported.dependencies.tools
      .map((dependency) => dependency.name)
      .filter((name) => name !== "lookup_appointment_invocation");
    const plan = analyzeFlowV2Import(exported, { availableTools: available });

    expect(plan.valid).toBe(true);
    expect(plan.readyForInstall).toBe(false);
    expect(plan.catalog.status).toBe("incomplete");
    expect(plan.catalog.missing).toEqual(["lookup_appointment_invocation"]);
    expect(() => materializeFlowV2Import(plan)).toThrow(/missing tools: lookup_appointment_invocation/);
  });

  it("requires an explicit catalog before an otherwise valid flow can be installed", () => {
    const plan = analyzeFlowV2Import(load());
    expect(plan.valid).toBe(true);
    expect(plan.catalog.status).toBe("not_checked");
    expect(plan.readyForInstall).toBe(false);
    expect(() => materializeFlowV2Import(plan)).toThrow(/tool catalog was not checked/);
  });

  it("detects flow and dependency-manifest tampering in an immutable export", () => {
    const exported = createImmutableFlowV2Export(load());
    const flowTamper = clone(exported);
    flowTamper.flow.max_step_entries = 999;
    const dependencyTamper = clone(exported);
    dependencyTamper.dependencies.tools.shift();
    const unknownFieldTamper = clone(exported) as typeof exported & {
      flow: typeof exported.flow & { ignored_authority?: string };
    };
    unknownFieldTamper.flow.ignored_authority = "must not be silently stripped";

    expect(analyzeFlowV2Import(flowTamper).diagnostics).toContainEqual(expect.objectContaining({
      level: "error",
      path: "flow_sha256",
      message: expect.stringMatching(/digest does not match/),
    }));
    expect(analyzeFlowV2Import(dependencyTamper).diagnostics).toContainEqual(expect.objectContaining({
      level: "error",
      path: "dependencies",
      message: expect.stringMatching(/manifest does not match/),
    }));
    expect(analyzeFlowV2Import(unknownFieldTamper).diagnostics).toContainEqual(expect.objectContaining({
      level: "error",
      path: "$",
      message: expect.stringMatching(/unknown fields/),
    }));
  });

  it("includes effective default always-tools when the definition omits an explicit list", () => {
    const source = clone(load() as AgentFlow);
    delete source.always_tools;
    delete source.always_action_policies;
    expect(flowToolDependencies(source).tools
      .filter((dependency) => dependency.usages.some((usage) => usage.kind === "always_tool"))
      .map((dependency) => dependency.name))
      .toEqual(["contact_support", "end_call", "log_note"]);
  });

  it("rejects lossy unknown fields, Flow v1, and malformed reconciliation authority", () => {
    const unknown = { ...(load() as AgentFlow), surprise: "silently stripping this is unsafe" };
    const v1 = clone(load() as AgentFlow);
    v1.schema_version = 1;
    v1.tool_exposure = "direct";
    const malformed = clone(load() as AgentFlow);
    const policy = malformed.nodes
      .flatMap((node) => node.steps ?? [])
      .flatMap(function flatten(step): typeof step[] {
        return [step, ...(step.steps ?? []).flatMap(flatten)];
      })
      .flatMap((step) => step.action_policies ?? [])
      .find((candidate) => candidate.reconciliation);
    if (!policy) throw new Error("fixture needs a reconciliation policy");
    policy.reconciliation = { queryTool: "lookup_appointment_invocation" };

    expect(analyzeFlowV2Import(unknown).diagnostics).toContainEqual(expect.objectContaining({
      path: "$",
      message: expect.stringMatching(/unknown fields/),
    }));
    expect(analyzeFlowV2Import(v1).diagnostics).toContainEqual(expect.objectContaining({
      path: "schema_version",
      message: expect.stringMatching(/Flow v2/),
    }));
    expect(analyzeFlowV2Import(malformed).diagnostics).toContainEqual(expect.objectContaining({
      path: expect.stringContaining("reconciliation"),
      level: "error",
    }));
  });

  it("fails closed instead of throwing on non-JSON values supplied through the library API", () => {
    const source = clone(load() as AgentFlow);
    source.max_step_entries = undefined;
    const plan = analyzeFlowV2Import(source);
    expect(plan.valid).toBe(false);
    expect(plan.readyForInstall).toBe(false);
    expect(plan.flowSha256).toBeNull();
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringMatching(/canonical JSON/) }),
      expect.objectContaining({ message: expect.stringMatching(/digest could not be computed/) }),
    ]));
  });
});
