import { z } from "zod";
import { defineVoiceToolPack, type VoiceToolPack } from "../voice-tools/packs";
import type {
  VoiceToolExecutionContext,
  VoiceToolScope,
} from "../voice-tools/types";
import {
  VoiceWorkerCapabilityManifestSchema,
  VoiceWorkerFactDependencySchema,
  VoiceWorkerInputSchema,
  VoiceWorkerStatusSchema,
  hashVoiceWorkerValue,
  type VoiceWorkerCapabilityManifest,
  type VoiceWorkerInput,
} from "./schema";

const SHA256 = /^[a-f0-9]{64}$/;
const RECIPE_ID = /^[a-z][a-z0-9_.-]{1,63}$/;
const WORKER_KIND = /^[a-z][a-z0-9_.-]{1,63}$/;
const BOUNDED_ID = z.string().trim().min(1).max(256);

export const GOVERNED_WORKER_TOOL_NAMES = Object.freeze({
  spawn: "spawn_voice_worker",
  status: "get_voice_worker_status",
  cancel: "cancel_voice_worker",
  reconcile: "reconcile_voice_worker",
  deliverResult: "deliver_voice_worker_result",
} as const);

export type GovernedWorkerOperation = keyof typeof GOVERNED_WORKER_TOOL_NAMES;

const GovernedWorkerOperationSchema = z.enum([
  "spawn",
  "status",
  "cancel",
  "reconcile",
  "deliverResult",
]);

/**
 * A policy-engine receipt, loaded by trusted host code for one gateway
 * invocation. It binds the current conversation head and allowed worker
 * operations; none of these fields are accepted from model tool arguments.
 */
export const GovernedWorkerAuthorityReceiptSchema = z.object({
  v: z.literal(1),
  receiptId: BOUNDED_ID,
  invocationId: BOUNDED_ID,
  runtimeDigest: z.string().regex(SHA256),
  organizationId: BOUNDED_ID,
  agentId: BOUNDED_ID,
  agentVersion: z.number().int().positive(),
  callId: BOUNDED_ID,
  conversationId: z.uuid(),
  conversationHeadSha256: z.string().regex(SHA256),
  conversationRevision: z.number().int().nonnegative(),
  goalId: z.string().regex(/^[a-z][a-z0-9_.:-]{1,127}$/),
  policyEpoch: z.number().int().nonnegative(),
  factDependencies: z.array(VoiceWorkerFactDependencySchema).max(64),
  allowedOperations: z.array(GovernedWorkerOperationSchema).min(1).max(5),
  allowedRecipeIds: z.array(z.string().regex(RECIPE_ID)).max(64),
  allowedWorkerIds: z.array(z.uuid()).max(256).optional(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict().superRefine((receipt, context) => {
  if (new Set(receipt.allowedOperations).size !== receipt.allowedOperations.length) {
    context.addIssue({ code: "custom", path: ["allowedOperations"], message: "operations must be unique" });
  }
  if (new Set(receipt.allowedRecipeIds).size !== receipt.allowedRecipeIds.length) {
    context.addIssue({ code: "custom", path: ["allowedRecipeIds"], message: "recipe identities must be unique" });
  }
  if (receipt.allowedWorkerIds &&
      new Set(receipt.allowedWorkerIds).size !== receipt.allowedWorkerIds.length) {
    context.addIssue({ code: "custom", path: ["allowedWorkerIds"], message: "worker identities must be unique" });
  }
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "authority expiry must follow issuance" });
  }
});

export type GovernedWorkerAuthorityReceipt = z.infer<typeof GovernedWorkerAuthorityReceiptSchema>;

export type GovernedWorkerRecipe = Readonly<{
  id: string;
  workerKind: string;
  capabilityManifest: VoiceWorkerCapabilityManifest;
  /**
   * Optional trusted recipe parser. It can narrow or derive worker input but
   * must return a valid VoiceWorkerInput. Bump the tool-pack version whenever
   * this implementation changes.
   */
  prepareInput?: (input: VoiceWorkerInput) => unknown | Promise<unknown>;
}>;

