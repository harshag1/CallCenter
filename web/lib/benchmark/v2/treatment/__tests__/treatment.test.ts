import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, immutableJson, sha256Hex } from "../../../artifacts";
import {
  REGISTERED_TREATMENT_IDS,
  compareConditionDifferences,
  compileBenchmarkCondition,
  createConditionExecutionAttestation,
  createHarnessTreatmentManifest,
  createTreatmentParityManifest,
  signHarnessTreatment,
  sharedConditionSemanticsSha256,
  verifyCompiledBenchmarkCondition,
  verifyConditionExecutionAttestation,
  verifySignedHarnessTreatment,
  verifyTreatmentParityManifest,
  type CompiledBenchmarkCondition,
  type SharedConditionSemantics,
  type TreatmentRuntimeImplementation,
} from "..";

const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const signingAuthority = { key_id: "protocol-freeze-key-1", private_key: keys.privateKey };
const verificationAuthority = { key_id: "protocol-freeze-key-1", public_key: keys.publicKey };

const h = (label: string) => sha256Hex(label);

function implementation(label: string): TreatmentRuntimeImplementation {
  return {
    condition_compiler_sha256: h("condition compiler"),
    context_delivery_sha256: h(`${label} context`),
    state_authority_sha256: h(`${label} state`),
    capability_disclosure_sha256: h(`${label} capability`),
    effect_admission_sha256: h(`${label} admission`),
    effect_evidence_sha256: h(`${label} evidence`),
    asynchronous_work_sha256: h(`${label} async`),
    repair_control_sha256: h(`${label} repair`),
    speech_release_sha256: h(`${label} speech`),
  };
}

function shared(overrides: Partial<SharedConditionSemantics> = {}): SharedConditionSemantics {
  return immutableJson({
    schema_version: 1,
    benchmark_id: "hacc-longflow-c108",
    protocol_sha256: h("protocol"),
    pair_id: "pair-openai-001",
    scenario_sha256: h("scenario"),
    caller_schedule_sha256: h("caller schedule"),
    task_policy_sha256: h("task policy"),
    safety_policy_sha256: h("safety policy"),
    provider: {
      provider_id: "openai",
      model_id: "gpt-realtime-2026-01-01",
      voice_id: "marin",
      base_session_configuration_sha256: h("base session"),
    },
    audio: {
      input_manifest_sha256: h("audio input"),
      delivery_profile_sha256: h("audio delivery"),
      codec_profile_sha256: h("codec"),
    },
    world: {
      world_manifest_sha256: h("world"),
      initial_state_sha256: h("world genesis"),
    },
    gateway: {
      schema_sha256: h("gateway schema"),
      implementation_sha256: h("gateway implementation"),
    },
    tools: [
      { name: "lookup_member", input_schema_sha256: h("lookup schema"), semantic_contract_sha256: h("lookup semantics"), implementation_sha256: h("lookup implementation") },
      { name: "renew_membership", input_schema_sha256: h("renew schema"), semantic_contract_sha256: h("renew semantics"), implementation_sha256: h("renew implementation") },
    ],
    limits: {
      opportunity_count: 60,
      maximum_session_count: 6,
      maximum_duration_ms: 7_200_000,
      maximum_output_tokens_per_response: 4_096,
      maximum_tool_calls_per_opportunity: 8,
    },
    registered_native_contract: {
      complete_task_and_safety_policy: true,
      complete_logical_tool_catalog: true,
      chronological_continuity_across_planned_connections: true,
      provider_recommended_resumption_and_context_management: true,
      identical_world_gateway_and_tool_implementations: true,
    },
    ...overrides,
  }) as unknown as SharedConditionSemantics;
}

function condition(treatment: "registered_native" | "full_hacc", semantics = shared()) {
  const signed = signHarnessTreatment(
    createHarnessTreatmentManifest(treatment),
    {
      schema_version: 1,
      shared_semantics_sha256: sharedConditionSemanticsSha256(semantics),
      runtime_implementation: implementation(treatment),
    },
    signingAuthority,
  );
  return compileBenchmarkCondition({
    condition_id: `${semantics.pair_id}:${treatment}`,
    execution_mode: "confirmatory",
    shared_semantics: semantics,
    signed_treatment: signed,
    authority: verificationAuthority,
  });
}

