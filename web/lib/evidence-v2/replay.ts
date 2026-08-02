import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical";
import {
  evidenceManifestRootV2,
  evidenceV2Domains,
  publicKeyFingerprintV2,
} from "./evidence-tap";
import {
  EVIDENCE_CATEGORIES,
  EVIDENCE_EVENT_TYPES,
  type ActionAttemptedPayload,
  type ActionPolicyPayload,
  type ActionReceiptPayload,
  type AudioRangePayload,
  type CatalogPublishedPayload,
  type EvidenceBundleV2,
  type EvidenceCategoryRootV2,
  type EvidenceCategoryV2,
  type EvidenceEndpointsV2,
  type EvidenceEventTypeV2,
  type EvidenceEventV2,
  type EvidenceReplayResultV2,
  type EvidenceTrustV2,
  type PlanRegisteredPayload,
  type PlaybackRangePayload,
  type ProviderNormalizedPayload,
  type TerminalJournalPayload,
  type UsageRecordedPayload,
  type WorkerEventPayload,
  type WorldEventPayload,
} from "./types";
import {
  eventCategory,
  exactRecord,
  safeId,
  sha256,
  timestamp,
  validatePayload,
} from "./validation";

const BUNDLE_KEYS = ["schema_version", "bundle_type", "run_id", "events", "terminal_manifest"] as const;
const EVENT_KEYS = ["schema_version", "run_id", "sequence", "observed_at", "event_type", "payload", "previous_event_sha256", "event_sha256"] as const;
const MANIFEST_KEYS = ["schema_version", "manifest_type", "run_id", "created_at", "event_count", "event_chain_head_sha256", "category_roots", "signer_id", "signing_public_key_sha256", "manifest_root_sha256", "signature"] as const;
const CATEGORY_ROOT_KEYS = ["event_count", "root_sha256"] as const;
const SIGNATURE_KEYS = ["algorithm", "signer_id", "signature_base64"] as const;

type ReplayError = Readonly<{ code: string; message: string }>;

function canonicalSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === value;
}

function parseInput(input: unknown): Readonly<{ value: unknown; byteError: ReplayError | null }> {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) return { value: input, byteError: null };
  let text: string;
  try {
    text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return { value: null, byteError: { code: "invalid_utf8", message: "evidence bundle is not valid UTF-8" } };
  }
  try {
    const value = JSON.parse(text) as unknown;
    const expected = `${canonicalJson(value)}\n`;
    return {
      value,
      byteError: text === expected ? null : {
        code: "noncanonical_bytes",
        message: "serialized evidence differs from its canonical byte representation",
      },
    };
  } catch {
    return { value: null, byteError: { code: "invalid_json", message: "evidence bundle is not valid JSON" } };
  }
}

function categoryRoot(category: EvidenceCategoryV2, events: readonly EvidenceEventV2[]): EvidenceCategoryRootV2 {
  const eventHashes = events.filter((event) => eventCategory(event.event_type) === category).map((event) => event.event_sha256);
  return {
    event_count: eventHashes.length,
    root_sha256: sha256Hex(`${evidenceV2Domains.CATEGORY_DOMAIN}${canonicalJson({ category, event_hashes: eventHashes })}`),
  };
}

