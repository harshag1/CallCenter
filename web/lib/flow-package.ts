import { createHash } from "node:crypto";
import { z } from "zod";
import { ActionReconciliationSpecSchema } from "./action-reconciliation";
import {
  AgentFlowSchema,
  alwaysActionPolicies,
  alwaysTools,
  listStepRefs,
  validateAgentFlow,
  type AgentFlow,
  type FlowDiagnostic,
} from "./flow";
import { canonicalJson } from "./conversation-kernel";

export const FLOW_V2_EXPORT_FORMAT = "hacc.flow-v2" as const;
export const FLOW_V2_EXPORT_VERSION = 1 as const;
export const MAX_FLOW_V2_IMPORT_BYTES = 1024 * 1024;
export const MAX_FLOW_V2_IMPORT_NODES = 256;
export const MAX_FLOW_V2_IMPORT_EDGES = 1024;
export const MAX_FLOW_V2_IMPORT_STEPS = 4096;
export const MAX_FLOW_V2_IMPORT_TOOLS = 1024;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FLOW_DIGEST_DOMAIN = "harshas-amazing-call-center/flow-v2-export/v1\0";

export const FlowToolUsageKindSchema = z.enum([
  "always_tool",
  "always_action_policy",
  "node_tool",
  "step_tool",
  "output_binding",
  "action_policy",
  "bound_argument_source",
  "reconciliation_query",
]);

export type FlowToolUsageKind = z.infer<typeof FlowToolUsageKindSchema>;

export const FlowToolDependencyReportSchema = z.object({
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    usages: z.array(z.object({
      kind: FlowToolUsageKindSchema,
      path: z.string().min(1).max(1024),
    }).strict()).min(1).max(16_384),
  }).strict()).max(MAX_FLOW_V2_IMPORT_TOOLS),
}).strict();

export type FlowToolDependencyReport = z.infer<typeof FlowToolDependencyReportSchema>;

export const FlowV2ExportSchema = z.object({
  format: z.literal(FLOW_V2_EXPORT_FORMAT),
  format_version: z.literal(FLOW_V2_EXPORT_VERSION),
  flow_sha256: z.string().regex(HASH_PATTERN),
  dependencies: FlowToolDependencyReportSchema,
  flow: AgentFlowSchema,
}).strict();

export type FlowV2Export = z.infer<typeof FlowV2ExportSchema>;

export type FlowCatalogReport = Readonly<{
  status: "not_checked" | "complete" | "incomplete";
  required: readonly string[];
  available: readonly string[];
  missing: readonly string[];
  unused: readonly string[];
}>;

export type FlowV2ImportPlan = Readonly<{
  source: "raw_flow" | "immutable_export";
  valid: boolean;
  readyForInstall: boolean;
  flowSha256: string | null;
  diagnostics: readonly FlowDiagnostic[];
  dependencies: FlowToolDependencyReport;
  catalog: FlowCatalogReport;
  flow?: AgentFlow;
}>;

type MutableUsage = { kind: FlowToolUsageKind; path: string };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addUsage(
  usages: Map<string, MutableUsage[]>,
  name: string,
  kind: FlowToolUsageKind,
  path: string
): void {
  const existing = usages.get(name) ?? [];
  existing.push({ kind, path });
  usages.set(name, existing);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function emptyDependencies(): FlowToolDependencyReport {
  return deepFreeze({ tools: [] });
}

function error(path: string, message: string): FlowDiagnostic {
  return { level: "error", path, message };
}

function reconciliationDependency(
  policy: { reconciliation?: unknown },
  path: string,
  usages: Map<string, MutableUsage[]>,
  diagnostics: FlowDiagnostic[]
): void {
  if (policy.reconciliation === undefined) return;
  const parsed = ActionReconciliationSpecSchema.safeParse(policy.reconciliation);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(error(
        `${path}.reconciliation${issue.path.length ? `.${issue.path.join(".")}` : ""}`,
        issue.message
      ));
    }
    return;
  }
  addUsage(usages, parsed.data.queryTool, "reconciliation_query", `${path}.reconciliation.queryTool`);
}

