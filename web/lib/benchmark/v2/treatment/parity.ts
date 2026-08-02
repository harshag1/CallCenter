import { canonicalJson, immutableJson, sha256Hex } from "../../artifacts";
import { verifyCompiledBenchmarkCondition } from "./condition-compiler";
import type {
  CompiledBenchmarkCondition,
  TreatmentParityManifest,
  TreatmentVerificationAuthority,
} from "./types";

const PARITY_DOMAIN = "harshas-amazing-call-center/benchmark-v2/treatment-parity/v1\n";

const ALLOWED_DIFFERENCE_PATHS = Object.freeze([
  "$.arm",
  "$.condition_id",
  "$.condition_sha256",
  "$.runtime.asynchronous_work",
  "$.runtime.capability_disclosure",
  "$.runtime.context_delivery",
  "$.runtime.effect_admission",
  "$.runtime.effect_evidence",
  "$.runtime.repair_control",
  "$.runtime.speech_release",
  "$.runtime.state_authority",
  "$.signed_treatment.manifest.arm",
  "$.signed_treatment.manifest.confirmatory_eligible",
  "$.signed_treatment.manifest.intervention_family",
  "$.signed_treatment.manifest.manifest_sha256",
  "$.signed_treatment.manifest.switches.asynchronous_work",
  "$.signed_treatment.manifest.switches.capability_disclosure",
  "$.signed_treatment.manifest.switches.context_delivery",
  "$.signed_treatment.manifest.switches.effect_admission",
  "$.signed_treatment.manifest.switches.effect_evidence",
  "$.signed_treatment.manifest.switches.repair_control",
  "$.signed_treatment.manifest.switches.speech_release",
  "$.signed_treatment.manifest.switches.state_authority",
  "$.signed_treatment.manifest.treatment_id",
  "$.signed_treatment.execution_binding.runtime_implementation.asynchronous_work_sha256",
  "$.signed_treatment.execution_binding.runtime_implementation.capability_disclosure_sha256",
  "$.signed_treatment.execution_binding.runtime_implementation.context_delivery_sha256",
  "$.signed_treatment.execution_binding.runtime_implementation.effect_admission_sha256",
  "$.signed_treatment.execution_binding.runtime_implementation.effect_evidence_sha256",
  "$.signed_treatment.execution_binding.runtime_implementation.repair_control_sha256",
  "$.signed_treatment.execution_binding.runtime_implementation.speech_release_sha256",
  "$.signed_treatment.execution_binding.runtime_implementation.state_authority_sha256",
  "$.signed_treatment.signature.signature_base64",
  "$.signed_treatment.signature.signed_payload_sha256",
].sort());

function differingLeafPaths(left: unknown, right: unknown, path = "$", output: string[] = []): string[] {
  if (canonicalJson(left) === canonicalJson(right)) return output;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    output.push(path);
    return output;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      output.push(path);
      return output;
    }
    for (let index = 0; index < left.length; index += 1) {
      differingLeafPaths(left[index], right[index], `${path}[${index}]`, output);
    }
    return output;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()) {
    if (!(key in leftRecord) || !(key in rightRecord)) output.push(`${path}.${key}`);
    else differingLeafPaths(leftRecord[key], rightRecord[key], `${path}.${key}`, output);
  }
  return output;
}

function parityBody(manifest: TreatmentParityManifest): Omit<TreatmentParityManifest, "parity_sha256"> {
  return {
    schema_version: manifest.schema_version,
    pair_id: manifest.pair_id,
    native_condition_sha256: manifest.native_condition_sha256,
    hacc_condition_sha256: manifest.hacc_condition_sha256,
    native_treatment_sha256: manifest.native_treatment_sha256,
    hacc_treatment_sha256: manifest.hacc_treatment_sha256,
    treatment_authority_key_id: manifest.treatment_authority_key_id,
    treatment_authority_fingerprint_sha256:
      manifest.treatment_authority_fingerprint_sha256,
    shared_semantics_sha256: manifest.shared_semantics_sha256,
    allowed_difference_paths: manifest.allowed_difference_paths,
    observed_difference_paths: manifest.observed_difference_paths,
  };
}

