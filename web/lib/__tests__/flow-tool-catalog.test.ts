import { describe, expect, it } from "vitest";
import { AgentFlowSchema, alwaysActionPolicies, type AgentFlow } from "../flow";
import {
  BUILT_IN_VOICE_ACTION_EFFECTS,
  BUILT_IN_VOICE_ACTION_NAMES,
  MAX_PROGRESSIVE_FLOW_ACTIVE_TOOLS,
  assertFlowToolCatalogClosure,
  assertUniqueToolCatalog,
  baseBuiltInVoiceActionNames,
  consequentialBuiltInVoiceActionNames,
} from "../flow-tool-catalog";

const remote = "mcp_server_inventory_reserve_deadbeef00";

function flow(overrides: Record<string, unknown> = {}): AgentFlow {
  return AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    always_tools: [],
    always_action_policies: [],
    nodes: [
      { id: "entry", label: "Incoming", kind: "incoming_call" },
      {
        id: "booking",
        label: "Booking",
        kind: "topic",
        steps: [{
          id: "reserve",
          label: "Reserve",
          instructions: "Reserve once.",
          tools: [remote],
          action_policies: [{ tool: remote, idempotency: "per_arguments", max_calls: 1 }],
          output_bindings: [{ output: "reservation_id", tool: remote, result_path: "value.reservation_id" }],
        }],
      },
    ],
    edges: [{ from: "entry", to: "booking" }],
    ...overrides,
  });
}