describe("HarnessTreatment manifests", () => {
  it("registers exactly two confirmatory arms and three offline-only ablations", () => {
    expect(REGISTERED_TREATMENT_IDS).toEqual([
      "full_hacc",
      "hacc_without_capability_scoping",
      "hacc_without_context_compiler",
      "hacc_without_effect_receipts",
      "registered_native",
    ]);
    expect(createHarnessTreatmentManifest("registered_native").confirmatory_eligible).toBe(true);
    expect(createHarnessTreatmentManifest("full_hacc").confirmatory_eligible).toBe(true);
    for (const id of REGISTERED_TREATMENT_IDS.filter((value) => value.startsWith("hacc_without_"))) {
      expect(createHarnessTreatmentManifest(id).confirmatory_eligible).toBe(false);
    }
  });

  it("defines a strong Native condition and isolates each ablation", () => {
    const native = createHarnessTreatmentManifest("registered_native");
    expect(native.switches).toEqual({
      context_delivery: "chronological_provider_history",
      state_authority: "provider_session",
      capability_disclosure: "complete_registered_catalog",
      effect_admission: "shared_gateway_schema",
      effect_evidence: "provider_acknowledgement",
      asynchronous_work: "provider_inline",
      repair_control: "provider_default",
      speech_release: "provider_output",
    });
    const full = createHarnessTreatmentManifest("full_hacc");
    for (const id of [
      "hacc_without_context_compiler",
      "hacc_without_capability_scoping",
      "hacc_without_effect_receipts",
    ] as const) {
      const ablation = createHarnessTreatmentManifest(id);
      const changed = Object.keys(full.switches).filter(
        (key) => full.switches[key as keyof typeof full.switches] !== ablation.switches[key as keyof typeof ablation.switches],
      );
      expect(changed).toHaveLength(1);
    }
  });

  it("deep-freezes manifests and produces deterministic digests", () => {
    const one = createHarnessTreatmentManifest("full_hacc");
    const two = createHarnessTreatmentManifest("full_hacc");
    expect(one).toEqual(two);
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one.switches)).toBe(true);
  });

  it("signs treatment switches and rejects tampering or the wrong authority", () => {
    const signed = signHarnessTreatment(createHarnessTreatmentManifest("full_hacc"), {
      schema_version: 1,
      shared_semantics_sha256: sharedConditionSemanticsSha256(shared()),
      runtime_implementation: implementation("full_hacc"),
    }, signingAuthority);
    expect(() => verifySignedHarnessTreatment(signed, verificationAuthority)).not.toThrow();
    expect(() => verifySignedHarnessTreatment(signed, {
      key_id: verificationAuthority.key_id,
      public_key: otherKeys.publicKey,
    })).toThrow(/fingerprint mismatch/);
    const tampered = {
      ...signed,
      manifest: {
        ...signed.manifest,
        switches: { ...signed.manifest.switches, effect_admission: "shared_gateway_schema" },
      },
    } as typeof signed;
    expect(() => verifySignedHarnessTreatment(tampered, verificationAuthority)).toThrow(/not an exact registered treatment/);
  });

  it("rejects noncanonical Base64 encodings of identical Ed25519 bytes", () => {
    const signed = signHarnessTreatment(createHarnessTreatmentManifest("full_hacc"), {
      schema_version: 1,
      shared_semantics_sha256: sharedConditionSemanticsSha256(shared()),
      runtime_implementation: implementation("full_hacc"),
    }, signingAuthority);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const value = signed.signature.signature_base64;
    const position = value.length - 3;
    const replacement = alphabet[alphabet.indexOf(value[position]!) + 1]!;
    const malleable = `${value.slice(0, position)}${replacement}${value.slice(position + 1)}`;
    expect(Buffer.from(malleable, "base64")).toEqual(Buffer.from(value, "base64"));
    expect(() => verifySignedHarnessTreatment({
      ...signed,
      signature: { ...signed.signature, signature_base64: malleable },
    }, verificationAuthority)).toThrow(/canonical base64/);
  });
});