type RegisteredGovernedWorkerRecipe = Readonly<{
  id: string;
  workerKind: string;
  capabilityManifest: VoiceWorkerCapabilityManifest;
  capabilityManifestSha256: string;
  prepareInput?: GovernedWorkerRecipe["prepareInput"];
}>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class GovernedWorkerRecipeRegistry {
  readonly #recipes: ReadonlyMap<string, RegisteredGovernedWorkerRecipe>;

  constructor(recipes: readonly GovernedWorkerRecipe[]) {
    if (recipes.length === 0 || recipes.length > 64) {
      throw new Error("governed worker registry requires 1 to 64 recipes");
    }
    const entries = new Map<string, RegisteredGovernedWorkerRecipe>();
    for (const recipe of recipes) {
      if (!RECIPE_ID.test(recipe.id)) throw new Error(`invalid governed worker recipe "${recipe.id}"`);
      if (!WORKER_KIND.test(recipe.workerKind)) throw new Error(`invalid governed worker kind "${recipe.workerKind}"`);
      if (entries.has(recipe.id)) throw new Error(`duplicate governed worker recipe "${recipe.id}"`);
      const capabilityManifest = VoiceWorkerCapabilityManifestSchema.parse(
        structuredClone(recipe.capabilityManifest)
      );
      entries.set(recipe.id, Object.freeze({
        id: recipe.id,
        workerKind: recipe.workerKind,
        capabilityManifest: deepFreeze(capabilityManifest),
        capabilityManifestSha256: hashVoiceWorkerValue(capabilityManifest),
        ...(recipe.prepareInput ? { prepareInput: recipe.prepareInput } : {}),
      }));
    }
    this.#recipes = entries;
  }

  get(recipeId: string): RegisteredGovernedWorkerRecipe {
    const recipe = this.#recipes.get(recipeId);
    if (!recipe) throw new Error(`unknown governed worker recipe "${recipeId}"`);
    return recipe;
  }

  list(): readonly Readonly<{
    id: string;
    workerKind: string;
    capabilityManifestSha256: string;
  }>[] {
    return Object.freeze([...this.#recipes.values()].map((recipe) => Object.freeze({
      id: recipe.id,
      workerKind: recipe.workerKind,
      capabilityManifestSha256: recipe.capabilityManifestSha256,
    })));
  }
}

export const GovernedWorkerSnapshotSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  organizationId: BOUNDED_ID,
  workerKind: z.string().regex(WORKER_KIND),
  status: VoiceWorkerStatusSchema,
  authoritySha256: z.string().regex(SHA256),
  inputSha256: z.string().regex(SHA256),
  capabilityManifestSha256: z.string().regex(SHA256),
  cancellationEpoch: z.number().int().nonnegative(),
  claimedCancellationEpoch: z.number().int().nonnegative().nullable(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  dispatchStartedAt: z.iso.datetime().nullable(),
  checkpoint: z.object({
    phase: z.string().trim().min(1).max(128),
    progress: z.number().min(0).max(1),
    checkpointSha256: z.string().regex(SHA256),
  }).strict().nullable(),
  resultSha256: z.string().regex(SHA256).nullable(),
  settledAt: z.iso.datetime().nullable(),
}).strict();

export type GovernedWorkerSnapshot = z.infer<typeof GovernedWorkerSnapshotSchema>;

const ReconciliationDispositionSchema = z.enum([
  "not_required",
  "reclaimed_before_dispatch",
  "indeterminate",
  "resolved_succeeded",
  "resolved_failed",
  "resolved_cancelled",
]);

export type GovernedWorkerReconciliation = Readonly<{
  worker: GovernedWorkerSnapshot;
  disposition: z.infer<typeof ReconciliationDispositionSchema>;
  evidenceSha256: string | null;
  reason: string | null;
}>;

const DeliveryDispositionSchema = z.enum([
  "not_ready",
  "accepted",
  "deferred",
  "rejected",
  "duplicate",
]);

export type GovernedWorkerResultDelivery = Readonly<{
  worker: GovernedWorkerSnapshot;
  messageId: string;
  disposition: z.infer<typeof DeliveryDispositionSchema>;
  resultSha256: string | null;
  conversationEventId: string | null;
  conversationEventSha256: string | null;
  reason: string | null;
}>;

