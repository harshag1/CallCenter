import { canonicalJson, immutableJson, sha256Hex } from "../../artifacts";
import { verifySignedHarnessTreatment } from "./manifest";
import type {
  CompiledBenchmarkCondition,
  CompiledTreatmentRuntime,
  ConditionExecutionAttestation,
  SharedConditionSemantics,
  SignedHarnessTreatment,
  TreatmentVerificationAuthority,
} from "./types";

const SHARED_DOMAIN = "harshas-amazing-call-center/benchmark-v2/shared-condition-semantics/v1\n";
const CONDITION_DOMAIN = "harshas-amazing-call-center/benchmark-v2/compiled-condition/v1\n";
const EXECUTION_ATTESTATION_DOMAIN = "harshas-amazing-call-center/benchmark-v2/condition-execution-attestation/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHARED_KEYS = Object.freeze([
  "schema_version", "benchmark_id", "protocol_sha256", "pair_id", "scenario_sha256",
  "caller_schedule_sha256", "task_policy_sha256", "safety_policy_sha256", "provider",
  "audio", "world", "gateway", "tools", "limits", "registered_native_contract",
].sort());

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a canonical identifier`);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
}

export function assertSharedConditionSemantics(value: unknown): asserts value is SharedConditionSemantics {
  assertExactKeys(value, SHARED_KEYS, "shared condition semantics");
  const shared = value as unknown as SharedConditionSemantics;
  if (shared.schema_version !== 1) throw new Error("unsupported shared condition semantics schema");
  assertId(shared.benchmark_id, "benchmark_id");
  assertId(shared.pair_id, "pair_id");
  for (const [label, digest] of [
    ["protocol_sha256", shared.protocol_sha256],
    ["scenario_sha256", shared.scenario_sha256],
    ["caller_schedule_sha256", shared.caller_schedule_sha256],
    ["task_policy_sha256", shared.task_policy_sha256],
    ["safety_policy_sha256", shared.safety_policy_sha256],
  ] as const) assertSha(digest, label);

  assertExactKeys(shared.provider, ["provider_id", "model_id", "voice_id", "base_session_configuration_sha256"], "provider semantics");
  assertId(shared.provider.provider_id, "provider_id");
  assertId(shared.provider.model_id, "model_id");
  assertId(shared.provider.voice_id, "voice_id");
  assertSha(shared.provider.base_session_configuration_sha256, "base_session_configuration_sha256");

  assertExactKeys(shared.audio, ["input_manifest_sha256", "delivery_profile_sha256", "codec_profile_sha256"], "audio semantics");
  assertExactKeys(shared.world, ["world_manifest_sha256", "initial_state_sha256"], "world semantics");
  assertExactKeys(shared.gateway, ["schema_sha256", "implementation_sha256"], "gateway semantics");
  for (const [label, digest] of [
    ["audio.input_manifest_sha256", shared.audio.input_manifest_sha256],
    ["audio.delivery_profile_sha256", shared.audio.delivery_profile_sha256],
    ["audio.codec_profile_sha256", shared.audio.codec_profile_sha256],
    ["world.world_manifest_sha256", shared.world.world_manifest_sha256],
    ["world.initial_state_sha256", shared.world.initial_state_sha256],
    ["gateway.schema_sha256", shared.gateway.schema_sha256],
    ["gateway.implementation_sha256", shared.gateway.implementation_sha256],
  ] as const) assertSha(digest, label);

  if (!Array.isArray(shared.tools) || shared.tools.length === 0) throw new Error("shared tool catalog must not be empty");
  const toolNames = new Set<string>();
  let prior = "";
  for (const tool of shared.tools) {
    assertExactKeys(tool, ["name", "input_schema_sha256", "semantic_contract_sha256", "implementation_sha256"], "tool semantic identity");
    assertId(tool.name, "tool name");
    if (tool.name <= prior) throw new Error("shared tool catalog must be uniquely sorted by name");
    prior = tool.name;
    if (toolNames.has(tool.name)) throw new Error("shared tool names must be unique");
    toolNames.add(tool.name);
    assertSha(tool.input_schema_sha256, `${tool.name}.input_schema_sha256`);
    assertSha(tool.semantic_contract_sha256, `${tool.name}.semantic_contract_sha256`);
    assertSha(tool.implementation_sha256, `${tool.name}.implementation_sha256`);
  }

  assertExactKeys(shared.limits, [
    "opportunity_count", "maximum_session_count", "maximum_duration_ms",
    "maximum_output_tokens_per_response", "maximum_tool_calls_per_opportunity",
  ], "condition limits");
  for (const [label, count] of Object.entries(shared.limits)) assertPositiveSafeInteger(count, `limits.${label}`);

  assertExactKeys(shared.registered_native_contract, [
    "complete_task_and_safety_policy", "complete_logical_tool_catalog",
    "chronological_continuity_across_planned_connections",
    "provider_recommended_resumption_and_context_management",
    "identical_world_gateway_and_tool_implementations",
  ], "registered Native comparator contract");
  for (const [guarantee, enabled] of Object.entries(shared.registered_native_contract)) {
    if (enabled !== true) throw new Error(`registered Native comparator guarantee ${guarantee} must be true`);
  }
}

export function sharedConditionSemanticsSha256(shared: SharedConditionSemantics): string {
  assertSharedConditionSemantics(shared);
  return sha256Hex(`${SHARED_DOMAIN}${canonicalJson(shared)}`);
}

function runtimeFromTreatment(signed: SignedHarnessTreatment): CompiledTreatmentRuntime {
  const switches = signed.manifest.switches;
  return immutableJson({
    context_delivery: switches.context_delivery,
    state_authority: switches.state_authority,
    capability_disclosure: switches.capability_disclosure,
    effect_admission: switches.effect_admission,
    effect_evidence: switches.effect_evidence,
    asynchronous_work: switches.asynchronous_work,
    repair_control: switches.repair_control,
    speech_release: switches.speech_release,
  }) as unknown as CompiledTreatmentRuntime;
}

function conditionBody(condition: CompiledBenchmarkCondition): Omit<CompiledBenchmarkCondition, "condition_sha256"> {
  return {
    schema_version: condition.schema_version,
    condition_id: condition.condition_id,
    pair_id: condition.pair_id,
    arm: condition.arm,
    execution_mode: condition.execution_mode,
    shared_semantics: condition.shared_semantics,
    signed_treatment: condition.signed_treatment,
    runtime: condition.runtime,
    shared_semantics_sha256: condition.shared_semantics_sha256,
  };
}

export function compileBenchmarkCondition(input: Readonly<{
  condition_id: string;
  execution_mode: "offline_development" | "paid_development" | "confirmatory";
  shared_semantics: SharedConditionSemantics;
  signed_treatment: SignedHarnessTreatment;
  authority: TreatmentVerificationAuthority;
}>): CompiledBenchmarkCondition {
  assertId(input.condition_id, "condition_id");
  assertSharedConditionSemantics(input.shared_semantics);
  verifySignedHarnessTreatment(input.signed_treatment, input.authority);
  const shared = immutableJson(input.shared_semantics) as unknown as SharedConditionSemantics;
  const sharedSha256 = sharedConditionSemanticsSha256(shared);
  if (input.signed_treatment.execution_binding.shared_semantics_sha256 !== sharedSha256) {
    throw new Error("signed treatment is bound to different shared condition semantics");
  }
  if (input.signed_treatment.manifest.confirmatory_eligible === false
    && input.execution_mode !== "offline_development") {
    throw new Error("ablation treatments are offline-only and cannot enter paid or confirmatory execution");
  }
  const body = immutableJson({
    schema_version: 1,
    condition_id: input.condition_id,
    pair_id: shared.pair_id,
    arm: input.signed_treatment.manifest.arm,
    execution_mode: input.execution_mode,
    shared_semantics: shared,
    signed_treatment: input.signed_treatment,
    runtime: runtimeFromTreatment(input.signed_treatment),
    shared_semantics_sha256: sharedSha256,
  }) as unknown as Omit<CompiledBenchmarkCondition, "condition_sha256">;
  return immutableJson({
    ...body,
    condition_sha256: sha256Hex(`${CONDITION_DOMAIN}${canonicalJson(body)}`),
  }) as unknown as CompiledBenchmarkCondition;
}

export function verifyCompiledBenchmarkCondition(
  condition: CompiledBenchmarkCondition,
  authority: TreatmentVerificationAuthority,
): void {
  assertExactKeys(condition, [
    "schema_version", "condition_id", "pair_id", "arm", "shared_semantics",
    "execution_mode", "signed_treatment", "runtime", "shared_semantics_sha256", "condition_sha256",
  ], "compiled benchmark condition");
  const rebuilt = compileBenchmarkCondition({
    condition_id: condition.condition_id,
    execution_mode: condition.execution_mode,
    shared_semantics: condition.shared_semantics,
    signed_treatment: condition.signed_treatment,
    authority,
  });
  if (canonicalJson(condition) !== canonicalJson(rebuilt)) {
    throw new Error("compiled benchmark condition is non-canonical, tampered, or contains a hidden semantic override");
  }
  if (condition.condition_sha256 !== sha256Hex(`${CONDITION_DOMAIN}${canonicalJson(conditionBody(condition))}`)) {
    throw new Error("compiled benchmark condition digest mismatch");
  }
}

function executionAttestationBody(
  attestation: ConditionExecutionAttestation,
): Omit<ConditionExecutionAttestation, "attestation_sha256"> {
  return {
    schema_version: attestation.schema_version,
    observation_source: attestation.observation_source,
    condition_sha256: attestation.condition_sha256,
    observed_shared_semantics: attestation.observed_shared_semantics,
    observed_runtime_implementation: attestation.observed_runtime_implementation,
  };
}

/** Seal identities collected from provider acknowledgements and loaded code. */
export function createConditionExecutionAttestation(input: Readonly<{
  condition: CompiledBenchmarkCondition;
  observed_shared_semantics: SharedConditionSemantics;
  observed_runtime_implementation: CompiledBenchmarkCondition["signed_treatment"]["execution_binding"]["runtime_implementation"];
  authority: TreatmentVerificationAuthority;
}>): ConditionExecutionAttestation {
  verifyCompiledBenchmarkCondition(input.condition, input.authority);
  assertSharedConditionSemantics(input.observed_shared_semantics);
  const body = immutableJson({
    schema_version: 1,
    observation_source: "runner_observed",
    condition_sha256: input.condition.condition_sha256,
    observed_shared_semantics: input.observed_shared_semantics,
    observed_runtime_implementation: input.observed_runtime_implementation,
  }) as unknown as Omit<ConditionExecutionAttestation, "attestation_sha256">;
  const attestation = immutableJson({
    ...body,
    attestation_sha256: sha256Hex(`${EXECUTION_ATTESTATION_DOMAIN}${canonicalJson(body)}`),
  }) as unknown as ConditionExecutionAttestation;
  verifyConditionExecutionAttestation({ condition: input.condition, attestation, authority: input.authority });
  return attestation;
}

export function verifyConditionExecutionAttestation(input: Readonly<{
  condition: CompiledBenchmarkCondition;
  attestation: ConditionExecutionAttestation;
  authority: TreatmentVerificationAuthority;
}>): void {
  verifyCompiledBenchmarkCondition(input.condition, input.authority);
  const expectedHash = sha256Hex(
    `${EXECUTION_ATTESTATION_DOMAIN}${canonicalJson(executionAttestationBody(input.attestation))}`,
  );
  if (input.attestation.attestation_sha256 !== expectedHash
    || input.attestation.condition_sha256 !== input.condition.condition_sha256
    || input.attestation.observation_source !== "runner_observed"
    || canonicalJson(input.attestation.observed_shared_semantics)
      !== canonicalJson(input.condition.shared_semantics)
    || canonicalJson(input.attestation.observed_runtime_implementation)
      !== canonicalJson(input.condition.signed_treatment.execution_binding.runtime_implementation)) {
    throw new Error("executed condition differs from its signed treatment or shared semantic boundary");
  }
}
