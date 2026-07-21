import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_VOICE_WORKER_INPUT_BYTES = 64 * 1024;
export const MAX_VOICE_WORKER_CHECKPOINT_BYTES = 64 * 1024;
export const MAX_VOICE_WORKER_RESULT_BYTES = 128 * 1024;
export const MAX_VOICE_WORKER_EVENT_BYTES = 32 * 1024;

const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z][a-z0-9_.-]{1,63}$/;

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("voice worker values must contain finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined) throw new TypeError("voice worker values cannot contain undefined");
      normalized[key] = normalizeJson(object[key]);
    }
    return normalized;
  }
  throw new TypeError("voice worker values must be representable as JSON");
}

export function canonicalVoiceWorkerJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function hashVoiceWorkerValue(value: unknown): string {
  return createHash("sha256").update(canonicalVoiceWorkerJson(value), "utf8").digest("hex");
}

export function deriveVoiceWorkerId(conversationId: string, idempotencyKey: string): string {
  if (!z.uuid().safeParse(conversationId).success || !idempotencyKey || idempotencyKey.length > 256) {
    throw new Error("voice worker identity requires a conversation UUID and a bounded idempotency key");
  }
  const bytes = createHash("sha256")
    .update("hacc/voice-worker-id/v1\0", "utf8")
    .update(conversationId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function voiceWorkerJsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalVoiceWorkerJson(value), "utf8");
}

export const VoiceWorkerCapabilityManifestSchema = z.object({
  v: z.literal(1),
  mode: z.literal("read_only"),
  capabilities: z.array(z.string().regex(CAPABILITY)).min(1).max(32),
  networkOrigins: z.array(z.url().max(2_048).refine(
    (value) => new URL(value).protocol === "https:",
    "network origins must use HTTPS"
  )).max(32).default([]),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "capabilities must be unique" });
  }
  if (new Set(manifest.networkOrigins).size !== manifest.networkOrigins.length) {
    context.addIssue({ code: "custom", path: ["networkOrigins"], message: "network origins must be unique" });
  }
  for (const [index, origin] of manifest.networkOrigins.entries()) {
    const parsed = new URL(origin);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      context.addIssue({
        code: "custom",
        path: ["networkOrigins", index],
        message: "network origins cannot contain paths, credentials, queries, or fragments",
      });
    }
  }
});

export const VoiceWorkerInputSchema = z.object({
  v: z.literal(1),
  objective: z.string().trim().min(1).max(4_096),
  context: z.record(z.string().max(128), z.json()).default({}),
  deliverable: z.string().trim().min(1).max(1_024),
  deadlineAt: z.iso.datetime().optional(),
}).strict();

export const VoiceWorkerSpawnAuthoritySchema = z.object({
  v: z.literal(1),
  conversationId: z.uuid(),
  organizationId: z.uuid(),
  agentId: z.uuid(),
  agentVersion: z.number().int().positive(),
  source: z.enum(["voice_call", "conversation", "worker"]),
  sourceCallId: z.uuid().optional(),
  sourceWorkerId: z.uuid().optional(),
  capabilityManifestSha256: z.string().regex(SHA256),
}).strict().superRefine((authority, context) => {
  const sourceMatches =
    (authority.source === "voice_call" && !!authority.sourceCallId && !authority.sourceWorkerId)
    || (authority.source === "worker" && !!authority.sourceWorkerId && !authority.sourceCallId)
    || (authority.source === "conversation" && !authority.sourceCallId && !authority.sourceWorkerId);
  if (!sourceMatches) {
    context.addIssue({ code: "custom", message: "spawn source must have exactly its corresponding source identity" });
  }
});

const VoiceWorkerFactSchema = z.object({
  key: z.string().trim().min(1).max(128),
  value: z.json(),
  confidence: z.number().min(0).max(1),
  citationIds: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
}).strict();

const VoiceWorkerCitationSchema = z.object({
  id: z.string().trim().min(1).max(128),
  uri: z.url().max(2_048),
  title: z.string().trim().min(1).max(512).optional(),
  excerpt: z.string().max(2_048).optional(),
  retrievedAt: z.iso.datetime(),
}).strict();

const VoiceWorkerProposedActionSchema = z.object({
  kind: z.string().regex(CAPABILITY),
  rationale: z.string().trim().min(1).max(2_048),
  arguments: z.record(z.string().max(128), z.json()).default({}),
  requiresConfirmation: z.literal(true),
}).strict();

