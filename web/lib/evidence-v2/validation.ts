import type { EvidenceEventTypeV2, EvidencePayloadByTypeV2 } from "./types";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,255}$/;

export function exactRecord(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}
export function safeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
}

export function nonEmpty(value: unknown, label: string, maximum = 1024): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
}

export function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

export function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
}

export function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function nullableId(value: unknown, label: string): void {
  if (value !== null) safeId(value, label);
}

function idArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  value.forEach((item, index) => {
    safeId(item, `${label}[${index}]`);
    if (seen.has(item)) throw new Error(`${label} contains duplicate ID ${item}`);
    seen.add(item);
  });
}

const PAYLOAD_KEYS: Record<EvidenceEventTypeV2, readonly string[]> = {
  "plan.registered": ["plan_id", "revision", "plan_sha256", "required_step_ids", "required_obligation_ids", "forbidden_claim_ids"],
  "catalog.published": ["catalog_id", "plan_id", "revision", "catalog_sha256", "capability_ids"],
  "provider.normalized": ["provider", "session_id", "provider_event_id", "provider_sequence", "kind", "turn_id", "raw_event_sha256"],
  "action.attempted": ["attempt_id", "action_id", "capability_id", "plan_revision", "arguments_sha256"],
  "action.policy_decided": ["attempt_id", "decision", "policy_sha256", "reason_code"],
  "action.receipt": ["attempt_id", "receipt_id", "status", "semantic_effect_id", "result_sha256", "world_revision"],
  "worker.event": ["worker_event_id", "worker_id", "parent_worker_id", "call_id", "plan_revision", "kind", "result_sha256"],
  "audio.range": ["response_id", "audio_sha256", "byte_length", "sample_rate_hz", "channel_count", "start_sample", "end_sample", "claim_ids", "opportunity_ids", "semantic_alignment_sha256"],
  "playback.range": ["playback_event_id", "response_id", "start_sample", "end_sample", "status"],
  "world.event": ["world_event_id", "kind", "required_step_id", "obligation_id", "correction_id", "authorized_attempt_id", "semantic_effect_id", "world_revision", "world_state_sha256"],
  "usage.recorded": ["usage_id", "provider", "model", "input_audio_tokens", "output_audio_tokens", "input_text_tokens", "output_text_tokens", "cost_microusd", "pricing_artifact_sha256"],
  "journal.terminal": ["disposition_id", "status", "reason_code"],
};

function oneOf(value: unknown, accepted: readonly string[], label: string): void {
  if (typeof value !== "string" || !accepted.includes(value)) throw new Error(`${label} is unsupported`);
}

