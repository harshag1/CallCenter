import {
  ActionReconciliationSpecSchema,
  assertTrustedReconciliationCatalog,
} from "../action-reconciliation";
import type {
  PreparedVoiceToolInvocation,
  VoiceToolExecutionContext,
  VoiceToolExtension,
  VoiceToolPreparedExecutionResult,
  VoiceToolPreflightRejection,
  VoiceToolPreflightRejectionCode,
  VoiceToolPreflightResult,
  VoiceToolScope,
  PinnedVoiceToolDefinition,
} from "./types";
import {
  compileVoiceToolSchema,
  detachBoundedVoiceToolJson,
  normalizeVoiceToolSchema,
  voiceToolAdmissionScopeDigest,
  voiceToolDefinitionDigest,
  voiceToolImplementationDigest,
} from "./schema";
import type { ValidateFunction } from "ajv/dist/2020";

const TOOL_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const RUNTIME_DIGEST = /^[a-f0-9]{64}$/;
const MAX_DESCRIPTION_BYTES = 8 * 1024;
const MAX_GATEWAY_ID_BYTES = 4 * 1024;
const PREPARED_INVOCATION_LEASE_MS = 30_000;

type RegisteredVoiceTool = Readonly<{
  definition: Omit<PinnedVoiceToolDefinition, "admissionScopeDigest">;
  definitionDigest: string;
  inputValidator: ValidateFunction;
  outputValidator?: ValidateFunction;
  isAvailable?: VoiceToolExtension["isAvailable"];
  execute: VoiceToolExtension["execute"];
}>;

type PreparedVoiceToolState = Readonly<{
  status: "prepared";
  tool: RegisteredVoiceTool;
  args: Record<string, unknown>;
  scope: VoiceToolScope;
  context: VoiceToolExecutionContext;
  expiresAt: number;
}>;

type PreparedVoiceToolRecord = PreparedVoiceToolState | Readonly<{ status: "consumed" }>;
const CONSUMED_PREPARED_INVOCATION = Object.freeze({ status: "consumed" as const });

function preflightRejection(
  error: string,
  code: VoiceToolPreflightRejectionCode
): VoiceToolPreflightRejection {
  return Object.freeze({ ok: false, error, code, deliveryState: "not_sent" });
}

function boundedGatewayString(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_GATEWAY_ID_BYTES;
}

function ownDataProperty(
  source: object,
  key: string
): Readonly<{ present: boolean; value?: unknown }> | null {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return { present: false };
  if (!("value" in descriptor)) return null;
  return { present: true, value: descriptor.value };
}

function snapshotScope(scope: VoiceToolScope): VoiceToolScope | null {
  try {
    if (!scope || typeof scope !== "object") return null;
    const callId = ownDataProperty(scope, "callId");
    const agentId = ownDataProperty(scope, "agentId");
    const orgId = ownDataProperty(scope, "orgId");
    if (!callId?.present || !boundedGatewayString(callId.value) || !callId.value ||
        !agentId?.present || !boundedGatewayString(agentId.value) || !agentId.value ||
        !orgId?.present || !boundedGatewayString(orgId.value) || !orgId.value) return null;
    return Object.freeze({ callId: callId.value, agentId: agentId.value, orgId: orgId.value });
  } catch {
    return null;
  }
}

