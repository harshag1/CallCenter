import { describe, expect, it, vi } from "vitest";
import { VoiceToolRegistry } from "../voice-tools/registry";
import { composeVoiceToolPacks, defineVoiceToolPack } from "../voice-tools/packs";

const scope = { callId: "call", agentId: "agent", orgId: "org" };
const directContext = { audience: "direct" as const };
const flowContext = {
  audience: "flow_action" as const,
  runtimeDigest: "a".repeat(64),
  invocationId: "invocation",
  idempotencyKey: "idempotency",
  receiptId: "receipt",
};

describe("voice tool extensions", () => {
  it("discovers and executes the exact call-pinned definition", async () => {
    const execute = vi.fn(async (args) => ({ sku: args.sku, available: true }));
    const registry = new VoiceToolRegistry([{
      name: "lookup_inventory",
      description: "Look up one SKU.",
      inputSchema: {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { sku: { type: "string" }, available: { type: "boolean" } },
        required: ["sku", "available"],
        additionalProperties: false,
      },
      effect: "read",
      execute,
    }]);
    const [pinned] = await registry.definitions(scope);
    expect(await registry.executePinned(
      "lookup_inventory",
      { sku: "ABC" },
      scope,
      pinned,
      directContext,
      [pinned]
    )).toEqual({ sku: "ABC", available: true });
    expect(execute).toHaveBeenCalledWith({ sku: "ABC" }, scope, directContext);
  });

  it("supports tenant-aware revocation without granting an omitted tool", async () => {
    let available = false;
    const execute = vi.fn(() => ({ ok: true }));
    const registry = new VoiceToolRegistry([{
      name: "vip_lookup",
      description: "VIP only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      isAvailable: () => available,
      execute,
    }]);
    expect(await registry.definitions(scope)).toEqual([]);

    // A caller can execute only a descriptor actually present in its immutable snapshot. There
    // is no pinned descriptor to pass even if live availability later expands.
    available = true;
    const [currentDefinition] = await registry.definitions({ ...scope, callId: "different-call" });
    expect(await registry.executePinned(
      "vip_lookup", {}, scope, currentDefinition, directContext, [currentDefinition]
    )).toMatchObject({ code: "action_not_pinned" });
    const forged = {
      ...currentDefinition,
      description: "different authority",
    };
    expect(await registry.executePinned(
      "vip_lookup", {}, scope, forged, directContext, [currentDefinition]
    ))
      .toMatchObject({ code: "action_not_pinned" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds every definition to the complete admitted catalog independent of ordering", async () => {
    const registry = new VoiceToolRegistry([{
      name: "catalog_alpha",
      description: "First catalog tool.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ tool: "alpha" }),
    }, {
      name: "catalog_beta",
      description: "Second catalog tool.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ tool: "beta" }),
    }]);
    const catalog = await registry.definitions(scope);
    const alpha = catalog.find((definition) => definition.name === "catalog_alpha")!;
    expect(new Set(catalog.map((definition) => definition.admissionScopeDigest)).size).toBe(1);

    expect(await registry.preflightPinned(
      alpha.name, {}, scope, alpha, directContext, [alpha]
    )).toMatchObject({ ok: false, code: "action_not_pinned", deliveryState: "not_sent" });

    const preflight = await registry.preflightPinned(
      alpha.name, {}, scope, alpha, directContext, [...catalog].reverse()
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error("expected complete catalog admission to succeed");
    expect(await registry.executePrepared(preflight.prepared)).toEqual({
      ok: true,
      executionStarted: true,
      value: { tool: "alpha" },
    });

    const mutatedCatalog = catalog.map((definition) =>
      definition.name === "catalog_beta"
        ? { ...definition, description: "mutated catalog authority" }
        : definition
    );
    expect(await registry.preflightPinned(
      alpha.name, {}, scope, alpha, directContext, mutatedCatalog
    )).toMatchObject({ ok: false, code: "action_not_pinned", deliveryState: "not_sent" });
  });

  it("fails fast on duplicate, unsafe, malformed, or non-portable definitions", () => {
    const tool = {
      name: "valid_tool",
      description: "valid",
      inputSchema: { type: "object", properties: {} },
      execute: () => null,
    };
    expect(() => new VoiceToolRegistry([tool, tool])).toThrow(/duplicate/);
    expect(() => new VoiceToolRegistry([{ ...tool, name: "INVALID TOOL" }])).toThrow(/invalid/);
    expect(() => new VoiceToolRegistry([{ ...tool, inputSchema: {} }])).toThrow(/type "object"/);
    expect(() => new VoiceToolRegistry([{
      ...tool,
      inputSchema: { type: "object", properties: { id: { $ref: "https://example.test/schema" } } },
    }])).toThrow(/non-portable keyword/);
    expect(() => new VoiceToolRegistry([{
      ...tool,
      inputSchema: { type: "object", properties: { id: { type: "string", pattern: "(a+)+$" } } },
    }])).toThrow(/non-portable keyword/);
  });

  it("rejects bad arguments before execution and invalid outputs before success", async () => {
    const execute = vi.fn(() => ({ count: "not-a-number" }));
    const registry = new VoiceToolRegistry([{
      name: "count_items",
      description: "Count items.",
      inputSchema: {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      execute,
    }]);
    const [pinned] = await registry.definitions(scope);
    expect(await registry.executePinned("count_items", {}, scope, pinned, directContext, [pinned]))
      .toMatchObject({ code: "invalid_action_arguments" });
    expect(execute).not.toHaveBeenCalled();

    expect(await registry.executePinned(
      "count_items", { sku: "A" }, scope, pinned, directContext, [pinned]
    ))
      .toMatchObject({ code: "invalid_action_output" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("detaches arguments/results and redacts extension failures", async () => {
    const returned = { ok: true, nested: { value: "original" } };
    const args = { nested: { value: "caller" } };
    const registry = new VoiceToolRegistry([{
      name: "safe_boundary",
      description: "Exercises the extension data boundary.",
      inputSchema: {
        type: "object",
        properties: { nested: { type: "object" } },
        required: ["nested"],
      },
      execute(received) {
        (received.nested as { value: string }).value = "integration-mutated";
        return returned;
      },
    }]);
    const [pinned] = await registry.definitions(scope);
    const result = await registry.executePinned(
      "safe_boundary", args, scope, pinned, directContext, [pinned]
    ) as {
      nested: { value: string };
    };
    expect(args.nested.value).toBe("caller");
    returned.nested.value = "mutated-after-return";
    expect(result.nested.value).toBe("original");

    const throwing = new VoiceToolRegistry([{
      name: "throwing_extension",
      description: "Throws a private provider detail.",
      inputSchema: { type: "object", properties: {} },
      execute() {
        throw new Error("Bearer must-not-reach-the-model");
      },
    }]);
    const [throwingPinned] = await throwing.definitions(scope);
    const failure = await throwing.executePinned(
      "throwing_extension", {}, scope, throwingPinned, directContext, [throwingPinned]
    );
    expect(failure).toMatchObject({ code: "extension_execution_failed" });
    expect(JSON.stringify(failure)).not.toContain("must-not-reach-the-model");
  });

  it("rejects accessor output without invoking it and treats availability errors as revocation", async () => {
    let getterCalls = 0;
    const registry = new VoiceToolRegistry([{
      name: "hostile_output",
      description: "Returns a non-data property.",
      inputSchema: { type: "object", properties: {} },
      execute() {
        return Object.defineProperty({}, "secret", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "private";
          },
        });
      },
    }, {
      name: "broken_availability",
      description: "Fails closed.",
      inputSchema: { type: "object", properties: {} },
      isAvailable() {
        throw new Error("private flag backend detail");
      },
      execute: () => ({ ok: true }),
    }]);
    const definitions = await registry.definitions(scope);
    expect(definitions.map((definition) => definition.name)).toEqual(["hostile_output"]);
    expect(await registry.executePinned(
      "hostile_output", {}, scope, definitions[0], directContext, definitions
    )).toMatchObject({ code: "invalid_action_output" });
    expect(getterCalls).toBe(0);
  });

  it("shares one frozen admission scope and admits only an exact boolean true", async () => {
    const observedOrganizations: string[] = [];
    const registry = new VoiceToolRegistry([{
      name: "mutating_availability",
      description: "Must not mutate shared admission authority.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      isAvailable(candidate) {
        (candidate as { orgId: string }).orgId = "vip";
        return true;
      },
      execute: () => null,
    }, {
      name: "vip_after_mutation",
      description: "VIP only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      isAvailable(candidate) {
        observedOrganizations.push(candidate.orgId);
        return candidate.orgId === "vip";
      },
      execute: () => null,
    }, {
      name: "truthy_availability",
      description: "Non-boolean availability must fail closed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      isAvailable: () => ({ allowed: true }) as unknown as boolean,
      execute: () => null,
    }]);

    expect(await registry.definitions(scope)).toEqual([]);
    expect(observedOrganizations).toEqual(["org"]);
    expect(scope.orgId).toBe("org");
  });

  it("detaches and freezes schema authority at registration", async () => {
    const inputSchema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    const extension = {
      name: "read_record",
      description: "Read one record.",
      inputSchema,
      execute: vi.fn(() => ({ ok: true })),
    };
    const registry = new VoiceToolRegistry([extension]);
    inputSchema.properties.id.type = "number";
    extension.execute = vi.fn(() => ({ ok: false }));

    const [pinned] = await registry.definitions(scope);
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(pinned.inputSchema)).toBe(true);
    expect(await registry.executePinned(
      "read_record", { id: "R-1" }, scope, pinned, directContext, [pinned]
    ))
      .toEqual({ ok: true });
  });

  it("recursively freezes pinned reconciliation authority", async () => {
    const registry = new VoiceToolRegistry([{
      name: "commit_record",
      description: "Commit one record.",
      inputSchema: {
        type: "object",
        properties: { record_id: { type: "string" } },
        required: ["record_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { record_id: { type: "string" } },
        required: ["record_id"],
        additionalProperties: false,
      },
      effect: "write",
      reconciliation: {
        queryTool: "lookup_record",
        queryArguments: {
          invocation_id: { source: "invocation_id" },
          record_id: { source: "action_argument", path: "record_id" },
        },
        committedWhen: [
          { resultPath: "invocation_id", equals: { source: "invocation_id" } },
          { resultPath: "status", equals: { source: "literal", value: "committed" } },
        ],
        absentWhen: [
          { resultPath: "invocation_id", equals: { source: "invocation_id" } },
          { resultPath: "status", equals: { source: "literal", value: "absent" } },
        ],
        authoritativeResultPath: "result",
        maxProofAttempts: 3,
      },
      execute: () => ({ record_id: "record" }),
    }, {
      name: "lookup_record",
      description: "Look up one committed record.",
      inputSchema: {
        type: "object",
        properties: {
          invocation_id: { type: "string" },
          record_id: { type: "string" },
        },
        required: ["invocation_id", "record_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          invocation_id: { type: "string" },
          status: { type: "string" },
          result: { type: "object" },
        },
        required: ["invocation_id", "status", "result"],
        additionalProperties: false,
      },
      effect: "read",
      execute: () => ({ invocation_id: "invocation", status: "absent", result: {} }),
    }]);
    const definitions = await registry.definitions(scope);
    const action = definitions.find((definition) => definition.name === "commit_record")!;
    expect(Object.isFrozen(action.reconciliation)).toBe(true);
    expect(Object.isFrozen(action.reconciliation?.queryArguments)).toBe(true);
    expect(Object.isFrozen(action.reconciliation?.queryArguments.invocation_id)).toBe(true);
    expect(Object.isFrozen(action.reconciliation?.committedWhen[0].equals)).toBe(true);
    expect(() => {
      (action.reconciliation!.queryArguments.invocation_id as { source: string }).source = "literal";
    }).toThrow();
  });

  it("requires runtime binding for flow and reconciliation execution", async () => {
    const registry = new VoiceToolRegistry([{
      name: "write_record",
      description: "Write one record.",
      inputSchema: { type: "object", properties: {} },
      effect: "write",
      execute: () => ({ ok: true }),
    }]);
    const [pinned] = await registry.definitions(scope);
    expect(await registry.executePinned(
      "write_record", {}, scope, pinned, { audience: "flow_action" }, [pinned]
    )).toMatchObject({ code: "action_not_pinned" });
    expect(await registry.executePinned(
      "write_record", {}, scope, pinned,
      { audience: "flow_action", runtimeDigest: "a".repeat(64) },
      [pinned]
    )).toMatchObject({ code: "action_not_pinned" });
    expect(await registry.executePinned(
      "write_record",
      {},
      scope,
      pinned,
      {
        audience: "flow_action",
        runtimeDigest: "a".repeat(64),
        invocationId: "invocation",
        idempotencyKey: "idempotency",
        receiptId: "receipt",
      },
      [pinned]
    )).toEqual({ ok: true });
  });

  it("rejects deterministic extension failures before dispatch with not-sent evidence", async () => {
    const execute = vi.fn(() => ({ ok: true }));
    const isAvailable = vi.fn(() => true);
    const registry = new VoiceToolRegistry([{
      name: "preflight_write",
      description: "Exercise pre-dispatch checks.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      effect: "write",
      isAvailable,
      execute,
    }]);
    const [pinned] = await registry.definitions(scope);
    isAvailable.mockClear();

    const badArguments = await registry.preflightPinned(
      "preflight_write",
      {},
      scope,
      pinned,
      flowContext,
      [pinned]
    );
    expect(badArguments).toEqual({
      ok: false,
      error: "tool \"preflight_write\" arguments do not match its pinned input schema",
      code: "invalid_action_arguments",
      deliveryState: "not_sent",
    });
    expect(isAvailable).not.toHaveBeenCalled();

    const drifted = await registry.preflightPinned(
      "preflight_write",
      { value: "ok" },
      scope,
      { ...pinned, description: "forged authority" },
      flowContext,
      [pinned]
    );
    expect(drifted).toMatchObject({
      ok: false,
      code: "action_not_pinned",
      deliveryState: "not_sent",
    });

    isAvailable.mockReturnValue(false);
    expect(await registry.preflightPinned(
      "preflight_write",
      { value: "ok" },
      scope,
      pinned,
      flowContext,
      [pinned]
    )).toMatchObject({
      ok: false,
      code: "extension_unavailable",
      deliveryState: "not_sent",
    });
    isAvailable.mockImplementation(() => {
      throw new Error("private availability backend detail");
    });
    const availabilityFailure = await registry.preflightPinned(
      "preflight_write",
      { value: "ok" },
      scope,
      pinned,
      flowContext,
      [pinned]
    );
    expect(availabilityFailure).toMatchObject({
      ok: false,
      code: "extension_unavailable",
      deliveryState: "not_sent",
    });
    expect(JSON.stringify(availabilityFailure)).not.toContain("private availability");

    expect(await registry.preflightPinned(
      "preflight_write",
      { value: "ok" },
      scope,
      pinned,
      { ...flowContext, runtimeDigest: "A".repeat(64) },
      [pinned]
    )).toMatchObject({
      ok: false,
      code: "action_not_pinned",
      deliveryState: "not_sent",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("prepares one detached, registry-bound execution without rechecking availability", async () => {
    const isAvailable = vi.fn(() => true);
    const execute = vi.fn((args, executionScope, context) => ({
      value: (args.nested as { value: string }).value,
      callId: executionScope.callId,
      runtimeDigest: context?.runtimeDigest,
    }));
    const registry = new VoiceToolRegistry([{
      name: "prepared_write",
      description: "Exercise prepared execution.",
      inputSchema: {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        required: ["nested"],
        additionalProperties: false,
      },
      isAvailable,
      execute,
    }]);
    const [pinned] = await registry.definitions(scope);
    isAvailable.mockClear();
    const mutableArgs = { nested: { value: "admitted" } };
    const mutableScope = { ...scope };
    const mutableContext = {
      audience: "flow_action" as const,
      runtimeDigest: "b".repeat(64),
      invocationId: "invocation-1",
      idempotencyKey: "idempotency-1",
      receiptId: "receipt-1",
    };
    const preflight = await registry.preflightPinned(
      "prepared_write",
      mutableArgs,
      mutableScope,
      pinned,
      mutableContext,
      [pinned]
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error("expected preflight to succeed");

    mutableArgs.nested.value = "mutated";
    mutableScope.callId = "different-call";
    mutableContext.runtimeDigest = "c".repeat(64);
    isAvailable.mockReturnValue(false);

    expect(await registry.executePrepared(preflight.prepared)).toEqual({
      ok: true,
      executionStarted: true,
      value: {
        value: "admitted",
        callId: "call",
        runtimeDigest: "b".repeat(64),
      },
    });
    expect(isAvailable).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(Object.isFrozen(execute.mock.calls[0][1])).toBe(true);
    expect(Object.isFrozen(execute.mock.calls[0][2])).toBe(true);
    expect(await registry.executePrepared(preflight.prepared)).toMatchObject({
      ok: false,
      executionStarted: true,
      code: "prepared_action_already_consumed",
    });

    const otherRegistry = new VoiceToolRegistry([]);
    expect(await otherRegistry.executePrepared(preflight.prepared)).toMatchObject({
      ok: false,
      executionStarted: false,
      code: "invalid_prepared_action",
    });
  });

  it("expires prepared capabilities and makes executePinned use the shared preflight path", async () => {
    let now = 1_000;
    const registry = new VoiceToolRegistry([{
      name: "leased_read",
      description: "Exercise prepared leases.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ ok: true }),
    }], { monotonicNow: () => now });
    const [pinned] = await registry.definitions(scope);
    const preflight = await registry.preflightPinned(
      "leased_read",
      {},
      scope,
      pinned,
      directContext,
      [pinned]
    );
    if (!preflight.ok) throw new Error("expected preflight to succeed");
    now = 31_000;
    expect(await registry.executePrepared(preflight.prepared)).toMatchObject({
      ok: false,
      executionStarted: false,
      code: "extension_preflight_expired",
    });

    const preflightSpy = vi.spyOn(registry, "preflightPinned");
    expect(await registry.executePinned(
      "leased_read", {}, scope, pinned, directContext, [pinned]
    ))
      .toEqual({ ok: true });
    expect(preflightSpy).toHaveBeenCalledOnce();
  });

  it("tombstones a prepared capability before awaiting extension execution", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { committed: true };
    });
    const registry = new VoiceToolRegistry([{
      name: "concurrent_write",
      description: "Exercise concurrent prepared replay.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute,
    }]);
    const [pinned] = await registry.definitions(scope);
    const preflight = await registry.preflightPinned(
      "concurrent_write",
      {},
      scope,
      pinned,
      directContext,
      [pinned]
    );
    if (!preflight.ok) throw new Error("expected preflight to succeed");

    const first = registry.executePrepared(preflight.prepared);
    expect(await registry.executePrepared(preflight.prepared)).toMatchObject({
      ok: false,
      executionStarted: true,
      code: "prepared_action_already_consumed",
    });
    release();
    expect(await first).toEqual({
      ok: true,
      executionStarted: true,
      value: { committed: true },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps extension-owned error-shaped output separate from framework failure metadata", async () => {
    const registry = new VoiceToolRegistry([{
      name: "business_error_record",
      description: "Return error-shaped business data.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { error: { type: "string" }, code: { type: "string" } },
        required: ["error", "code"],
        additionalProperties: false,
      },
      execute: () => ({ error: "customer supplied note", code: "BUSINESS_VALUE" }),
    }]);
    const [pinned] = await registry.definitions(scope);
    const preflight = await registry.preflightPinned(
      "business_error_record",
      {},
      scope,
      pinned,
      directContext,
      [pinned]
    );
    if (!preflight.ok) throw new Error("expected preflight to succeed");
    expect(await registry.executePrepared(preflight.prepared)).toEqual({
      ok: true,
      executionStarted: true,
      value: { error: "customer supplied note", code: "BUSINESS_VALUE" },
    });
    expect(await registry.executePinned(
      "business_error_record",
      {},
      scope,
      pinned,
      directContext,
      [pinned]
    )).toEqual({ error: "customer supplied note", code: "BUSINESS_VALUE" });
  });

  it("composes independently versioned tool packs and rejects duplicate pack identity", () => {
    const tool = {
      name: "pack_lookup",
      description: "Lookup from a pack.",
      inputSchema: { type: "object", properties: {} },
      execute: () => ({ ok: true }),
    };
    const pack = defineVoiceToolPack({ id: "inventory.core", version: "1.2.0", tools: [tool] });
    expect(composeVoiceToolPacks([pack])).toEqual([{
      ...tool,
      implementationRevision: "inventory.core@1.2.0:default",
    }]);
    expect(() => composeVoiceToolPacks([pack, pack])).toThrow(/duplicate voice tool pack/);
    expect(() => defineVoiceToolPack({ id: "Invalid Pack", version: "1", tools: [] }))
      .toThrow(/pack id/);
  });

  it("binds pack versions into the call-pinned implementation digest", async () => {
    const tool = {
      name: "dependency_lookup",
      description: "Uses an imported dependency.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ ok: true }),
    };
    const v1 = new VoiceToolRegistry(composeVoiceToolPacks([
      defineVoiceToolPack({ id: "dependency.pack", version: "1.0.0", tools: [tool] }),
    ]));
    const v2 = new VoiceToolRegistry(composeVoiceToolPacks([
      defineVoiceToolPack({ id: "dependency.pack", version: "1.0.1", tools: [tool] }),
    ]));
    const [v1Definition] = await v1.definitions(scope);
    const [v2Definition] = await v2.definitions(scope);
    expect(v1Definition.implementationDigest).not.toBe(v2Definition.implementationDigest);
    expect(await v2.executePinned(
      tool.name,
      {},
      scope,
      v1Definition,
      directContext,
      [v1Definition]
    )).toMatchObject({ code: "action_not_pinned" });
  });
});