export type GovernedWorkerBackend = Readonly<{
  spawn(input: Readonly<{
    authority: GovernedWorkerAuthorityReceipt;
    recipe: RegisteredGovernedWorkerRecipe;
    workerInput: VoiceWorkerInput;
    idempotencyKey: string;
  }>): Promise<GovernedWorkerSnapshot>;
  status(input: Readonly<{
    authority: GovernedWorkerAuthorityReceipt;
    workerId: string;
  }>): Promise<GovernedWorkerSnapshot | null>;
  cancel(input: Readonly<{
    authority: GovernedWorkerAuthorityReceipt;
    workerId: string;
    idempotencyKey: string;
  }>): Promise<GovernedWorkerSnapshot>;
  /**
   * Repairs executor state after lease loss. A post-dispatch lease loss must
   * become indeterminate until authoritative read-back proves a terminal result;
   * it must never silently re-run an opaque effect.
   */
  reconcile(input: Readonly<{
    authority: GovernedWorkerAuthorityReceipt;
    workerId: string;
    idempotencyKey: string;
  }>): Promise<GovernedWorkerReconciliation>;
  /**
   * Proposes one immutable inbox result to the conversation kernel. The backend
   * acknowledges it only when the kernel returns accepted; deferred/rejected
   * late results remain unapplied evidence.
   */
  deliverResult(input: Readonly<{
    authority: GovernedWorkerAuthorityReceipt;
    workerId: string;
    messageId: string;
    idempotencyKey: string;
  }>): Promise<GovernedWorkerResultDelivery>;
}>;

export type GovernedWorkerAuthorityResolver = (
  input: Readonly<{
    operation: GovernedWorkerOperation;
    recipeId?: string;
    workerId?: string;
    messageId?: string;
    scope: VoiceToolScope;
    context: VoiceToolExecutionContext;
  }>
) => Promise<GovernedWorkerAuthorityReceipt>;

export type GovernedWorkerOperationJournal = Readonly<{
  /**
   * Production implementations must atomically reserve identity+digest before
   * running the effect and retain both successful and indeterminate outcomes.
   */
  run<T>(
    identity: Readonly<{ key: string; requestSha256: string }>,
    effect: () => Promise<T>
  ): Promise<Readonly<{ value: T; replayed: boolean }>>;
}>;

type MemoryJournalRecord = Readonly<{
  requestSha256: string;
  value: Promise<unknown>;
}>;

/**
 * Process-local development journal. It coalesces concurrent duplicates and
 * fail-closes on key reuse, but production must inject a durable shared journal.
 */
export class InMemoryGovernedWorkerOperationJournal implements GovernedWorkerOperationJournal {
  readonly #records = new Map<string, MemoryJournalRecord>();

  async run<T>(
    identity: Readonly<{ key: string; requestSha256: string }>,
    effect: () => Promise<T>
  ): Promise<Readonly<{ value: T; replayed: boolean }>> {
    const prior = this.#records.get(identity.key);
    if (prior) {
      if (prior.requestSha256 !== identity.requestSha256) {
        throw new Error("governed worker idempotency key was reused with a different request");
      }
      return Object.freeze({ value: await prior.value as T, replayed: true });
    }
    const value = Promise.resolve().then(effect);
    this.#records.set(identity.key, Object.freeze({
      requestSha256: identity.requestSha256,
      value,
    }));
    return Object.freeze({ value: await value, replayed: false });
  }
}

const SpawnArgumentsSchema = z.object({
  recipeId: z.string().regex(RECIPE_ID),
  input: VoiceWorkerInputSchema,
}).strict();

const WorkerArgumentsSchema = z.object({ workerId: z.uuid() }).strict();
const DeliveryArgumentsSchema = z.object({
  workerId: z.uuid(),
  messageId: z.uuid(),
}).strict();

type OperationOutcome =
  | Readonly<{ worker: GovernedWorkerSnapshot }>
  | Readonly<{ worker: GovernedWorkerSnapshot | null }>
  | GovernedWorkerReconciliation
  | GovernedWorkerResultDelivery;

export type GovernedWorkerCommandReceipt = Readonly<{
  v: 1;
  operation: GovernedWorkerOperation;
  operationId: string;
  authorityReceiptId: string;
  authorityReceiptSha256: string;
  idempotencyKey: string;
  requestSha256: string;
  outcomeSha256: string;
  workerId: string | null;
  policyEpoch: number;
  conversationRevision: number;
  issuedAt: string;
}>;

export type GovernedWorkerCommandResult<T extends OperationOutcome = OperationOutcome> = Readonly<{
  outcome: T;
  receipt: GovernedWorkerCommandReceipt;
  receiptSha256: string;
  replayed: boolean;
}>;

type Invocation = Readonly<{
  scope: VoiceToolScope;
  context: VoiceToolExecutionContext;
}>;