export const VoiceWorkerResultSchema = z.object({
  v: z.literal(1),
  facts: z.array(VoiceWorkerFactSchema).max(256),
  citations: z.array(VoiceWorkerCitationSchema).max(256),
  proposedActions: z.array(VoiceWorkerProposedActionSchema).max(64),
  summary: z.string().trim().min(1).max(8_192),
}).strict().superRefine((result, context) => {
  const citationIds = new Set(result.citations.map((citation) => citation.id));
  if (citationIds.size !== result.citations.length) {
    context.addIssue({ code: "custom", path: ["citations"], message: "citation identities must be unique" });
  }
  for (const [factIndex, fact] of result.facts.entries()) {
    for (const [citationIndex, citationId] of fact.citationIds.entries()) {
      if (!citationIds.has(citationId)) {
        context.addIssue({
          code: "custom",
          path: ["facts", factIndex, "citationIds", citationIndex],
          message: "fact refers to an unknown citation",
        });
      }
    }
  }
});

export const VoiceWorkerCheckpointSchema = z.object({
  v: z.literal(1),
  phase: z.string().trim().min(1).max(128),
  progress: z.number().min(0).max(1),
  resumableState: z.record(z.string().max(128), z.json()),
  updatedAt: z.iso.datetime(),
}).strict();

export const VoiceWorkerStatusSchema = z.enum([
  "pending",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "indeterminate",
]);

export type VoiceWorkerCapabilityManifest = z.infer<typeof VoiceWorkerCapabilityManifestSchema>;
export type VoiceWorkerInput = z.infer<typeof VoiceWorkerInputSchema>;
export type VoiceWorkerSpawnAuthority = z.infer<typeof VoiceWorkerSpawnAuthoritySchema>;
export type VoiceWorkerResult = z.infer<typeof VoiceWorkerResultSchema>;
export type VoiceWorkerCheckpoint = z.infer<typeof VoiceWorkerCheckpointSchema>;
export type VoiceWorkerStatus = z.infer<typeof VoiceWorkerStatusSchema>;

function assertBounded(value: unknown, maxBytes: number, label: string): void {
  if (voiceWorkerJsonBytes(value) > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} bytes`);
}

export function prepareVoiceWorkerSpawn(input: Readonly<{
  authority: unknown;
  workerInput: unknown;
  capabilityManifest: unknown;
}>): Readonly<{
  authority: VoiceWorkerSpawnAuthority;
  workerInput: VoiceWorkerInput;
  capabilityManifest: VoiceWorkerCapabilityManifest;
  authoritySha256: string;
  inputSha256: string;
  capabilityManifestSha256: string;
}> {
  const capabilityManifest = VoiceWorkerCapabilityManifestSchema.parse(input.capabilityManifest);
  const capabilityManifestSha256 = hashVoiceWorkerValue(capabilityManifest);
  const authority = VoiceWorkerSpawnAuthoritySchema.parse(input.authority);
  if (authority.capabilityManifestSha256 !== capabilityManifestSha256) {
    throw new Error("spawn authority capability digest does not match the read-only manifest");
  }
  const workerInput = VoiceWorkerInputSchema.parse(input.workerInput);
  assertBounded(workerInput, MAX_VOICE_WORKER_INPUT_BYTES, "voice worker input");
  return Object.freeze({
    authority,
    workerInput,
    capabilityManifest,
    authoritySha256: hashVoiceWorkerValue(authority),
    inputSha256: hashVoiceWorkerValue(workerInput),
    capabilityManifestSha256,
  });
}

export function prepareVoiceWorkerResult(value: unknown): Readonly<{
  result: VoiceWorkerResult;
  resultSha256: string;
  resultBytes: number;
}> {
  const result = VoiceWorkerResultSchema.parse(value);
  assertBounded(result, MAX_VOICE_WORKER_RESULT_BYTES, "voice worker result");
  return Object.freeze({ result, resultSha256: hashVoiceWorkerValue(result), resultBytes: voiceWorkerJsonBytes(result) });
}

export function prepareVoiceWorkerCheckpoint(value: unknown): Readonly<{
  checkpoint: VoiceWorkerCheckpoint;
  checkpointSha256: string;
  checkpointBytes: number;
}> {
  const checkpoint = VoiceWorkerCheckpointSchema.parse(value);
  assertBounded(checkpoint, MAX_VOICE_WORKER_CHECKPOINT_BYTES, "voice worker checkpoint");
  return Object.freeze({
    checkpoint,
    checkpointSha256: hashVoiceWorkerValue(checkpoint),
    checkpointBytes: voiceWorkerJsonBytes(checkpoint),
  });
}