export function createTreatmentParityManifest(input: Readonly<{
  native_condition: CompiledBenchmarkCondition;
  hacc_condition: CompiledBenchmarkCondition;
  authority: TreatmentVerificationAuthority;
}>): TreatmentParityManifest {
  verifyCompiledBenchmarkCondition(input.native_condition, input.authority);
  verifyCompiledBenchmarkCondition(input.hacc_condition, input.authority);
  const native = input.native_condition;
  const hacc = input.hacc_condition;
  if (native.arm !== "native" || native.signed_treatment.manifest.treatment_id !== "registered_native") {
    throw new Error("paired benchmark Native condition must use the registered_native treatment");
  }
  if (hacc.arm !== "hacc" || hacc.signed_treatment.manifest.treatment_id !== "full_hacc") {
    throw new Error("paired confirmatory HACC condition must use the full_hacc treatment");
  }
  if (!native.signed_treatment.manifest.confirmatory_eligible || !hacc.signed_treatment.manifest.confirmatory_eligible) {
    throw new Error("paired confirmatory benchmark cannot use an offline ablation treatment");
  }
  if (native.execution_mode !== hacc.execution_mode) throw new Error("paired conditions have different execution modes");
  if (native.pair_id !== hacc.pair_id) throw new Error("paired conditions have different pair_id values");
  if (native.condition_id === hacc.condition_id) throw new Error("paired conditions must have distinct condition_id values");
  if (native.signed_treatment.signature.key_id !== hacc.signed_treatment.signature.key_id
    || native.signed_treatment.signature.public_key_fingerprint_sha256
      !== hacc.signed_treatment.signature.public_key_fingerprint_sha256) {
    throw new Error("paired treatments were not signed by the same treatment authority");
  }
  if (native.shared_semantics_sha256 !== hacc.shared_semantics_sha256
    || canonicalJson(native.shared_semantics) !== canonicalJson(hacc.shared_semantics)) {
    const differences = differingLeafPaths(native.shared_semantics, hacc.shared_semantics);
    throw new Error(`hidden semantic asymmetry outside treatment switches: ${differences.join(", ")}`);
  }

  const observed = differingLeafPaths(native, hacc).sort();
  const disallowed = observed.filter((path) => !ALLOWED_DIFFERENCE_PATHS.includes(path));
  if (disallowed.length > 0) {
    throw new Error(`paired conditions differ outside the registered treatment boundary: ${disallowed.join(", ")}`);
  }
  const body = immutableJson({
    schema_version: 1,
    pair_id: native.pair_id,
    native_condition_sha256: native.condition_sha256,
    hacc_condition_sha256: hacc.condition_sha256,
    native_treatment_sha256: native.signed_treatment.manifest.manifest_sha256,
    hacc_treatment_sha256: hacc.signed_treatment.manifest.manifest_sha256,
    treatment_authority_key_id: native.signed_treatment.signature.key_id,
    treatment_authority_fingerprint_sha256:
      native.signed_treatment.signature.public_key_fingerprint_sha256,
    shared_semantics_sha256: native.shared_semantics_sha256,
    allowed_difference_paths: ALLOWED_DIFFERENCE_PATHS,
    observed_difference_paths: observed,
  }) as unknown as Omit<TreatmentParityManifest, "parity_sha256">;
  return immutableJson({
    ...body,
    parity_sha256: sha256Hex(`${PARITY_DOMAIN}${canonicalJson(body)}`),
  }) as unknown as TreatmentParityManifest;
}

export function verifyTreatmentParityManifest(input: Readonly<{
  manifest: TreatmentParityManifest;
  native_condition: CompiledBenchmarkCondition;
  hacc_condition: CompiledBenchmarkCondition;
  authority: TreatmentVerificationAuthority;
}>): void {
  const expected = createTreatmentParityManifest(input);
  if (canonicalJson(expected) !== canonicalJson(input.manifest)) {
    throw new Error("treatment parity manifest is stale, tampered, or bound to different conditions");
  }
  if (input.manifest.parity_sha256 !== sha256Hex(`${PARITY_DOMAIN}${canonicalJson(parityBody(input.manifest))}`)) {
    throw new Error("treatment parity manifest digest mismatch");
  }
}

export function compareConditionDifferences(
  left: CompiledBenchmarkCondition,
  right: CompiledBenchmarkCondition,
): readonly string[] {
  return Object.freeze(differingLeafPaths(left, right).sort());
}