function assertInvocation(
  operation: GovernedWorkerOperation,
  invocation: Invocation
): Readonly<{ scope: VoiceToolScope; context: Required<VoiceToolExecutionContext> }> {
  const { scope, context } = invocation;
  if (!scope.callId || !scope.agentId || !scope.orgId) throw new Error("worker tool scope is incomplete");
  const allowedAudiences: Record<GovernedWorkerOperation, readonly VoiceToolExecutionContext["audience"][]> = {
    spawn: ["flow_action"],
    status: ["flow_action", "reconciliation"],
    cancel: ["flow_action"],
    reconcile: ["reconciliation"],
    deliverResult: ["reconciliation"],
  };
  if (!allowedAudiences[operation].includes(context.audience)) {
    throw new Error(`governed worker ${operation} is not allowed for the ${context.audience} audience`);
  }
  if (!context.invocationId || !context.idempotencyKey || !context.receiptId ||
      !context.runtimeDigest || !SHA256.test(context.runtimeDigest)) {
    throw new Error("governed worker operation requires a complete gateway authority binding");
  }
  return Object.freeze({
    scope: Object.freeze({ ...scope }),
    context: Object.freeze(context as Required<VoiceToolExecutionContext>),
  });
}

function assertAuthority(
  operation: GovernedWorkerOperation,
  invocation: ReturnType<typeof assertInvocation>,
  receiptValue: unknown,
  nowMs: number,
  target: Readonly<{ recipeId?: string; workerId?: string }>
): GovernedWorkerAuthorityReceipt {
  const receipt = GovernedWorkerAuthorityReceiptSchema.parse(receiptValue);
  if (receipt.receiptId !== invocation.context.receiptId ||
      receipt.invocationId !== invocation.context.invocationId ||
      receipt.runtimeDigest !== invocation.context.runtimeDigest ||
      receipt.organizationId !== invocation.scope.orgId ||
      receipt.agentId !== invocation.scope.agentId ||
      receipt.callId !== invocation.scope.callId) {
    throw new Error("governed worker authority receipt does not match the gateway invocation");
  }
  if (!receipt.allowedOperations.includes(operation)) {
    throw new Error(`governed worker authority does not allow ${operation}`);
  }
  if (target.recipeId && !receipt.allowedRecipeIds.includes(target.recipeId)) {
    throw new Error(`governed worker authority does not allow recipe "${target.recipeId}"`);
  }
  if (target.workerId && receipt.allowedWorkerIds &&
      !receipt.allowedWorkerIds.includes(target.workerId)) {
    throw new Error("governed worker authority does not allow the requested worker");
  }
  if (nowMs < Date.parse(receipt.issuedAt) || nowMs >= Date.parse(receipt.expiresAt)) {
    throw new Error("governed worker authority receipt is not currently valid");
  }
  return receipt;
}

function workerIdFromOutcome(outcome: OperationOutcome): string | null {
  return outcome.worker?.id ?? null;
}

export class GovernedWorkerCoordinator {
  readonly #recipes: GovernedWorkerRecipeRegistry;
  readonly #backend: GovernedWorkerBackend;
  readonly #authority: GovernedWorkerAuthorityResolver;
  readonly #journal: GovernedWorkerOperationJournal;
  readonly #now: () => number;

  constructor(input: Readonly<{
    recipes: GovernedWorkerRecipeRegistry;
    backend: GovernedWorkerBackend;
    resolveAuthority: GovernedWorkerAuthorityResolver;
    journal: GovernedWorkerOperationJournal;
    now?: () => number;
  }>) {
    this.#recipes = input.recipes;
    this.#backend = input.backend;
    this.#authority = input.resolveAuthority;
    this.#journal = input.journal;
    this.#now = input.now ?? Date.now;
  }

  recipes(): ReturnType<GovernedWorkerRecipeRegistry["list"]> {
    return this.#recipes.list();
  }