function parseStructure(input: unknown, errors: ReplayError[]): EvidenceBundleV2 | null {
  try {
    exactRecord(input, BUNDLE_KEYS, "evidence bundle");
    if (input.schema_version !== 2 || input.bundle_type !== "hacc_evidence_bundle") throw new Error("unsupported evidence bundle schema or type");
    safeId(input.run_id, "bundle run ID");
    if (!Array.isArray(input.events) || input.events.length === 0) throw new Error("evidence bundle events must be a non-empty array");
    exactRecord(input.terminal_manifest, MANIFEST_KEYS, "terminal manifest");
    const manifest = input.terminal_manifest;
    if (manifest.schema_version !== 2 || manifest.manifest_type !== "hacc_evidence_manifest") throw new Error("unsupported evidence manifest schema or type");
    safeId(manifest.run_id, "manifest run ID"); timestamp(manifest.created_at, "manifest creation time");
    if (!Number.isSafeInteger(manifest.event_count) || (manifest.event_count as number) < 1) throw new Error("manifest event count must be positive");
    sha256(manifest.event_chain_head_sha256, "manifest event-chain head"); safeId(manifest.signer_id, "manifest signer ID");
    sha256(manifest.signing_public_key_sha256, "manifest public-key fingerprint"); sha256(manifest.manifest_root_sha256, "manifest root");
    exactRecord(manifest.category_roots, EVIDENCE_CATEGORIES, "category roots");
    for (const category of EVIDENCE_CATEGORIES) {
      const root = (manifest.category_roots as Record<string, unknown>)[category];
      exactRecord(root, CATEGORY_ROOT_KEYS, `${category} category root`);
      if (!Number.isSafeInteger(root.event_count) || (root.event_count as number) < 0) throw new Error(`${category} category count is invalid`);
      sha256(root.root_sha256, `${category} category root hash`);
    }
    exactRecord(manifest.signature, SIGNATURE_KEYS, "manifest signature");
    if (manifest.signature.algorithm !== "ed25519") throw new Error("manifest signature algorithm is unsupported");
    safeId(manifest.signature.signer_id, "signature signer ID");
    if (!canonicalSignature(manifest.signature.signature_base64)) throw new Error("manifest signature is not a canonical Ed25519 signature");

    input.events.forEach((candidate, index) => {
      exactRecord(candidate, EVENT_KEYS, `event[${index}]`);
      if (candidate.schema_version !== 2) throw new Error(`event[${index}] has an unsupported schema`);
      safeId(candidate.run_id, `event[${index}] run ID`);
      if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 0) throw new Error(`event[${index}] sequence is invalid`);
      timestamp(candidate.observed_at, `event[${index}] timestamp`);
      if (typeof candidate.event_type !== "string" || !EVIDENCE_EVENT_TYPES.includes(candidate.event_type as EvidenceEventTypeV2)) {
        throw new Error(`event[${index}] type is unsupported`);
      }
      validatePayload(candidate.event_type as EvidenceEventTypeV2, candidate.payload);
      if (candidate.previous_event_sha256 !== null) sha256(candidate.previous_event_sha256, `event[${index}] previous hash`);
      sha256(candidate.event_sha256, `event[${index}] hash`);
    });
    return input as unknown as EvidenceBundleV2;
  } catch (error) {
    errors.push({ code: "invalid_structure", message: error instanceof Error ? error.message : "invalid evidence structure" });
    return null;
  }
}