export function validatePayload<T extends EvidenceEventTypeV2>(type: T, input: unknown): EvidencePayloadByTypeV2[T] {
  exactRecord(input, PAYLOAD_KEYS[type], `${type} payload`);
  const value = input;
  switch (type) {
    case "plan.registered":
      safeId(value.plan_id, "plan ID"); integer(value.revision, "plan revision", 1); sha256(value.plan_sha256, "plan hash");
      idArray(value.required_step_ids, "required step IDs"); idArray(value.required_obligation_ids, "required obligation IDs"); idArray(value.forbidden_claim_ids, "forbidden claim IDs");
      break;
    case "catalog.published":
      safeId(value.catalog_id, "catalog ID"); safeId(value.plan_id, "catalog plan ID"); integer(value.revision, "catalog revision", 1); sha256(value.catalog_sha256, "catalog hash"); idArray(value.capability_ids, "capability IDs");
      break;
    case "provider.normalized":
      nonEmpty(value.provider, "provider", 128); safeId(value.session_id, "session ID"); safeId(value.provider_event_id, "provider event ID"); integer(value.provider_sequence, "provider sequence");
      oneOf(value.kind, ["session_open", "model_ack", "input_audio_end", "response_start", "response_end", "tool_call", "tool_result", "reconnect", "session_close", "error"], "provider event kind");
      nullableId(value.turn_id, "turn ID"); sha256(value.raw_event_sha256, "raw provider event hash");
      break;
    case "action.attempted":
      safeId(value.attempt_id, "attempt ID"); safeId(value.action_id, "action ID"); safeId(value.capability_id, "capability ID"); integer(value.plan_revision, "action plan revision", 1); sha256(value.arguments_sha256, "arguments hash");
      break;
    case "action.policy_decided":
      safeId(value.attempt_id, "policy attempt ID"); oneOf(value.decision, ["allow", "deny"], "policy decision"); sha256(value.policy_sha256, "policy hash"); nonEmpty(value.reason_code, "policy reason code", 256);
      break;
    case "action.receipt":
      safeId(value.attempt_id, "receipt attempt ID"); safeId(value.receipt_id, "receipt ID"); oneOf(value.status, ["committed", "rejected", "indeterminate", "reconciled"], "receipt status"); nullableId(value.semantic_effect_id, "semantic effect ID"); sha256(value.result_sha256, "receipt result hash"); integer(value.world_revision, "receipt world revision");
      break;
    case "worker.event":
      safeId(value.worker_event_id, "worker event ID"); safeId(value.worker_id, "worker ID"); nullableId(value.parent_worker_id, "parent worker ID"); safeId(value.call_id, "worker call ID"); integer(value.plan_revision, "worker plan revision", 1);
      oneOf(value.kind, ["spawned", "started", "completed", "failed", "cancelled", "result_accepted", "result_rejected_stale"], "worker event kind"); if (value.result_sha256 !== null) sha256(value.result_sha256, "worker result hash");
      break;
    case "audio.range":
      safeId(value.response_id, "response ID"); sha256(value.audio_sha256, "audio hash"); integer(value.byte_length, "audio byte length", 1); integer(value.sample_rate_hz, "sample rate", 1); integer(value.channel_count, "channel count", 1); integer(value.start_sample, "audio start sample"); integer(value.end_sample, "audio end sample", 1); idArray(value.claim_ids, "audio claim IDs");
      idArray(value.opportunity_ids, "audio opportunity IDs"); sha256(value.semantic_alignment_sha256, "semantic alignment hash");
      if ((value.end_sample as number) <= (value.start_sample as number)) throw new Error("audio range must be non-empty");
      break;
    case "playback.range":
      safeId(value.playback_event_id, "playback event ID"); safeId(value.response_id, "playback response ID"); integer(value.start_sample, "playback start sample"); integer(value.end_sample, "playback end sample", 1); oneOf(value.status, ["released", "heard", "interrupted"], "playback status");
      if ((value.end_sample as number) <= (value.start_sample as number)) throw new Error("playback range must be non-empty");
      break;
    case "world.event":
      safeId(value.world_event_id, "world event ID"); oneOf(value.kind, ["goal.completed", "step.completed", "obligation.completed", "correction.applied", "effect.committed", "effect.reconciled"], "world event kind");
      nullableId(value.required_step_id, "required step ID"); nullableId(value.obligation_id, "obligation ID"); nullableId(value.correction_id, "correction ID"); nullableId(value.authorized_attempt_id, "authorized attempt ID"); nullableId(value.semantic_effect_id, "world semantic effect ID");
      integer(value.world_revision, "world revision"); sha256(value.world_state_sha256, "world state hash");
      break;
    case "usage.recorded":
      safeId(value.usage_id, "usage ID"); nonEmpty(value.provider, "usage provider", 128); nonEmpty(value.model, "usage model", 512);
      integer(value.input_audio_tokens, "input audio tokens"); integer(value.output_audio_tokens, "output audio tokens"); integer(value.input_text_tokens, "input text tokens"); integer(value.output_text_tokens, "output text tokens"); integer(value.cost_microusd, "cost in micro-USD");
      sha256(value.pricing_artifact_sha256, "pricing artifact hash");
      break;
    case "journal.terminal":
      safeId(value.disposition_id, "terminal disposition ID"); oneOf(value.status, ["completed", "failed", "aborted"], "terminal status"); if (value.reason_code !== null) nonEmpty(value.reason_code, "terminal reason code", 256);
      break;
  }
  return input as EvidencePayloadByTypeV2[T];
}

export function eventCategory(type: EvidenceEventTypeV2) {
  if (type.startsWith("plan.")) return "plans" as const;
  if (type.startsWith("catalog.")) return "catalogs" as const;
  if (type.startsWith("provider.")) return "provider" as const;
  if (type.startsWith("action.")) return "actions" as const;
  if (type.startsWith("worker.")) return "workers" as const;
  if (type.startsWith("audio.")) return "audio" as const;
  if (type.startsWith("playback.")) return "playback" as const;
  if (type.startsWith("world.")) return "world" as const;
  if (type.startsWith("usage.")) return "usage" as const;
  return "terminal" as const;
}