/** Complete, deterministic inventory of every external action name a Flow v2 definition references. */
export function flowToolDependencies(flow: AgentFlow): FlowToolDependencyReport {
  const usages = new Map<string, MutableUsage[]>();
  const diagnostics: FlowDiagnostic[] = [];

  const explicitAlwaysTools = flow.always_tools;
  for (const [index, tool] of alwaysTools(flow).entries()) {
    addUsage(
      usages,
      tool,
      "always_tool",
      explicitAlwaysTools ? `always_tools.${index}` : `$implicit.always_tools.${index}`
    );
  }
  const explicitPolicies = flow.always_action_policies;
  for (const [index, policy] of alwaysActionPolicies(flow).entries()) {
    const explicitIndex = explicitPolicies?.findIndex((candidate) => candidate.tool === policy.tool) ?? -1;
    const path = explicitIndex >= 0
      ? `always_action_policies.${explicitIndex}`
      : `$implicit.always_action_policies.${index}`;
    addUsage(usages, policy.tool, "always_action_policy", `${path}.tool`);
    reconciliationDependency(policy, path, usages, diagnostics);
  }
  for (const [nodeIndex, node] of flow.nodes.entries()) {
    for (const [toolIndex, tool] of (node.tools ?? []).entries()) {
      addUsage(usages, tool, "node_tool", `nodes.${nodeIndex}.tools.${toolIndex}`);
    }
  }
  for (const ref of listStepRefs(flow)) {
    for (const [index, tool] of (ref.step.tools ?? []).entries()) {
      addUsage(usages, tool, "step_tool", `${ref.path}.tools.${index}`);
    }
    for (const [index, binding] of (ref.step.output_bindings ?? []).entries()) {
      addUsage(usages, binding.tool, "output_binding", `${ref.path}.output_bindings.${index}.tool`);
    }
    for (const [policyIndex, policy] of (ref.step.action_policies ?? []).entries()) {
      const path = `${ref.path}.action_policies.${policyIndex}`;
      addUsage(usages, policy.tool, "action_policy", `${path}.tool`);
      reconciliationDependency(policy, path, usages, diagnostics);
      for (const [bindingIndex, binding] of (policy.bound_arguments ?? []).entries()) {
        addUsage(
          usages,
          binding.source.tool,
          "bound_argument_source",
          `${path}.bound_arguments.${bindingIndex}.source.tool`
        );
      }
    }
  }

  // Callers that need reconciliation diagnostics use analyzeFlowV2Import. This pure inventory
  // intentionally omits malformed reconciliation contracts instead of guessing a query tool.
  void diagnostics;
  const tools = [...usages.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, entries]) => ({
      name,
      usages: entries
        .sort((left, right) =>
          compareText(left.path, right.path) || compareText(left.kind, right.kind))
        .map((entry) => Object.freeze({ ...entry })),
    }));
  return deepFreeze({ tools });
}

/** Domain-separated canonical digest; object key order and source whitespace do not affect it. */
export function flowV2Digest(flow: AgentFlow): string {
  return createHash("sha256")
    .update(FLOW_DIGEST_DOMAIN, "utf8")
    .update(canonicalJson(flow), "utf8")
    .digest("hex");
}

function reconciliationDiagnostics(flow: AgentFlow): FlowDiagnostic[] {
  const diagnostics: FlowDiagnostic[] = [];
  const unused = new Map<string, MutableUsage[]>();
  for (const [index, policy] of (flow.always_action_policies ?? []).entries()) {
    reconciliationDependency(policy, `always_action_policies.${index}`, unused, diagnostics);
  }
  for (const ref of listStepRefs(flow)) {
    for (const [index, policy] of (ref.step.action_policies ?? []).entries()) {
      reconciliationDependency(policy, `${ref.path}.action_policies.${index}`, unused, diagnostics);
    }
  }
  return diagnostics;
}

function resourceDiagnostics(flow: AgentFlow): FlowDiagnostic[] {
  const diagnostics: FlowDiagnostic[] = [];
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(canonicalJson(flow), "utf8");
  } catch (cause) {
    diagnostics.push(error(
      "$",
      `flow must contain canonical JSON values: ${cause instanceof Error ? cause.message : String(cause)}`
    ));
  }
  const steps = listStepRefs(flow).length;
  const tools = flowToolDependencies(flow).tools.length;
  if (bytes > MAX_FLOW_V2_IMPORT_BYTES) {
    diagnostics.push(error("$", `canonical flow exceeds ${MAX_FLOW_V2_IMPORT_BYTES} bytes`));
  }
  if (flow.nodes.length > MAX_FLOW_V2_IMPORT_NODES) {
    diagnostics.push(error("nodes", `flow exceeds ${MAX_FLOW_V2_IMPORT_NODES} nodes`));
  }
  if (flow.edges.length > MAX_FLOW_V2_IMPORT_EDGES) {
    diagnostics.push(error("edges", `flow exceeds ${MAX_FLOW_V2_IMPORT_EDGES} edges`));
  }
  if (steps > MAX_FLOW_V2_IMPORT_STEPS) {
    diagnostics.push(error("nodes", `flow exceeds ${MAX_FLOW_V2_IMPORT_STEPS} nested steps`));
  }
  if (tools > MAX_FLOW_V2_IMPORT_TOOLS) {
    diagnostics.push(error("$", `flow exceeds ${MAX_FLOW_V2_IMPORT_TOOLS} unique tool dependencies`));
  }
  return diagnostics;
}

