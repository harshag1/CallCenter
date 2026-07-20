import {
  alwaysActionPolicies,
  alwaysTools,
  listStepRefs,
  type AgentFlow,
} from "./flow";

export const FLOW_CONTROL_TOOL_NAMES = new Set([
  "begin_step",
  "classify",
  "complete_step",
  "enter_step",
  "get_flow_state",
  "reconcile_action",
  "run_action",
]);

/** Human/realtime reliability budget; the transport layer has a larger emergency safety cap. */
export const MAX_PROGRESSIVE_FLOW_ACTIVE_TOOLS = 16;

export type BuiltInVoiceActionEffect = "read" | "transient" | "write" | "external";

/**
 * Exhaustive effect metadata for every non-control action declared by the voice gateway.
 * `write` and `external` actions require explicit durable idempotency in Flow v2.
 */
export const BUILT_IN_VOICE_ACTION_EFFECTS = Object.freeze({
  hold: "transient",
  play_hold_music: "transient",
  read_table: "read",
  search: "read",
  search_knowledge: "read",
  write_table: "write",
  log_note: "write",
  launch_task: "write",
  contact_support: "external",
  request_recall: "external",
  end_call: "external",
  send_email: "external",
  send_sms: "external",
} satisfies Record<string, BuiltInVoiceActionEffect>);

export type BuiltInVoiceActionName = keyof typeof BUILT_IN_VOICE_ACTION_EFFECTS;

export const BUILT_IN_VOICE_ACTION_NAMES: readonly BuiltInVoiceActionName[] = Object.freeze(
  Object.keys(BUILT_IN_VOICE_ACTION_EFFECTS) as BuiltInVoiceActionName[]
);

const FEATURE_GATED_BUILT_IN_VOICE_ACTION_NAMES: readonly BuiltInVoiceActionName[] = Object.freeze([
  "play_hold_music",
  "search",
  "search_knowledge",
]);
const OPERATOR_APPROVAL_ONLY_BUILT_IN_VOICE_ACTION_NAMES: readonly BuiltInVoiceActionName[] = Object.freeze([
  "request_recall",
  "send_email",
  "send_sms",
]);

/** Base catalog derived from the same exhaustive metadata as effect admission. */
export function baseBuiltInVoiceActionNames(): ReadonlySet<BuiltInVoiceActionName> {
  return new Set(BUILT_IN_VOICE_ACTION_NAMES.filter((name) =>
    !FEATURE_GATED_BUILT_IN_VOICE_ACTION_NAMES.includes(name)
    && !OPERATOR_APPROVAL_ONLY_BUILT_IN_VOICE_ACTION_NAMES.includes(name)
  ));
}

/** Exact source of truth used by call admission; do not duplicate a hand-maintained risk set. */
export function consequentialBuiltInVoiceActionNames(): ReadonlySet<BuiltInVoiceActionName> {
  return new Set((Object.entries(BUILT_IN_VOICE_ACTION_EFFECTS) as [
    BuiltInVoiceActionName,
    BuiltInVoiceActionEffect,
  ][])
    .filter(([, effect]) => effect === "write" || effect === "external")
    .map(([name]) => name));
}

export type ToolCatalogIdentity = Readonly<{ name: string; source: string }>;

/** Preserves source provenance long enough to reject precedence-dependent tool collisions. */
export function assertUniqueToolCatalog(entries: readonly ToolCatalogIdentity[]): void {
  const byName = new Map<string, string>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (existing) {
      throw new Error(`voice tool name collision: "${entry.name}" is declared by ${existing} and ${entry.source}`);
    }
    byName.set(entry.name, entry.source);
  }
}