describe("Flow/MCP catalog closure", () => {
  it("accepts an existing remote action with explicit replay policy and wrapped output path", () => {
    expect(() => assertFlowToolCatalogClosure(flow(), new Set([remote]), new Set([remote])))
      .not.toThrow();
  });

  it("fails admission for a missing remote action", () => {
    expect(() => assertFlowToolCatalogClosure(flow(), new Set(), new Set([remote])))
      .toThrow(/unavailable action/);
  });

  it("forbids idempotency none on opaque remote actions", () => {
    const unsafe = flow();
    unsafe.nodes[1].steps![0].action_policies![0].idempotency = "none";
    expect(() => assertFlowToolCatalogClosure(unsafe, new Set([remote]), new Set([remote])))
      .toThrow(/non-none idempotency/);
  });

  it("requires remote output bindings to use the normalized value root", () => {
    const invalid = flow();
    invalid.nodes[1].steps![0].output_bindings![0].result_path = "reservation_id";
    expect(() => assertFlowToolCatalogClosure(invalid, new Set([remote]), new Set([remote])))
      .toThrow(/must read from value/);
  });

  it("rejects available-but-ungranted bindings and policies", () => {
    const invalidBinding = flow();
    invalidBinding.nodes[1].steps![0].tools = [];
    expect(() => assertFlowToolCatalogClosure(invalidBinding, new Set([remote]), new Set([remote])))
      .toThrow(/not granted/);

    const invalidPolicy = flow();
    invalidPolicy.nodes[1].steps![0].tools = [];
    invalidPolicy.nodes[1].steps![0].output_bindings = [];
    expect(() => assertFlowToolCatalogClosure(invalidPolicy, new Set([remote]), new Set([remote])))
      .toThrow(/not granted/);
  });

  it("reserves progressive control-plane names from business flows", () => {
    for (const reserved of ["run_action", "reconcile_action"]) {
      const invalid = flow();
      invalid.nodes[1].steps![0].tools = [reserved];
      invalid.nodes[1].steps![0].action_policies = [];
      invalid.nodes[1].steps![0].output_bindings = [];
      expect(() => assertFlowToolCatalogClosure(invalid, new Set([reserved]), new Set()))
        .toThrow(/reserved control tool/);
    }
  });

  it("requires replay policy by effect, not only by remote provenance", () => {
    const writeExtension = "write_membership";
    const invalid = flow();
    invalid.nodes[1].steps![0].tools = [writeExtension];
    invalid.nodes[1].steps![0].action_policies = [];
    invalid.nodes[1].steps![0].output_bindings = [];
    expect(() => assertFlowToolCatalogClosure(
      invalid,
      new Set([writeExtension]),
      new Set(),
      new Set([writeExtension])
    )).toThrow(/consequential action/);

    expect(() => assertFlowToolCatalogClosure(
      invalid,
      new Set([writeExtension]),
      new Set(),
      new Set()
    )).not.toThrow();
  });

  it("keeps exhaustive effect metadata for every built-in voice business action", () => {
    expect([...BUILT_IN_VOICE_ACTION_NAMES].sort()).toEqual([
      "contact_support",
      "end_call",
      "hold",
      "launch_task",
      "log_note",
      "play_hold_music",
      "read_table",
      "request_recall",
      "search",
      "search_knowledge",
      "send_email",
      "send_sms",
      "write_table",
    ]);
    expect(BUILT_IN_VOICE_ACTION_EFFECTS).toEqual({
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
    });
    expect([...consequentialBuiltInVoiceActionNames()].sort()).toEqual([
      "contact_support",
      "end_call",
      "launch_task",
      "log_note",
      "request_recall",
      "send_email",
      "send_sms",
      "write_table",
    ]);
    expect([...baseBuiltInVoiceActionNames()].sort()).toEqual([
      "contact_support",
      "end_call",
      "hold",
      "launch_task",
      "log_note",
      "read_table",
      "write_table",
    ]);
  });

  it.each(["request_recall", "send_email", "send_sms"])(
    "rejects new flows that reference operator-approval-only voice action %s",
    (name) => {
      const unavailable = flow({
        always_tools: [name],
        always_action_policies: [{
          tool: name,
          idempotency: "per_call_arguments",
          max_calls: 1,
        }],
      });
      const available = new Set([...baseBuiltInVoiceActionNames(), remote]);
      expect(() => assertFlowToolCatalogClosure(
        unavailable,
        available,
        new Set([remote]),
        consequentialBuiltInVoiceActionNames()
      )).toThrow(`unavailable action "${name}"`);
    }
  );

  it("requires durable replay policy for consequential built-in actions", () => {
    const unsafe = flow();
    unsafe.nodes[1].steps![0].tools = ["send_email"];
    unsafe.nodes[1].steps![0].action_policies = [];
    unsafe.nodes[1].steps![0].output_bindings = [];

    expect(() => assertFlowToolCatalogClosure(
      unsafe,
      new Set(["send_email"]),
      new Set(),
      consequentialBuiltInVoiceActionNames()
    )).toThrow(/consequential action/);

    unsafe.nodes[1].steps![0].action_policies = [{
      tool: "send_email",
      idempotency: "per_call_arguments",
      max_calls: 1,
    }];
    expect(() => assertFlowToolCatalogClosure(
      unsafe,
      new Set(["send_email"]),
      new Set(),
      consequentialBuiltInVoiceActionNames()
    )).not.toThrow();
  });

  it("rejects a flat active context dump and accepts the same actions split into step groups", () => {
    const actions = Array.from({ length: 64 }, (_, index) => `action_${String(index).padStart(2, "0")}`);
    const flat = flow();
    flat.nodes[1].steps![0].tools = actions.slice(0, 13);
    flat.nodes[1].steps![0].action_policies = [];
    flat.nodes[1].steps![0].output_bindings = [];
    expect(() => assertFlowToolCatalogClosure(flat, new Set(actions), new Set()))
      .toThrow(`${MAX_PROGRESSIVE_FLOW_ACTIVE_TOOLS}-tool reliability budget`);

    const grouped = AgentFlowSchema.parse({
      schema_version: 2,
      tool_exposure: "gateway",
      always_tools: [],
      always_action_policies: [],
      nodes: [{
        id: "support",
        label: "Support",
        kind: "topic",
        steps: Array.from({ length: 8 }, (_, group) => ({
          id: `group_${group}`,
          label: `Capability group ${group + 1}`,
          instructions: `Work only in capability group ${group + 1}.`,
          entry: true,
          tools: actions.slice(group * 8, group * 8 + 8),
        })),
      }],
      edges: [],
    });
    expect(() => assertFlowToolCatalogClosure(grouped, new Set(actions), new Set()))
      .not.toThrow();
  });

  it("still checks missing direct-mode Flow v1 tools", () => {
    const direct = AgentFlowSchema.parse({
      schema_version: 1,
      tool_exposure: "direct",
      always_tools: [],
      nodes: [{
        id: "topic",
        label: "Topic",
        kind: "topic",
        steps: [{ id: "work", label: "Work", instructions: "Work.", tools: ["missing_tool"] }],
      }],
      edges: [],
    });
    expect(() => assertFlowToolCatalogClosure(direct, new Set(), new Set()))
      .toThrow(/unavailable action/);
  });

  it("rejects tool collisions with source provenance", () => {
    expect(() => assertUniqueToolCatalog([
      { name: "send_sms", source: "built-in" },
      { name: "send_sms", source: "extension pack billing" },
    ])).toThrow(/built-in and extension pack billing/);
  });
});

describe("flow version/exposure coherence", () => {
  it("gives the default Flow v2 log_note action a call-bound replay policy", () => {
    const parsed = AgentFlowSchema.parse({
      schema_version: 2,
      nodes: [],
      edges: [],
    });
    expect(alwaysActionPolicies(parsed)).toContainEqual({
      tool: "log_note",
      max_calls: 100,
      idempotency: "per_call_arguments",
    });
  });

  it("rejects both cross-version exposure combinations", () => {
    const base = { nodes: [], edges: [] };
    expect(AgentFlowSchema.safeParse({ ...base, schema_version: 2, tool_exposure: "direct" }).success)
      .toBe(false);
    expect(AgentFlowSchema.safeParse({ ...base, schema_version: 1, tool_exposure: "gateway" }).success)
      .toBe(false);
  });
});
