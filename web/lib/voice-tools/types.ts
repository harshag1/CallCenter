import type { ActionReconciliationSpec } from "../action-reconciliation";

export type VoiceToolScope = Readonly<{ callId: string; agentId: string; orgId: string }>;

export type VoiceToolExecutionContext = Readonly<{
  audience: "flow_action" | "background" | "direct" | "reconciliation";
  /** Gateway-generated identity; never copied from model/provider arguments. */
  invocationId?: string;
  idempotencyKey?: string;
  receiptId?: string;
  runtimeDigest?: string;
}>;

export type VoiceToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Only trusted source extensions may declare read-only proof tools. */
  readonly effect?: "read" | "write" | "opaque";
  readonly reconciliation?: ActionReconciliationSpec;
};

/** Extension definition admitted to a call with its exact loaded implementation pinned. */
export type PinnedVoiceToolDefinition = VoiceToolDefinition & Readonly<{
  implementationDigest: string;
  /** Complete admitted extension catalog bound to call + agent + organization identity. */
  admissionScopeDigest: string;
}>;

declare const preparedVoiceToolInvocationBrand: unique symbol;

/**
 * Opaque, registry-bound permission to execute arguments that already passed the final
 * pre-dispatch admission checks. It cannot be constructed, inspected, reused, or moved between
 * registries by integrations.
 */
export type PreparedVoiceToolInvocation = Readonly<{
  [preparedVoiceToolInvocationBrand]: true;
}>;

export type VoiceToolPreflightRejectionCode =
  | "unknown_extension_tool"
  | "action_not_pinned"
  | "extension_unavailable"
  | "invalid_action_arguments";

export type VoiceToolPreflightRejection = Readonly<{
  ok: false;
  error: string;
  code: VoiceToolPreflightRejectionCode;
  /** The registry did not invoke the extension's `execute` function. */
  deliveryState: "not_sent";
}>;

export type VoiceToolPreflightResult =
  | VoiceToolPreflightRejection
  | Readonly<{ ok: true; prepared: PreparedVoiceToolInvocation }>;

export type VoiceToolPreparedExecutionFailureCode =
  | "invalid_prepared_action"
  | "prepared_action_already_consumed"
  | "extension_preflight_expired"
  | "extension_execution_failed"
  | "invalid_action_output";

/**
 * Separates framework outcome metadata from extension-owned JSON. Durable callers must use
 * `executionStarted` to classify post-dispatch uncertainty; an extension may legitimately return
 * an object containing `error` or `code` as ordinary business data.
 */
export type VoiceToolPreparedExecutionResult =
  | Readonly<{ ok: true; executionStarted: true; value: unknown }>
  | Readonly<{
      ok: false;
      executionStarted: boolean;
      error: string;
      code: VoiceToolPreparedExecutionFailureCode;
    }>;

export type VoiceToolExtension = VoiceToolDefinition & {
  /**
   * Trusted deploy/package revision included in the implementation digest. Tool packs
   * supply this automatically; bump it when imported helpers or authorization change.
   */
  readonly implementationRevision?: string;
  /** Optional tenant/call-aware availability check. */
  readonly isAvailable?: (scope: VoiceToolScope) => boolean | Promise<boolean>;
  readonly execute: (
    args: Record<string, unknown>,
    scope: VoiceToolScope,
    context?: VoiceToolExecutionContext
  ) => unknown | Promise<unknown>;
};