/** Fails call admission before a missing or unsafe action can deadlock a durable flow. */
export function assertFlowToolCatalogClosure(
  flow: AgentFlow,
  availableNames: ReadonlySet<string>,
  remoteNames: ReadonlySet<string>,
  consequentialNames: ReadonlySet<string> = remoteNames
): void {
  const durableGateway = flow.schema_version === 2;
  const ensureAvailable = (name: string) => {
    if (FLOW_CONTROL_TOOL_NAMES.has(name)) {
      throw new Error(`Flow business catalog cannot grant reserved control tool "${name}"`);
    }
    if (!availableNames.has(name)) {
      throw new Error(`Flow references unavailable action "${name}"`);
    }
  };
  const callWideTools = new Set(alwaysTools(flow));
  const assertProgressiveBudget = (businessNames: ReadonlySet<string>, location: string, controls: number) => {
    if (!durableGateway) return;
    const disclosed = businessNames.size + controls;
    if (disclosed > MAX_PROGRESSIVE_FLOW_ACTIVE_TOOLS) {
      throw new Error(
        `${location} would disclose ${disclosed} active capabilities, exceeding the ` +
        `${MAX_PROGRESSIVE_FLOW_ACTIVE_TOOLS}-tool reliability budget; split actions across hierarchical steps`
      );
    }
  };
  // Routing exposes classify/get-state; terminal recovery exposes fewer controls.
  assertProgressiveBudget(callWideTools, "initial flow routing", 2);
  const globalPolicies = alwaysActionPolicies(flow);
  for (const name of callWideTools) ensureAvailable(name);
  for (const policy of globalPolicies) {
    ensureAvailable(policy.tool);
    if (!callWideTools.has(policy.tool)) {
      throw new Error(`global action policy tool "${policy.tool}" is not granted in always_tools`);
    }
  }
  for (const consequentialName of [...callWideTools].filter((name) => consequentialNames.has(name))) {
    const policy = globalPolicies.find((candidate) => candidate.tool === consequentialName);
    if (!durableGateway) continue;
    if (!policy || !policy.idempotency || policy.idempotency === "none") {
      throw new Error(
        `always-available consequential action "${consequentialName}" requires an explicit non-none idempotency policy`
      );
    }
  }
  for (const node of flow.nodes) {
    for (const name of node.tools ?? []) ensureAvailable(name);
    assertProgressiveBudget(new Set([...callWideTools, ...(node.tools ?? [])]), `topic "${node.id}"`, 2);
  }
  for (const ref of listStepRefs(flow)) {
    const node = flow.nodes.find((candidate) => candidate.id === ref.nodeId);
    const granted = new Set([
      ...callWideTools,
      ...(node?.tools ?? []),
      ...ref.ancestors.flatMap((ancestor) => ancestor.tools ?? []),
      ...(ref.step.tools ?? []),
    ]);
    // complete/retry, get-state, transition entry, and receipt reconciliation are the
    // worst-case four controls; a concrete runtime state will usually disclose fewer.
    assertProgressiveBudget(granted, `step "${ref.path}"`, 4);
    for (const name of granted) ensureAvailable(name);
    for (const binding of ref.step.output_bindings ?? []) {
      ensureAvailable(binding.tool);
      if (!granted.has(binding.tool)) {
        throw new Error(`output binding tool "${binding.tool}" is not granted at ${ref.path}`);
      }
      if (remoteNames.has(binding.tool) &&
          binding.result_path !== "value" && !binding.result_path.startsWith("value.")) {
        throw new Error(`remote MCP output binding "${binding.output}" must read from value`);
      }
    }
    for (const policy of ref.step.action_policies ?? []) {
      ensureAvailable(policy.tool);
      if (!granted.has(policy.tool)) {
        throw new Error(`action policy tool "${policy.tool}" is not granted at ${ref.path}`);
      }
    }
    for (const consequentialName of [...granted].filter((name) => consequentialNames.has(name))) {
      if (!durableGateway) continue;
      const policy = ref.step.action_policies?.find((candidate) => candidate.tool === consequentialName)
        ?? (callWideTools.has(consequentialName)
          ? globalPolicies.find((candidate) => candidate.tool === consequentialName)
          : undefined);
      if (!policy || !policy.idempotency || policy.idempotency === "none") {
        throw new Error(
          `consequential action "${consequentialName}" requires an explicit non-none idempotency policy at ${ref.path}`
        );
      }
    }
  }
}