  async #execute<T extends OperationOutcome>(input: Readonly<{
    operation: GovernedWorkerOperation;
    invocation: Invocation;
    request: unknown;
    recipeId?: string;
    workerId?: string;
    messageId?: string;
    effect: (
      authority: GovernedWorkerAuthorityReceipt,
      idempotencyKey: string
    ) => Promise<T>;
  }>): Promise<GovernedWorkerCommandResult<T>> {
    const invocation = assertInvocation(input.operation, input.invocation);
    const authority = assertAuthority(
      input.operation,
      invocation,
      await this.#authority({
        operation: input.operation,
        ...(input.recipeId ? { recipeId: input.recipeId } : {}),
        ...(input.workerId ? { workerId: input.workerId } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        scope: invocation.scope,
        context: invocation.context,
      }),
      this.#now(),
      { recipeId: input.recipeId, workerId: input.workerId }
    );
    const authorityReceiptSha256 = hashVoiceWorkerValue(authority);
    const requestSha256 = hashVoiceWorkerValue({
      v: 1,
      operation: input.operation,
      request: input.request,
      authorityReceiptSha256,
    });
    const identity = {
      key: `${authority.conversationId}\0${invocation.context.idempotencyKey}`,
      requestSha256,
    };
    const journaled = await this.#journal.run(identity, async () => {
      const outcome = await input.effect(authority, invocation.context.idempotencyKey);
      const outcomeSha256 = hashVoiceWorkerValue(outcome);
      const receipt = Object.freeze({
        v: 1 as const,
        operation: input.operation,
        operationId: invocation.context.invocationId,
        authorityReceiptId: authority.receiptId,
        authorityReceiptSha256,
        idempotencyKey: invocation.context.idempotencyKey,
        requestSha256,
        outcomeSha256,
        workerId: workerIdFromOutcome(outcome),
        policyEpoch: authority.policyEpoch,
        conversationRevision: authority.conversationRevision,
        issuedAt: new Date(this.#now()).toISOString(),
      });
      return Object.freeze({
        outcome,
        receipt,
        receiptSha256: hashVoiceWorkerValue(receipt),
      });
    });
    return Object.freeze({ ...journaled.value, replayed: journaled.replayed });
  }

  async spawn(args: unknown, invocation: Invocation): Promise<GovernedWorkerCommandResult> {
    const request = SpawnArgumentsSchema.parse(args);
    const recipe = this.#recipes.get(request.recipeId);
    const preparedInput = VoiceWorkerInputSchema.parse(
      recipe.prepareInput ? await recipe.prepareInput(request.input) : request.input
    );
    return this.#execute({
      operation: "spawn",
      invocation,
      request: {
        recipeId: recipe.id,
        workerKind: recipe.workerKind,
        capabilityManifestSha256: recipe.capabilityManifestSha256,
        input: preparedInput,
      },
      recipeId: recipe.id,
      effect: async (authority, idempotencyKey) => ({
        worker: GovernedWorkerSnapshotSchema.parse(await this.#backend.spawn({
          authority,
          recipe,
          workerInput: preparedInput,
          idempotencyKey,
        })),
      }),
    });
  }

  async status(args: unknown, invocation: Invocation): Promise<GovernedWorkerCommandResult> {
    const request = WorkerArgumentsSchema.parse(args);
    return this.#execute({
      operation: "status",
      invocation,
      request,
      workerId: request.workerId,
      effect: async (authority) => ({
        worker: GovernedWorkerSnapshotSchema.nullable().parse(await this.#backend.status({
          authority,
          workerId: request.workerId,
        })),
      }),
    });
  }

  async cancel(args: unknown, invocation: Invocation): Promise<GovernedWorkerCommandResult> {
    const request = WorkerArgumentsSchema.parse(args);
    return this.#execute({
      operation: "cancel",
      invocation,
      request,
      workerId: request.workerId,
      effect: async (authority, idempotencyKey) => ({
        worker: GovernedWorkerSnapshotSchema.parse(await this.#backend.cancel({
          authority,
          workerId: request.workerId,
          idempotencyKey,
        })),
      }),
    });
  }

  async reconcile(args: unknown, invocation: Invocation): Promise<GovernedWorkerCommandResult> {
    const request = WorkerArgumentsSchema.parse(args);
    return this.#execute({
      operation: "reconcile",
      invocation,
      request,
      workerId: request.workerId,
      effect: async (authority, idempotencyKey) => {
        const result = await this.#backend.reconcile({
          authority,
          workerId: request.workerId,
          idempotencyKey,
        });
        return Object.freeze({
          worker: GovernedWorkerSnapshotSchema.parse(result.worker),
          disposition: ReconciliationDispositionSchema.parse(result.disposition),
          evidenceSha256: z.string().regex(SHA256).nullable().parse(result.evidenceSha256),
          reason: z.string().max(4_096).nullable().parse(result.reason),
        });
      },
    });
  }

  async deliverResult(args: unknown, invocation: Invocation): Promise<GovernedWorkerCommandResult> {
    const request = DeliveryArgumentsSchema.parse(args);
    return this.#execute({
      operation: "deliverResult",
      invocation,
      request,
      workerId: request.workerId,
      messageId: request.messageId,
      effect: async (authority, idempotencyKey) => {
        const result = await this.#backend.deliverResult({
          authority,
          workerId: request.workerId,
          messageId: request.messageId,
          idempotencyKey,
        });
        return Object.freeze({
          worker: GovernedWorkerSnapshotSchema.parse(result.worker),
          messageId: z.uuid().parse(result.messageId),
          disposition: DeliveryDispositionSchema.parse(result.disposition),
          resultSha256: z.string().regex(SHA256).nullable().parse(result.resultSha256),
          conversationEventId: z.string().min(1).max(256).nullable().parse(result.conversationEventId),
          conversationEventSha256: z.string().regex(SHA256).nullable().parse(result.conversationEventSha256),
          reason: z.string().max(4_096).nullable().parse(result.reason),
        });
      },
    });
  }
}

const workerInputJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    v: { type: "integer", const: 1 },
    objective: { type: "string", minLength: 1, maxLength: 4_096 },
    context: { type: "object", additionalProperties: true },
    deliverable: { type: "string", minLength: 1, maxLength: 1_024 },
    deadlineAt: { type: "string", format: "date-time" },
  },
  required: ["v", "objective", "context", "deliverable"],
});

const workerIdJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: { workerId: { type: "string", format: "uuid" } },
  required: ["workerId"],
});

function requireExecutionContext(
  context: VoiceToolExecutionContext | undefined
): VoiceToolExecutionContext {
  if (!context) throw new Error("governed worker tool requires gateway execution context");
  return context;
}

/**
 * Provider-neutral management tools. `reconcile` and `deliverResult` are
 * intentionally callable only under the gateway's reconciliation audience;
 * tool arguments cannot mint worker or policy authority.
 */
export function createGovernedWorkerToolPack(input: Readonly<{
  coordinator: GovernedWorkerCoordinator;
  version: string;
}>): VoiceToolPack {
  const recipeIds = input.coordinator.recipes().map(({ id }) => id);
  const invoke = (
    operation: GovernedWorkerOperation,
    args: Record<string, unknown>,
    scope: VoiceToolScope,
    context: VoiceToolExecutionContext | undefined
  ) => input.coordinator[operation](args, {
    scope,
    context: requireExecutionContext(context),
  });
  return defineVoiceToolPack({
    id: "hacc.governed-workers",
    version: input.version,
    tools: [
      {
        name: GOVERNED_WORKER_TOOL_NAMES.spawn,
        description: "Spawn one policy-authorized durable worker recipe for asynchronous follow-through.",
        effect: "write",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recipeId: { type: "string", enum: recipeIds },
            input: workerInputJsonSchema,
          },
          required: ["recipeId", "input"],
        },
        execute: (args, scope, context) => invoke("spawn", args, scope, context),
      },
      {
        name: GOVERNED_WORKER_TOOL_NAMES.status,
        description: "Read the durable status and evidence digests of one worker in this conversation.",
        effect: "read",
        inputSchema: workerIdJsonSchema,
        execute: (args, scope, context) => invoke("status", args, scope, context),
      },
      {
        name: GOVERNED_WORKER_TOOL_NAMES.cancel,
        description: "Request idempotent cancellation of one policy-authorized durable worker.",
        effect: "write",
        inputSchema: workerIdJsonSchema,
        execute: (args, scope, context) => invoke("cancel", args, scope, context),
      },
      {
        name: GOVERNED_WORKER_TOOL_NAMES.reconcile,
        description: "Reconcile lease loss or an indeterminate worker from authoritative evidence.",
        effect: "write",
        inputSchema: workerIdJsonSchema,
        execute: (args, scope, context) => invoke("reconcile", args, scope, context),
      },
      {
        name: GOVERNED_WORKER_TOOL_NAMES.deliverResult,
        description: "Submit one immutable worker result to current conversation policy for accepted, deferred, or rejected delivery.",
        effect: "write",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            workerId: { type: "string", format: "uuid" },
            messageId: { type: "string", format: "uuid" },
          },
          required: ["workerId", "messageId"],
        },
        execute: (args, scope, context) => invoke("deliverResult", args, scope, context),
      },
    ],
  });
}