describe("condition compilation and parity", () => {
  it("compiles immutable, deterministic Native and Full HACC conditions", () => {
    const native = condition("registered_native");
    const hacc = condition("full_hacc");
    expect(native.shared_semantics_sha256).toBe(hacc.shared_semantics_sha256);
    expect(native.runtime.context_delivery).toBe("chronological_provider_history");
    expect(hacc.runtime.context_delivery).toBe("compiled_turn_contract");
    expect(Object.isFrozen(hacc.shared_semantics.tools)).toBe(true);
    expect(() => verifyCompiledBenchmarkCondition(native, verificationAuthority)).not.toThrow();
    expect(() => verifyCompiledBenchmarkCondition(hacc, verificationAuthority)).not.toThrow();
  });

  it("proves shared model, voice, audio, world, gateway, tools and limits", () => {
    const native = condition("registered_native");
    const hacc = condition("full_hacc");
    const parity = createTreatmentParityManifest({
      native_condition: native,
      hacc_condition: hacc,
      authority: verificationAuthority,
    });
    expect(parity.shared_semantics_sha256).toBe(native.shared_semantics_sha256);
    expect(parity.observed_difference_paths).not.toContain("$.shared_semantics.provider.model_id");
    expect(parity.observed_difference_paths).toContain("$.runtime.context_delivery");
    expect(parity.observed_difference_paths.every((path) => parity.allowed_difference_paths.includes(path))).toBe(true);
    expect(() => verifyTreatmentParityManifest({
      manifest: parity,
      native_condition: native,
      hacc_condition: hacc,
      authority: verificationAuthority,
    })).not.toThrow();
  });

  it.each([
    ["model", { provider: { ...shared().provider, model_id: "different-model" } }],
    ["voice", { provider: { ...shared().provider, voice_id: "different-voice" } }],
    ["audio", { audio: { ...shared().audio, input_manifest_sha256: h("different audio") } }],
    ["world", { world: { ...shared().world, world_manifest_sha256: h("different world") } }],
    ["gateway", { gateway: { ...shared().gateway, implementation_sha256: h("different gateway") } }],
    ["tools", { tools: [{ ...shared().tools[0]!, implementation_sha256: h("different tool") }, shared().tools[1]!] }],
    ["limits", { limits: { ...shared().limits, opportunity_count: 59 } }],
  ])("fails closed on hidden %s asymmetry", (_label, override) => {
    const native = condition("registered_native");
    const hacc = condition("full_hacc", shared(override as Partial<SharedConditionSemantics>));
    expect(() => createTreatmentParityManifest({
      native_condition: native,
      hacc_condition: hacc,
      authority: verificationAuthority,
    })).toThrow(/hidden semantic asymmetry/);
  });

  it("rejects unsigned runtime overrides even when an attacker recalculates the condition digest", () => {
    const compiled = condition("full_hacc");
    const tamperedBody = {
      schema_version: compiled.schema_version,
      condition_id: compiled.condition_id,
      pair_id: compiled.pair_id,
      arm: compiled.arm,
      execution_mode: compiled.execution_mode,
      shared_semantics: compiled.shared_semantics,
      signed_treatment: compiled.signed_treatment,
      runtime: { ...compiled.runtime, capability_disclosure: "complete_registered_catalog" },
      shared_semantics_sha256: compiled.shared_semantics_sha256,
    };
    const tampered = {
      ...tamperedBody,
      condition_sha256: sha256Hex(
        `harshas-amazing-call-center/benchmark-v2/compiled-condition/v1\n${canonicalJson(tamperedBody)}`,
      ),
    } as CompiledBenchmarkCondition;
    expect(() => verifyCompiledBenchmarkCondition(tampered, verificationAuthority)).toThrow(/non-canonical|tampered|hidden/);
  });

  it("binds the treatment signature to shared semantics and concrete mechanism implementations", () => {
    const semantics = shared();
    const signed = signHarnessTreatment(createHarnessTreatmentManifest("full_hacc"), {
      schema_version: 1,
      shared_semantics_sha256: sharedConditionSemanticsSha256(semantics),
      runtime_implementation: implementation("full_hacc"),
    }, signingAuthority);
    expect(() => compileBenchmarkCondition({
      condition_id: "pair-openai-001:wrong-shared-binding",
      execution_mode: "confirmatory",
      shared_semantics: shared({ scenario_sha256: h("substituted scenario") }),
      signed_treatment: signed,
      authority: verificationAuthority,
    })).toThrow(/bound to different shared/);
    const implementationTamper = {
      ...signed,
      execution_binding: {
        ...signed.execution_binding,
        runtime_implementation: {
          ...signed.execution_binding.runtime_implementation,
          effect_admission_sha256: h("fake lease engine"),
        },
      },
    } as typeof signed;
    expect(() => verifySignedHarnessTreatment(implementationTamper, verificationAuthority)).toThrow(/payload digest mismatch|signature verification failed/);
  });

  it("fails post-run sealing on observed provider, tool, audio, or mechanism drift", () => {
    const compiled = condition("full_hacc");
    const valid = createConditionExecutionAttestation({
      condition: compiled,
      observed_shared_semantics: compiled.shared_semantics,
      observed_runtime_implementation:
        compiled.signed_treatment.execution_binding.runtime_implementation,
      authority: verificationAuthority,
    });
    expect(() => verifyConditionExecutionAttestation({
      condition: compiled,
      attestation: valid,
      authority: verificationAuthority,
    })).not.toThrow();
    expect(() => createConditionExecutionAttestation({
      condition: compiled,
      observed_shared_semantics: shared({
        provider: { ...shared().provider, model_id: "substituted-model" },
      }),
      observed_runtime_implementation:
        compiled.signed_treatment.execution_binding.runtime_implementation,
      authority: verificationAuthority,
    })).toThrow(/executed condition differs/);
    expect(() => createConditionExecutionAttestation({
      condition: compiled,
      observed_shared_semantics: compiled.shared_semantics,
      observed_runtime_implementation: {
        ...compiled.signed_treatment.execution_binding.runtime_implementation,
        context_delivery_sha256: h("substituted context compiler"),
      },
      authority: verificationAuthority,
    })).toThrow(/executed condition differs/);
  });

  it("rejects unknown fields and weak Native guarantees", () => {
    expect(() => condition("registered_native", {
      ...shared(),
      hidden_prompt_sha256: h("answer key"),
    } as unknown as SharedConditionSemantics)).toThrow(/unknown or missing fields/);
    expect(() => condition("registered_native", shared({
      registered_native_contract: {
        ...shared().registered_native_contract,
        complete_logical_tool_catalog: false,
      } as unknown as SharedConditionSemantics["registered_native_contract"],
    }))).toThrow(/must be true/);
  });

  it("does not admit ablations into a confirmatory parity manifest", () => {
    const ablation = compileBenchmarkCondition({
      condition_id: "pair-openai-001:ablation",
      execution_mode: "offline_development",
      shared_semantics: shared(),
      signed_treatment: signHarnessTreatment(
        createHarnessTreatmentManifest("hacc_without_context_compiler"),
        {
          schema_version: 1,
          shared_semantics_sha256: sharedConditionSemanticsSha256(shared()),
          runtime_implementation: implementation("ablation"),
        },
        signingAuthority,
      ),
      authority: verificationAuthority,
    });
    expect(() => createTreatmentParityManifest({
      native_condition: condition("registered_native"),
      hacc_condition: ablation,
      authority: verificationAuthority,
    })).toThrow(/full_hacc/);
  });

  it.each(["paid_development", "confirmatory"] as const)(
    "rejects offline ablations from %s before execution admission",
    (executionMode) => {
      const semantics = shared();
      const signed = signHarnessTreatment(
        createHarnessTreatmentManifest("hacc_without_context_compiler"),
        {
          schema_version: 1,
          shared_semantics_sha256: sharedConditionSemanticsSha256(semantics),
          runtime_implementation: implementation("ablation"),
        },
        signingAuthority,
      );
      expect(() => compileBenchmarkCondition({
        condition_id: `pair-openai-001:ablation:${executionMode}`,
        execution_mode: executionMode,
        shared_semantics: semantics,
        signed_treatment: signed,
        authority: verificationAuthority,
      })).toThrow(/offline-only/);
    },
  );

  it("exposes an auditable leaf-level difference inventory", () => {
    const differences = compareConditionDifferences(condition("registered_native"), condition("full_hacc"));
    expect(differences).toContain("$.signed_treatment.manifest.switches.state_authority");
    expect(differences.some((path) => path.startsWith("$.shared_semantics"))).toBe(false);
  });
});