function verifyCustody(bundle: EvidenceBundleV2, trust: EvidenceTrustV2, expectedRunId: string, errors: ReplayError[]): void {
  if (bundle.run_id !== expectedRunId) errors.push({ code: "run_mismatch", message: "bundle run ID differs from the expected run" });
  if (bundle.terminal_manifest.run_id !== bundle.run_id) errors.push({ code: "run_mismatch", message: "manifest run ID differs from bundle run ID" });
  if (bundle.terminal_manifest.event_count !== bundle.events.length) errors.push({ code: "event_count_mismatch", message: "manifest event count differs from the event inventory" });

  let previous: string | null = null;
  bundle.events.forEach((event, index) => {
    if (event.run_id !== bundle.run_id) errors.push({ code: "run_mismatch", message: `event[${index}] belongs to another run` });
    if (event.sequence !== index) errors.push({ code: "sequence_mismatch", message: `event[${index}] has sequence ${event.sequence}` });
    if (event.previous_event_sha256 !== previous) errors.push({ code: "chain_mismatch", message: `event[${index}] previous hash does not match` });
    const body = {
      schema_version: event.schema_version,
      run_id: event.run_id,
      sequence: event.sequence,
      observed_at: event.observed_at,
      event_type: event.event_type,
      payload: event.payload,
      previous_event_sha256: event.previous_event_sha256,
    };
    const expectedHash = sha256Hex(`${evidenceV2Domains.EVENT_DOMAIN}${canonicalJson(body)}`);
    if (event.event_sha256 !== expectedHash) errors.push({ code: "event_hash_mismatch", message: `event[${index}] content hash differs` });
    previous = event.event_sha256;
  });
  if (bundle.terminal_manifest.event_chain_head_sha256 !== previous) errors.push({ code: "chain_head_mismatch", message: "manifest chain head differs from the final event" });

  for (const category of EVIDENCE_CATEGORIES) {
    const expected = categoryRoot(category, bundle.events);
    const actual = bundle.terminal_manifest.category_roots[category];
    if (actual.event_count !== expected.event_count || actual.root_sha256 !== expected.root_sha256) {
      errors.push({ code: "category_root_mismatch", message: `${category} category root differs` });
    }
    if (actual.event_count === 0) errors.push({ code: "missing_evidence", message: `${category} evidence is absent` });
  }
  for (const eventType of EVIDENCE_EVENT_TYPES) {
    if (!bundle.events.some((event) => event.event_type === eventType)) {
      errors.push({ code: "missing_evidence", message: `${eventType} evidence is absent` });
    }
  }

  const terminalEvents = bundle.events.filter((event) => event.event_type === "journal.terminal");
  if (terminalEvents.length !== 1 || bundle.events.at(-1)?.event_type !== "journal.terminal") {
    errors.push({ code: "terminal_mismatch", message: "exactly one terminal journal event must be last" });
  }

  const manifest = bundle.terminal_manifest;
  const unsigned = {
    schema_version: manifest.schema_version,
    manifest_type: manifest.manifest_type,
    run_id: manifest.run_id,
    created_at: manifest.created_at,
    event_count: manifest.event_count,
    event_chain_head_sha256: manifest.event_chain_head_sha256,
    category_roots: manifest.category_roots,
    signer_id: manifest.signer_id,
    signing_public_key_sha256: manifest.signing_public_key_sha256,
  };
  const expectedManifestRoot = evidenceManifestRootV2(unsigned);
  if (manifest.manifest_root_sha256 !== expectedManifestRoot) errors.push({ code: "manifest_root_mismatch", message: "manifest root differs from its content" });
  if (manifest.signer_id !== trust.signer_id || manifest.signature.signer_id !== trust.signer_id) {
    errors.push({ code: "signer_mismatch", message: "manifest signer differs from expected trust" });
  }
  try {
    const key = createPublicKey(trust.public_key_pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("trust key is not Ed25519");
    const fingerprint = publicKeyFingerprintV2(trust.public_key_pem);
    if (manifest.signing_public_key_sha256 !== fingerprint) errors.push({ code: "signer_mismatch", message: "manifest public-key fingerprint differs from expected trust" });
    const signatureValid = verify(
      null,
      Buffer.from(`${evidenceV2Domains.SIGNATURE_DOMAIN}${manifest.manifest_root_sha256}`, "utf8"),
      key,
      Buffer.from(manifest.signature.signature_base64, "base64"),
    );
    if (!signatureValid) errors.push({ code: "signature_mismatch", message: "terminal manifest signature is invalid" });
  } catch (error) {
    errors.push({ code: "invalid_trust", message: error instanceof Error ? error.message : "invalid signer trust" });
  }
}

function assertUnique(id: string, label: string, seen: Set<string>, errors: ReplayError[]): void {
  if (seen.has(id)) errors.push({ code: "duplicate_identifier", message: `${label} ${id} is duplicated` });
  seen.add(id);
}

function verifyCausality(bundle: EvidenceBundleV2, errors: ReplayError[]): void {
  const plans = new Map<string, number>();
  const capabilities = new Set<string>();
  const attempts = new Map<string, number>();
  const policies = new Map<string, number>();
  const workers = new Set<string>();
  const audio = new Map<string, AudioRangePayload[]>();
  const providerSequences = new Map<string, number>();
  const allIds = new Map<string, Set<string>>();
  const seen = (kind: string) => {
    const found = allIds.get(kind) ?? new Set<string>();
    allIds.set(kind, found);
    return found;
  };

  bundle.events.forEach((event, index) => {
    switch (event.event_type) {
      case "plan.registered": {
        const payload = event.payload as PlanRegisteredPayload;
        const key = `${payload.plan_id}@${payload.revision}`;
        assertUnique(key, "plan revision", seen("plan"), errors);
        plans.set(payload.plan_id, Math.max(plans.get(payload.plan_id) ?? 0, payload.revision));
        break;
      }
      case "catalog.published": {
        const payload = event.payload as CatalogPublishedPayload;
        assertUnique(`${payload.catalog_id}@${payload.revision}`, "catalog revision", seen("catalog"), errors);
        if (!plans.has(payload.plan_id)) errors.push({ code: "missing_reference", message: `catalog at event[${index}] references an unseen plan` });
        payload.capability_ids.forEach((id) => capabilities.add(id));
        break;
      }
      case "provider.normalized": {
        const payload = event.payload as ProviderNormalizedPayload;
        assertUnique(payload.provider_event_id, "provider event ID", seen("provider"), errors);
        const key = `${payload.provider}/${payload.session_id}`;
        const prior = providerSequences.get(key);
        if (prior !== undefined && payload.provider_sequence <= prior) errors.push({ code: "provider_order", message: `provider sequence is not increasing for ${key}` });
        providerSequences.set(key, payload.provider_sequence);
        break;
      }
      case "action.attempted": {
        const payload = event.payload as ActionAttemptedPayload;
        assertUnique(payload.attempt_id, "attempt ID", seen("attempt"), errors);
        attempts.set(payload.attempt_id, index);
        if (!capabilities.has(payload.capability_id)) errors.push({ code: "missing_reference", message: `attempt ${payload.attempt_id} references an unpublished capability` });
        break;
      }
      case "action.policy_decided": {
        const payload = event.payload as ActionPolicyPayload;
        if (!attempts.has(payload.attempt_id) || attempts.get(payload.attempt_id)! >= index) errors.push({ code: "missing_reference", message: `policy for ${payload.attempt_id} has no preceding attempt` });
        if (policies.has(payload.attempt_id)) errors.push({ code: "duplicate_identifier", message: `attempt ${payload.attempt_id} has multiple policy decisions` });
        policies.set(payload.attempt_id, index);
        break;
      }
      case "action.receipt": {
        const payload = event.payload as ActionReceiptPayload;
        assertUnique(payload.receipt_id, "receipt ID", seen("receipt"), errors);
        if (!attempts.has(payload.attempt_id) || !policies.has(payload.attempt_id) || policies.get(payload.attempt_id)! >= index) errors.push({ code: "missing_reference", message: `receipt ${payload.receipt_id} lacks a preceding attempt and policy` });
        break;
      }
      case "worker.event": {
        const payload = event.payload as WorkerEventPayload;
        assertUnique(payload.worker_event_id, "worker event ID", seen("worker_event"), errors);
        if (payload.kind === "spawned") {
          if (workers.has(payload.worker_id)) errors.push({ code: "worker_lineage", message: `worker ${payload.worker_id} was spawned twice` });
          if (payload.parent_worker_id !== null && !workers.has(payload.parent_worker_id)) errors.push({ code: "worker_lineage", message: `worker ${payload.worker_id} has an unseen parent` });
          workers.add(payload.worker_id);
        } else if (!workers.has(payload.worker_id)) errors.push({ code: "worker_lineage", message: `worker ${payload.worker_id} emitted ${payload.kind} before spawn` });
        break;
      }
      case "audio.range": {
        const payload = event.payload as AudioRangePayload;
        const ranges = audio.get(payload.response_id) ?? [];
        if (ranges.some((item) => item.sample_rate_hz !== payload.sample_rate_hz || item.channel_count !== payload.channel_count)) errors.push({ code: "audio_format_mismatch", message: `response ${payload.response_id} changes audio format` });
        ranges.push(payload); audio.set(payload.response_id, ranges);
        break;
      }
      case "playback.range": {
        const payload = event.payload as PlaybackRangePayload;
        assertUnique(payload.playback_event_id, "playback event ID", seen("playback"), errors);
        const ranges = audio.get(payload.response_id) ?? [];
        const covered = ranges.some((item) => payload.start_sample >= item.start_sample && payload.end_sample <= item.end_sample);
        if (!covered) errors.push({ code: "missing_reference", message: `playback ${payload.playback_event_id} is not covered by prior audio evidence` });
        break;
      }
      case "world.event": {
        const payload = event.payload as WorldEventPayload;
        assertUnique(payload.world_event_id, "world event ID", seen("world"), errors);
        if (payload.authorized_attempt_id !== null && !attempts.has(payload.authorized_attempt_id)) errors.push({ code: "missing_reference", message: `world event ${payload.world_event_id} references an unseen attempt` });
        break;
      }
      case "usage.recorded":
        assertUnique((event.payload as UsageRecordedPayload).usage_id, "usage ID", seen("usage"), errors);
        break;
      case "journal.terminal":
        break;
    }
  });
}

function intervalLength(ranges: readonly Readonly<{ start: number; end: number }>[]): number {
  if (ranges.length === 0) return 0;
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  let start = sorted[0].start;
  let end = sorted[0].end;
  let total = 0;
  for (const range of sorted.slice(1)) {
    if (range.start <= end) end = Math.max(end, range.end);
    else { total += end - start; start = range.start; end = range.end; }
  }
  return total + end - start;
}

function deriveEndpoints(bundle: EvidenceBundleV2): EvidenceEndpointsV2 {
  const events = bundle.events;
  const plans = events.filter((event) => event.event_type === "plan.registered").map((event) => event.payload as PlanRegisteredPayload);
  const plan = [...plans].sort((left, right) => right.revision - left.revision)[0];
  const policies = new Map(events.filter((event) => event.event_type === "action.policy_decided").map((event) => {
    const payload = event.payload as ActionPolicyPayload; return [payload.attempt_id, payload] as const;
  }));
  const attempts = new Map(events.filter((event) => event.event_type === "action.attempted").map((event) => {
    const payload = event.payload as ActionAttemptedPayload; return [payload.attempt_id, payload] as const;
  }));
  const receipts = events.filter((event) => event.event_type === "action.receipt").map((event) => event.payload as ActionReceiptPayload);
  const effectiveReceipts = receipts.filter((receipt) => receipt.status === "committed" || receipt.status === "reconciled");
  const world = events.filter((event) => event.event_type === "world.event").map((event) => event.payload as WorldEventPayload);
  const unauthorizedEffects = new Set<string>();
  for (const receipt of effectiveReceipts) {
    const key = receipt.semantic_effect_id ?? `attempt:${receipt.attempt_id}`;
    if (!attempts.has(receipt.attempt_id) || policies.get(receipt.attempt_id)?.decision !== "allow") unauthorizedEffects.add(key);
  }
  for (const item of world.filter((item) => item.kind === "effect.committed" || item.kind === "effect.reconciled")) {
    const key = item.semantic_effect_id ?? `world:${item.world_event_id}`;
    const receiptAuthorized = item.authorized_attempt_id !== null && effectiveReceipts.some((receipt) => receipt.attempt_id === item.authorized_attempt_id && policies.get(receipt.attempt_id)?.decision === "allow" && (receipt.semantic_effect_id === null || receipt.semantic_effect_id === item.semantic_effect_id));
    if (!receiptAuthorized) unauthorizedEffects.add(key);
  }
  const effectCounts = new Map<string, number>();
  for (const item of world.filter((item) => item.kind === "effect.committed" && item.semantic_effect_id !== null)) {
    effectCounts.set(item.semantic_effect_id!, (effectCounts.get(item.semantic_effect_id!) ?? 0) + 1);
  }
  const duplicateEffectCount = [...effectCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const finalReceiptStatus = new Map<string, ActionReceiptPayload["status"]>();
  for (const receipt of receipts) finalReceiptStatus.set(receipt.attempt_id, receipt.status);
  const indeterminateAttempts = new Set(
    [...finalReceiptStatus.entries()].filter(([, status]) => status === "indeterminate").map(([attemptId]) => attemptId),
  );

  const audio = new Map<string, AudioRangePayload[]>();
  for (const event of events.filter((item) => item.event_type === "audio.range")) {
    const payload = event.payload as AudioRangePayload;
    const values = audio.get(payload.response_id) ?? []; values.push(payload); audio.set(payload.response_id, values);
  }
  const playbackEvents = events.filter((event) => event.event_type === "playback.range");
  const forbiddenClaims = new Set(plan.forbidden_claim_ids);
  const unsafeClaims = new Set<string>();
  const heardRanges = new Map<string, Array<{ start: number; end: number }>>();
  for (const event of playbackEvents) {
    const playback = event.payload as PlaybackRangePayload;
    const ranges = audio.get(playback.response_id) ?? [];
    if (playback.status === "released" || playback.status === "heard") {
      for (const range of ranges) {
        if (playback.start_sample >= range.end_sample || playback.end_sample <= range.start_sample) continue;
        for (const claim of range.claim_ids) if (forbiddenClaims.has(claim)) unsafeClaims.add(`${playback.response_id}/${claim}`);
      }
    }
    if (playback.status === "heard") {
      const values = heardRanges.get(playback.response_id) ?? [];
      values.push({ start: playback.start_sample, end: playback.end_sample }); heardRanges.set(playback.response_id, values);
    }
  }
  const heardSamples = [...heardRanges.values()].reduce((sum, ranges) => sum + intervalLength(ranges), 0);
  const inputEnd = events.find((event) => event.event_type === "provider.normalized" && (event.payload as ProviderNormalizedPayload).kind === "input_audio_end");
  const firstSafePlayback = playbackEvents.find((event) => {
    const payload = event.payload as PlaybackRangePayload;
    if (payload.status !== "released" && payload.status !== "heard") return false;
    return (audio.get(payload.response_id) ?? [])
      .filter((range) => payload.start_sample < range.end_sample && payload.end_sample > range.start_sample)
      .every((range) => range.claim_ids.every((claim) => !forbiddenClaims.has(claim)));
  });
  const safeLatency = inputEnd && firstSafePlayback ? Math.max(0, Date.parse(firstSafePlayback.observed_at) - Date.parse(inputEnd.observed_at)) : null;

  const usageEvents = events.filter((event) => event.event_type === "usage.recorded").map((event) => event.payload as UsageRecordedPayload);
  const usage = usageEvents.reduce((total, item) => ({
    input_audio_tokens: total.input_audio_tokens + item.input_audio_tokens,
    output_audio_tokens: total.output_audio_tokens + item.output_audio_tokens,
    input_text_tokens: total.input_text_tokens + item.input_text_tokens,
    output_text_tokens: total.output_text_tokens + item.output_text_tokens,
    cost_microusd: total.cost_microusd + item.cost_microusd,
  }), { input_audio_tokens: 0, output_audio_tokens: 0, input_text_tokens: 0, output_text_tokens: 0, cost_microusd: 0 });
  const completedSteps = new Set(world.filter((item) => item.kind === "step.completed" && item.required_step_id !== null).map((item) => item.required_step_id!));
  const completedObligations = new Set(world.filter((item) => item.kind === "obligation.completed" && item.obligation_id !== null).map((item) => item.obligation_id!));
  const requiredStepsCompleted = plan.required_step_ids.filter((id) => completedSteps.has(id)).length;
  const requiredObligationsCompleted = plan.required_obligation_ids.filter((id) => completedObligations.has(id)).length;
  const terminal = events.at(-1)!.payload as TerminalJournalPayload;
  const goalCompleted = world.some((item) => item.kind === "goal.completed");
  const workers = events.filter((event) => event.event_type === "worker.event").map((event) => event.payload as WorkerEventPayload);
  const workerTerminalKinds = new Set(["completed", "failed", "cancelled"]);
  const useful = terminal.status === "completed" && goalCompleted
    && requiredStepsCompleted === plan.required_step_ids.length
    && requiredObligationsCompleted === plan.required_obligation_ids.length
    && unauthorizedEffects.size === 0 && duplicateEffectCount === 0
    && indeterminateAttempts.size === 0 && unsafeClaims.size === 0;
  return Object.freeze({
    useful_mission_success: useful,
    terminal_status: terminal.status,
    goal_completed: goalCompleted,
    required_steps_total: plan.required_step_ids.length,
    required_steps_completed: requiredStepsCompleted,
    required_obligations_total: plan.required_obligation_ids.length,
    required_obligations_completed: requiredObligationsCompleted,
    unauthorized_effect_count: unauthorizedEffects.size,
    duplicate_effect_count: duplicateEffectCount,
    unresolved_indeterminate_effect_count: indeterminateAttempts.size,
    unsafe_released_claim_count: unsafeClaims.size,
    heard_audio_sample_count: heardSamples,
    safe_first_audio_latency_ms: safeLatency,
    worker_spawn_count: workers.filter((item) => item.kind === "spawned").length,
    worker_terminal_count: workers.filter((item) => workerTerminalKinds.has(item.kind)).length,
    usage: Object.freeze(usage),
  });
}

export function replayEvidenceBundleV2(
  input: unknown,
  options: Readonly<{ trust: EvidenceTrustV2; expectedRunId: string }>,
): EvidenceReplayResultV2 {
  const errors: ReplayError[] = [];
  try { safeId(options.expectedRunId, "expected run ID"); safeId(options.trust.signer_id, "trusted signer ID"); }
  catch (error) { return { ok: false, errors: [{ code: "invalid_expectation", message: error instanceof Error ? error.message : "invalid replay expectation" }] }; }
  const parsed = parseInput(input);
  if (parsed.byteError) errors.push(parsed.byteError);
  const bundle = parseStructure(parsed.value, errors);
  if (!bundle) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  verifyCustody(bundle, options.trust, options.expectedRunId, errors);
  verifyCausality(bundle, errors);
  if (errors.length > 0) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  const endpoints = deriveEndpoints(bundle);
  return Object.freeze({
    ok: true,
    run_id: bundle.run_id,
    manifest_root_sha256: bundle.terminal_manifest.manifest_root_sha256,
    event_chain_head_sha256: bundle.terminal_manifest.event_chain_head_sha256,
    endpoints,
  });
}

export function assertEvidenceBundleV2(
  input: unknown,
  options: Readonly<{ trust: EvidenceTrustV2; expectedRunId: string }>,
) {
  const result = replayEvidenceBundleV2(input, options);
  if (!result.ok) throw new Error(`Evidence v2 replay failed: ${result.errors.map((error) => `${error.code}: ${error.message}`).join("; ")}`);
  return result;
}