function catalogReport(
  dependencies: FlowToolDependencyReport,
  availableTools: readonly string[] | undefined
): FlowCatalogReport {
  const required = dependencies.tools.map((entry) => entry.name);
  if (availableTools === undefined) {
    return deepFreeze({
      status: "not_checked" as const,
      required,
      available: [],
      missing: [],
      unused: [],
    });
  }
  const available = [...new Set(availableTools)].sort(compareText);
  const availableSet = new Set(available);
  const requiredSet = new Set(required);
  const missing = required.filter((name) => !availableSet.has(name));
  const unused = available.filter((name) => !requiredSet.has(name));
  return deepFreeze({
    status: missing.length ? "incomplete" as const : "complete" as const,
    required,
    available,
    missing,
    unused,
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * Validates a raw Flow v2 definition or an immutable export without touching persistence.
 * A plan is install-ready only when the semantic checks pass and an explicit tool catalog
 * proves that every referenced action (including reconciliation queries) is present.
 */
export function analyzeFlowV2Import(
  input: unknown,
  options: Readonly<{ availableTools?: readonly string[] }> = {}
): FlowV2ImportPlan {
  const looksExported = !!input && typeof input === "object" &&
    (input as Record<string, unknown>).format === FLOW_V2_EXPORT_FORMAT;
  const source = looksExported ? "immutable_export" as const : "raw_flow" as const;
  let rawFlow: unknown = input;
  let exported: FlowV2Export | undefined;
  const packageDiagnostics: FlowDiagnostic[] = [];

  if (looksExported) {
    const parsedExport = FlowV2ExportSchema.safeParse(input);
    if (!parsedExport.success) {
      packageDiagnostics.push(...parsedExport.error.issues.map((issue) =>
        error(issue.path.join("."), issue.message)));
      const candidate = input as Record<string, unknown>;
      rawFlow = candidate.flow;
    } else {
      exported = parsedExport.data;
      rawFlow = (input as Record<string, unknown>).flow;
    }
  }

  const validation = validateAgentFlow(rawFlow);
  const diagnostics = [...packageDiagnostics, ...validation.diagnostics];
  const flow = validation.flow;
  if (!flow) {
    return deepFreeze({
      source,
      valid: false,
      readyForInstall: false,
      flowSha256: null,
      diagnostics,
      dependencies: emptyDependencies(),
      catalog: catalogReport(emptyDependencies(), options.availableTools),
    });
  }

  if (flow.schema_version !== 2) {
    diagnostics.push(error("schema_version", "safe import accepts Flow v2 definitions only"));
  }
  if (!sameCanonical(rawFlow, flow)) {
    diagnostics.push(error(
      "$",
      "Flow v2 import must be canonical: unknown fields, implicit defaults, and legacy node aliases are rejected"
    ));
  }
  diagnostics.push(...reconciliationDiagnostics(flow), ...resourceDiagnostics(flow));
  const dependencies = flowToolDependencies(flow);
  let digest: string | null = null;
  try {
    digest = flowV2Digest(flow);
  } catch (cause) {
    diagnostics.push(error(
      "$",
      `flow digest could not be computed: ${cause instanceof Error ? cause.message : String(cause)}`
    ));
  }

  if (exported) {
    if (digest !== null && exported.flow_sha256 !== digest) {
      diagnostics.push(error("flow_sha256", "export digest does not match the canonical Flow v2 definition"));
    }
    if (!sameCanonical(exported.dependencies, dependencies)) {
      diagnostics.push(error("dependencies", "export dependency manifest does not match the Flow v2 definition"));
    }
  }

  const catalog = catalogReport(dependencies, options.availableTools);
  const valid = !diagnostics.some((diagnostic) => diagnostic.level === "error");
  return deepFreeze({
    source,
    valid,
    readyForInstall: valid && catalog.status === "complete",
    flowSha256: digest,
    diagnostics,
    dependencies,
    catalog,
    ...(valid ? { flow: immutableClone(flow) } : {}),
  });
}

/** Builds a deterministic, deep-frozen export suitable for review, signing, and later import. */
export function createImmutableFlowV2Export(input: unknown): FlowV2Export {
  const plan = analyzeFlowV2Import(input);
  if (!plan.valid || !plan.flow || !plan.flowSha256) {
    const reasons = plan.diagnostics
      .filter((diagnostic) => diagnostic.level === "error")
      .map((diagnostic) => `${diagnostic.path || "$"}: ${diagnostic.message}`)
      .join("; ");
    throw new Error(`cannot export invalid Flow v2 definition${reasons ? `: ${reasons}` : ""}`);
  }
  return immutableClone({
    format: FLOW_V2_EXPORT_FORMAT,
    format_version: FLOW_V2_EXPORT_VERSION,
    flow_sha256: plan.flowSha256,
    dependencies: plan.dependencies,
    flow: plan.flow,
  });
}

/** Returns the immutable canonical flow only after catalog-closed dry-run admission succeeds. */
export function materializeFlowV2Import(plan: FlowV2ImportPlan): AgentFlow {
  if (!plan.readyForInstall || !plan.flow) {
    const missing = plan.catalog.missing.length
      ? `; missing tools: ${plan.catalog.missing.join(", ")}`
      : plan.catalog.status === "not_checked"
        ? "; tool catalog was not checked"
        : "";
    throw new Error(`Flow v2 import plan is not install-ready${missing}`);
  }
  return immutableClone(plan.flow);
}

/** Canonical JSON for an immutable export; useful for stable files and detached signatures. */
export function serializeFlowV2Export(value: FlowV2Export): string {
  const plan = analyzeFlowV2Import(value);
  if (!plan.valid) throw new Error("refusing to serialize an invalid or tampered Flow v2 export");
  const parsed = FlowV2ExportSchema.parse(value);
  return canonicalJson(parsed);
}