function snapshotContext(context: VoiceToolExecutionContext): VoiceToolExecutionContext | null {
  try {
    if (!context || typeof context !== "object") return null;
    const audience = ownDataProperty(context, "audience");
    const invocationId = ownDataProperty(context, "invocationId");
    const idempotencyKey = ownDataProperty(context, "idempotencyKey");
    const receiptId = ownDataProperty(context, "receiptId");
    const runtimeDigest = ownDataProperty(context, "runtimeDigest");
    if (!audience?.present || typeof audience.value !== "string" ||
        !["flow_action", "background", "direct", "reconciliation"].includes(audience.value) ||
        !invocationId || !idempotencyKey || !receiptId || !runtimeDigest) {
      return null;
    }
    for (const property of [invocationId, idempotencyKey, receiptId]) {
      if (property.present && !boundedGatewayString(property.value)) return null;
    }
    if (runtimeDigest.present &&
        (typeof runtimeDigest.value !== "string" || !RUNTIME_DIGEST.test(runtimeDigest.value))) return null;
    if (
      (audience.value === "flow_action" || audience.value === "reconciliation") &&
      (!runtimeDigest.value || !invocationId.value || !idempotencyKey.value || !receiptId.value)
    ) return null;
    return Object.freeze({
      audience: audience.value as VoiceToolExecutionContext["audience"],
      ...(invocationId.present ? { invocationId: invocationId.value as string } : {}),
      ...(idempotencyKey.present ? { idempotencyKey: idempotencyKey.value as string } : {}),
      ...(receiptId.present ? { receiptId: receiptId.value as string } : {}),
      ...(runtimeDigest.present ? { runtimeDigest: runtimeDigest.value as string } : {}),
    });
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableDefinition(
  extension: VoiceToolExtension
): Omit<PinnedVoiceToolDefinition, "admissionScopeDigest"> {
  if (!TOOL_NAME.test(extension.name)) throw new Error(`invalid voice tool name "${extension.name}"`);
  if (typeof extension.description !== "string" || !extension.description.trim() ||
      Buffer.byteLength(extension.description, "utf8") > MAX_DESCRIPTION_BYTES) {
    throw new Error(`voice tool "${extension.name}" needs a description of at most 8KB`);
  }
  const inputSchema = normalizeVoiceToolSchema(extension.inputSchema, {
    label: `voice tool "${extension.name}" input schema`,
  });
  const outputSchema = extension.outputSchema
    ? normalizeVoiceToolSchema(extension.outputSchema, {
      label: `voice tool "${extension.name}" output schema`,
      requireObjectRoot: false,
    })
    : undefined;
  const reconciliation = extension.reconciliation
    ? deepFreeze(ActionReconciliationSpecSchema.parse(structuredClone(extension.reconciliation)))
    : undefined;
  return Object.freeze({
    name: extension.name,
    description: extension.description,
    implementationDigest: voiceToolImplementationDigest(extension),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(extension.effect ? { effect: extension.effect } : {}),
    ...(reconciliation ? { reconciliation } : {}),
  });
}

export class VoiceToolRegistry {
  private tools: ReadonlyMap<string, RegisteredVoiceTool>;
  private preparedInvocations = new WeakMap<PreparedVoiceToolInvocation, PreparedVoiceToolRecord>();
  private readonly monotonicNow: () => number;

  constructor(
    extensions: VoiceToolExtension[],
    options: Readonly<{ monotonicNow?: () => number }> = {}
  ) {
    const tools = new Map<string, RegisteredVoiceTool>();
    for (const extension of extensions) {
      const definition = immutableDefinition(extension);
      if (tools.has(definition.name)) throw new Error(`duplicate voice tool "${definition.name}"`);
      tools.set(definition.name, Object.freeze({
        definition,
        definitionDigest: voiceToolDefinitionDigest(definition),
        inputValidator: compileVoiceToolSchema(definition.inputSchema),
        ...(definition.outputSchema
          ? { outputValidator: compileVoiceToolSchema(definition.outputSchema) }
          : {}),
        ...(extension.isAvailable ? { isAvailable: extension.isAvailable } : {}),
        execute: extension.execute,
      }));
    }
    assertTrustedReconciliationCatalog([...tools.values()].map((tool) => tool.definition));
    this.tools = tools;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async definitions(scope: VoiceToolScope): Promise<PinnedVoiceToolDefinition[]> {
    const detachedScope = snapshotScope(scope);
    if (!detachedScope) throw new Error("invalid voice tool admission scope");
    const admitted: RegisteredVoiceTool[] = [];
    for (const tool of this.tools.values()) {
      if (tool.isAvailable) {
        try {
          if ((await tool.isAvailable(detachedScope)) !== true) continue;
        } catch {
          continue; // Availability failures can only revoke authority.
        }
      }
      admitted.push(tool);
    }
    const admissionScopeDigest = voiceToolAdmissionScopeDigest(
      detachedScope,
      admitted.map((tool) => ({
        name: tool.definition.name,
        definitionDigest: tool.definitionDigest,
      }))
    );
    return admitted.map((tool) => Object.freeze({
      ...tool.definition,
      admissionScopeDigest,
    }));
  }

  /**
   * Performs the final pre-dispatch admission checks before a durable dispatch
   * boundary. The returned capability owns detached arguments and is short-lived + single-use.
   * Live `isAvailable` may revoke authority, but can never add a tool omitted at call admission.
   */
  async preflightPinned(
    name: string,
    args: Record<string, unknown>,
    scope: VoiceToolScope,
    pinnedDefinition: PinnedVoiceToolDefinition,
    context: VoiceToolExecutionContext,
    pinnedCatalog: readonly PinnedVoiceToolDefinition[]
  ): Promise<VoiceToolPreflightResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return preflightRejection(`unknown extension tool "${name}"`, "unknown_extension_tool");
    }
    const detachedScope = snapshotScope(scope);
    const detachedContext = snapshotContext(context);
    if (!detachedScope || !detachedContext) {
      return preflightRejection(
        `tool "${name}" has an invalid gateway execution binding`,
        "action_not_pinned"
      );
    }
    let pinnedDigest: string;
    try {
      pinnedDigest = voiceToolDefinitionDigest(pinnedDefinition);
      const admittedCatalog = pinnedCatalog.map((definition) => ({
        definition,
        definitionDigest: voiceToolDefinitionDigest(definition),
      }));
      const expectedAdmissionScopeDigest = voiceToolAdmissionScopeDigest(
        detachedScope,
        admittedCatalog.map(({ definition, definitionDigest }) => ({
          name: definition.name,
          definitionDigest,
        }))
      );
      if (
        pinnedDefinition.admissionScopeDigest !== expectedAdmissionScopeDigest ||
        admittedCatalog.some(({ definition }) =>
          definition.admissionScopeDigest !== expectedAdmissionScopeDigest
        ) ||
        !admittedCatalog.some(({ definition, definitionDigest }) =>
          definition.name === name &&
          definitionDigest === pinnedDigest &&
          definition.admissionScopeDigest === pinnedDefinition.admissionScopeDigest
        )
      ) {
        throw new Error("extension is not a member of the admitted catalog");
      }
    } catch {
      return preflightRejection(
        `tool "${name}" has an invalid call-pinned admission catalog`,
        "action_not_pinned"
      );
    }
    if (pinnedDefinition.name !== name || pinnedDigest !== tool.definitionDigest) {
      return preflightRejection(
        `tool "${name}" does not match this call's pinned catalog`,
        "action_not_pinned"
      );
    }
    const detachedArgs = detachBoundedVoiceToolJson(args);
    if (!detachedArgs.ok || !tool.inputValidator(detachedArgs.value)) {
      return preflightRejection(
        `tool "${name}" arguments do not match its pinned input schema`,
        "invalid_action_arguments"
      );
    }
    if (tool.isAvailable) {
      try {
        if ((await tool.isAvailable(detachedScope)) !== true) {
          return preflightRejection(
            `tool "${name}" is unavailable for this call`,
            "extension_unavailable"
          );
        }
      } catch {
        return preflightRejection(
          `tool "${name}" is unavailable for this call`,
          "extension_unavailable"
        );
      }
    }
    const prepared = Object.freeze({}) as PreparedVoiceToolInvocation;
    this.preparedInvocations.set(prepared, Object.freeze({
      status: "prepared" as const,
      tool,
      args: detachedArgs.value as Record<string, unknown>,
      scope: detachedScope,
      context: detachedContext,
      expiresAt: this.monotonicNow() + PREPARED_INVOCATION_LEASE_MS,
    }));
    return Object.freeze({ ok: true, prepared });
  }

  /** Executes exactly one capability returned by this registry's `preflightPinned`. */
  async executePrepared(
    prepared: PreparedVoiceToolInvocation
  ): Promise<VoiceToolPreparedExecutionResult> {
    const state = prepared && typeof prepared === "object"
      ? this.preparedInvocations.get(prepared)
      : undefined;
    if (!state) {
      return Object.freeze({
        ok: false as const,
        executionStarted: false,
        error: "prepared extension invocation is invalid or already consumed",
        code: "invalid_prepared_action" as const,
      });
    }
    if (state.status === "consumed") {
      return Object.freeze({
        ok: false as const,
        executionStarted: true,
        error: "prepared extension invocation was already consumed",
        code: "prepared_action_already_consumed" as const,
      });
    }
    // Tombstone before any await so a concurrent/replayed caller can never claim not-sent while
    // the first consumer may be executing or may already have committed externally.
    this.preparedInvocations.set(prepared, CONSUMED_PREPARED_INVOCATION);
    if (this.monotonicNow() >= state.expiresAt) {
      return Object.freeze({
        ok: false as const,
        executionStarted: false,
        error: "prepared extension invocation expired before execution",
        code: "extension_preflight_expired" as const,
      });
    }
    let output: unknown;
    try {
      output = await state.tool.execute(state.args, state.scope, state.context);
    } catch {
      return Object.freeze({
        ok: false as const,
        executionStarted: true,
        error: `tool "${state.tool.definition.name}" execution failed`,
        code: "extension_execution_failed" as const,
      });
    }
    const detachedOutput = detachBoundedVoiceToolJson(output);
    if (!detachedOutput.ok ||
        (state.tool.outputValidator && !state.tool.outputValidator(detachedOutput.value))) {
      return Object.freeze({
        ok: false as const,
        executionStarted: true,
        error: `tool "${state.tool.definition.name}" returned an invalid bounded output`,
        code: "invalid_action_output" as const,
      });
    }
    return Object.freeze({ ok: true, executionStarted: true, value: detachedOutput.value });
  }

  /** Convenience path for callers without a durable dispatch boundary. */
  async executePinned(
    name: string,
    args: Record<string, unknown>,
    scope: VoiceToolScope,
    pinnedDefinition: PinnedVoiceToolDefinition,
    context: VoiceToolExecutionContext,
    pinnedCatalog: readonly PinnedVoiceToolDefinition[]
  ): Promise<unknown> {
    const preflight = await this.preflightPinned(
      name,
      args,
      scope,
      pinnedDefinition,
      context,
      pinnedCatalog
    );
    if (!preflight.ok) return preflight;
    const execution = await this.executePrepared(preflight.prepared);
    return execution.ok ? execution.value : { error: execution.error, code: execution.code };
  }
}
