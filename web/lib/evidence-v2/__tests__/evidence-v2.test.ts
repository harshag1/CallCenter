import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EvidenceTapV2,
  canonicalEvidenceJsonV2,
  createEd25519EvidenceSignerV2,
  evidenceSha256HexV2,
  frozenEvidenceEvaluationContractSha256V2,
  replayEvidenceBundleV2,
  serializeEvidenceBundleV2,
  type EvidenceArtifactResolverV2,
  type EvidenceBundleV2,
  type FrozenEvidenceEvaluationContractV2,
} from "..";

const keys = generateKeyPairSync("ed25519");
const signer = createEd25519EvidenceSignerV2({
  signerId: "offline-evidence-authority",
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const trust = { signer_id: signer.signer_id, public_key_pem: signer.public_key_pem } as const;
const H = (character: string) => character.repeat(64);

type Fixture = Readonly<{
  bundle: EvidenceBundleV2;
  contract: FrozenEvidenceEvaluationContractV2;
  contractSha256: string;
  resolver: EvidenceArtifactResolverV2;
  replay(input: unknown, expectedRunId?: string): ReturnType<typeof replayEvidenceBundleV2>;
}>;

function fixture(runId = "run-evidence-001", unsafeClaim = false, worldTruth = true, includeEffect = true): Fixture {
  const artifacts = new Map<string, Uint8Array>();
  const putBytes = (bytes: Uint8Array) => {
    const digest = evidenceSha256HexV2(bytes); artifacts.set(digest, Uint8Array.from(bytes)); return digest;
  };
  const putText = (text: string) => putBytes(new TextEncoder().encode(text));
  const putJson = (value: unknown) => putText(`${canonicalEvidenceJsonV2(value)}\n`);
  const descriptor = (artifactId: string, bytes: Uint8Array, mediaType = "application/json") => {
    const digest = putBytes(bytes);
    return { artifact_id: artifactId, sha256: digest, byte_length: bytes.byteLength, media_type: mediaType } as const;
  };
  const scenario = descriptor("scenario", new TextEncoder().encode("frozen scenario bytes\n"), "text/plain");
  const plan = descriptor("plan", new TextEncoder().encode("frozen plan bytes\n"), "text/plain");
  const catalog = descriptor("catalog", new TextEncoder().encode("frozen catalog bytes\n"), "text/plain");
  const audioBytes = new Uint8Array(32_000).fill(7);
  const audioSha256 = putBytes(audioBytes);
  const claimIds = unsafeClaim ? ["forbidden-premature"] : ["confirmation-qualified"];
  const alignmentSha256 = putJson({
    schema_version: 2,
    artifact_type: "hacc_audio_semantic_alignment",
    response_id: "response-1",
    audio_sha256: audioSha256,
    start_sample: 0,
    end_sample: 16_000,
    claim_ids: claimIds,
    opportunity_ids: ["opp-1"],
  });
  const worldStateSha256 = putJson({
    schema_version: 2,
    artifact_type: "hacc_world_snapshot",
    scenario_id: "scenario-1",
    world_revision: 1,
    state: {
      goal: { complete: worldTruth },
      steps: { identify: worldTruth, resolve: worldTruth },
      obligations: { send_confirmation: worldTruth },
    },
    corrections_applied_ids: [],
    committed_effects: includeEffect ? [{ semantic_effect_id: "effect-1", authorized_attempt_id: "attempt-1" }] : [],
  });
  const resolver: EvidenceArtifactResolverV2 = {
    resolver_id: "independent-cas-1",
    resolve(digest) { const value = artifacts.get(digest); return value ? Uint8Array.from(value) : null; },
  };
  const contract: FrozenEvidenceEvaluationContractV2 = {
    schema_version: 2,
    contract_type: "hacc_frozen_evidence_evaluation",
    contract_id: "evaluation-1",
    scenario_id: "scenario-1",
    artifact_resolver_id: resolver.resolver_id,
    scenario_artifact: scenario,
    plan: { plan_id: "plan-1", revision: 1, artifact: plan, required_step_ids: ["identify", "resolve"] },
    catalog: { catalog_id: "catalog-1", revision: 1, artifact: catalog, capability_ids: ["return.commit"] },
    required_goal_predicate_ids: ["goal-predicate-1"],
    required_obligation_ids: ["send-confirmation"],
    required_opportunity_ids: ["opp-1"],
    forbidden_claim_ids: ["forbidden-premature"],
    world_predicates: [
      { predicate_id: "goal-predicate-1", path: ["goal", "complete"], expected: true },
      { predicate_id: "step-identify-predicate", path: ["steps", "identify"], expected: true },
      { predicate_id: "step-resolve-predicate", path: ["steps", "resolve"], expected: true },
      { predicate_id: "obligation-confirmation-predicate", path: ["obligations", "send_confirmation"], expected: true },
    ],
    step_predicate_bindings: [
      { step_id: "identify", predicate_id: "step-identify-predicate" },
      { step_id: "resolve", predicate_id: "step-resolve-predicate" },
    ],
    obligation_predicate_bindings: [
      { obligation_id: "send-confirmation", predicate_id: "obligation-confirmation-predicate" },
    ],
    minimum_inventory: { required_steps: 1, required_obligations: 1, required_opportunities: 1, forbidden_claims: 1 },
  };
  const contractSha256 = frozenEvidenceEvaluationContractSha256V2(contract);
  const tap = new EvidenceTapV2({ runId, signer });
  tap.append("plan.registered", {
    plan_id: "plan-1", revision: 1, plan_sha256: plan.sha256,
    required_step_ids: ["identify", "resolve"], required_obligation_ids: ["send-confirmation"],
    forbidden_claim_ids: ["forbidden-premature"],
  }, "2026-08-02T18:00:00.000Z");
  tap.append("catalog.published", {
    catalog_id: "catalog-1", plan_id: "plan-1", revision: 1,
    catalog_sha256: catalog.sha256, capability_ids: ["return.commit"],
  }, "2026-08-02T18:00:00.010Z");
  tap.append("provider.normalized", {
    provider: "provider-a", session_id: "session-1", provider_event_id: "wire-1", provider_sequence: 0,
    kind: "input_audio_end", turn_id: "turn-1", raw_event_sha256: putText("raw provider event\n"),
  }, "2026-08-02T18:00:00.100Z");
  tap.append("action.attempted", {
    attempt_id: "attempt-1", action_id: "return.create", capability_id: "return.commit",
    plan_revision: 1, arguments_sha256: putText("action arguments\n"),
  }, "2026-08-02T18:00:00.110Z");
  tap.append("action.policy_decided", {
    attempt_id: "attempt-1", decision: "allow", policy_sha256: putText("policy decision\n"), reason_code: "within_scope",
  }, "2026-08-02T18:00:00.120Z");
  tap.append("action.receipt", {
    attempt_id: "attempt-1", receipt_id: "receipt-1", status: "committed",
    semantic_effect_id: "effect-1", result_sha256: putText("receipt result\n"), world_revision: 1,
  }, "2026-08-02T18:00:00.130Z");
  tap.append("worker.event", {
    worker_event_id: "worker-event-1", worker_id: "worker-1", parent_worker_id: null,
    call_id: "call-1", plan_revision: 1, kind: "spawned", result_sha256: null,
  }, "2026-08-02T18:00:00.140Z");
  tap.append("worker.event", {
    worker_event_id: "worker-event-2", worker_id: "worker-1", parent_worker_id: null,
    call_id: "call-1", plan_revision: 1, kind: "completed", result_sha256: putText("worker result\n"),
  }, "2026-08-02T18:00:00.150Z");
  tap.append("audio.range", {
    response_id: "response-1", audio_sha256: audioSha256, byte_length: audioBytes.byteLength,
    sample_rate_hz: 16_000, channel_count: 1, start_sample: 0, end_sample: 16_000,
    claim_ids: claimIds, opportunity_ids: ["opp-1"], semantic_alignment_sha256: alignmentSha256,
  }, "2026-08-02T18:00:00.200Z");
  tap.append("playback.range", {
    playback_event_id: "playback-1", response_id: "response-1", start_sample: 0, end_sample: 16_000, status: "released",
  }, "2026-08-02T18:00:00.250Z");
  tap.append("playback.range", {
    playback_event_id: "playback-2", response_id: "response-1", start_sample: 0, end_sample: 12_000, status: "heard",
  }, "2026-08-02T18:00:00.300Z");
  const worldBase = { world_revision: 1, world_state_sha256: worldStateSha256 } as const;
  tap.append("world.event", { world_event_id: "world-1", kind: "effect.committed", required_step_id: null, obligation_id: null, correction_id: null, authorized_attempt_id: "attempt-1", semantic_effect_id: "effect-1", ...worldBase }, "2026-08-02T18:00:00.310Z");
  tap.append("world.event", { world_event_id: "world-2", kind: "step.completed", required_step_id: "identify", obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, ...worldBase }, "2026-08-02T18:00:00.320Z");
  tap.append("world.event", { world_event_id: "world-3", kind: "step.completed", required_step_id: "resolve", obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, ...worldBase }, "2026-08-02T18:00:00.330Z");
  tap.append("world.event", { world_event_id: "world-4", kind: "obligation.completed", required_step_id: null, obligation_id: "send-confirmation", correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, ...worldBase }, "2026-08-02T18:00:00.340Z");
  tap.append("world.event", { world_event_id: "world-5", kind: "goal.completed", required_step_id: null, obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, ...worldBase }, "2026-08-02T18:00:00.350Z");
  tap.append("usage.recorded", {
    usage_id: "usage-1", provider: "provider-a", model: "realtime-1", input_audio_tokens: 100,
    output_audio_tokens: 50, input_text_tokens: 25, output_text_tokens: 10, cost_microusd: 12_345,
    pricing_artifact_sha256: putText("frozen pricing calculation\n"),
  }, "2026-08-02T18:00:00.360Z");
  const bundle = tap.finalize({ disposition_id: "terminal-1", status: "completed", reason_code: null }, "2026-08-02T18:00:00.400Z");
  return {
    bundle, contract, contractSha256, resolver,
    replay(input, expectedRunId = runId) {
      return replayEvidenceBundleV2(input, {
        trust, expectedRunId, evaluationContract: contract,
        expectedEvaluationContractSha256: contractSha256, artifactResolver: resolver,
      });
    },
  };
}

function selfDeclaredFakeBundle(): EvidenceBundleV2 {
  const tap = new EvidenceTapV2({ runId: "fake-run", signer });
  tap.append("plan.registered", { plan_id: "fake-plan", revision: 1, plan_sha256: H("1"), required_step_ids: [], required_obligation_ids: [], forbidden_claim_ids: [] });
  tap.append("catalog.published", { catalog_id: "fake-catalog", plan_id: "fake-plan", revision: 1, catalog_sha256: H("2"), capability_ids: ["fake-cap"] });
  tap.append("provider.normalized", { provider: "fake", session_id: "fake-session", provider_event_id: "fake-wire", provider_sequence: 0, kind: "input_audio_end", turn_id: null, raw_event_sha256: H("3") });
  tap.append("action.attempted", { attempt_id: "fake-attempt", action_id: "fake-action", capability_id: "fake-cap", plan_revision: 1, arguments_sha256: H("4") });
  tap.append("action.policy_decided", { attempt_id: "fake-attempt", decision: "allow", policy_sha256: H("5"), reason_code: "self" });
  tap.append("action.receipt", { attempt_id: "fake-attempt", receipt_id: "fake-receipt", status: "committed", semantic_effect_id: "fake-effect", result_sha256: H("6"), world_revision: 1 });
  tap.append("worker.event", { worker_event_id: "fake-worker-event", worker_id: "fake-worker", parent_worker_id: null, call_id: "fake-call", plan_revision: 1, kind: "spawned", result_sha256: null });
  tap.append("audio.range", { response_id: "fake-response", audio_sha256: H("7"), byte_length: 1, sample_rate_hz: 1, channel_count: 1, start_sample: 0, end_sample: 1, claim_ids: [], opportunity_ids: [], semantic_alignment_sha256: H("8") });
  tap.append("playback.range", { playback_event_id: "fake-playback", response_id: "fake-response", start_sample: 0, end_sample: 1, status: "heard" });
  tap.append("world.event", { world_event_id: "fake-world", kind: "goal.completed", required_step_id: null, obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, world_revision: 1, world_state_sha256: H("9") });
  tap.append("usage.recorded", { usage_id: "fake-usage", provider: "fake", model: "fake", input_audio_tokens: 0, output_audio_tokens: 0, input_text_tokens: 0, output_text_tokens: 0, cost_microusd: 0, pricing_artifact_sha256: H("a") });
  return tap.finalize({ disposition_id: "fake-terminal", status: "completed", reason_code: null });
}

describe("production-neutral EvidenceTap v2", () => {
  it("reopens independently registered artifacts and derives useful-mission endpoints offline", () => {
    const value = fixture();
    const result = value.replay(serializeEvidenceBundleV2(value.bundle));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.endpoints).toEqual({
      useful_mission_success: true, terminal_status: "completed", goal_completed: true,
      required_steps_total: 2, required_steps_completed: 2,
      required_obligations_total: 1, required_obligations_completed: 1,
      required_opportunities_total: 1, required_opportunities_disposed: 1,
      unauthorized_effect_count: 0, duplicate_effect_count: 0,
      unresolved_indeterminate_effect_count: 0, unsafe_released_claim_count: 0,
      heard_audio_sample_count: 12_000, safe_first_audio_latency_ms: 150,
      worker_spawn_count: 1, worker_terminal_count: 1,
      usage: { input_audio_tokens: 100, output_audio_tokens: 50, input_text_tokens: 25, output_text_tokens: 10, cost_microusd: 12_345 },
    });
  });

  it("rejects the fully signed self-declared fake-success attack", () => {
    const legitimate = fixture();
    const result = legitimate.replay(selfDeclaredFakeBundle(), "fake-run");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fake evidence rejection");
    expect(result.errors.some((error) => error.code === "plan_contract_mismatch")).toBe(true);
    expect(result.errors.some((error) => error.code === "missing_artifact")).toBe(true);
  });

  it("rejects an empty or substituted evaluation contract even with a valid bundle signature", () => {
    const value = fixture();
    const empty = structuredClone(value.contract) as FrozenEvidenceEvaluationContractV2;
    Object.assign(empty.plan, { required_step_ids: [] });
    Object.assign(empty, { required_goal_predicate_ids: [], required_obligation_ids: [], required_opportunity_ids: [], forbidden_claim_ids: [] });
    const emptyResult = replayEvidenceBundleV2(value.bundle, {
      trust, expectedRunId: value.bundle.run_id, evaluationContract: empty,
      expectedEvaluationContractSha256: value.contractSha256, artifactResolver: value.resolver,
    });
    expect(emptyResult.ok).toBe(false);
    if (emptyResult.ok) throw new Error("expected empty contract rejection");
    expect(emptyResult.errors.some((error) => error.code === "invalid_expectation")).toBe(true);

    const substituted = structuredClone(value.contract) as FrozenEvidenceEvaluationContractV2;
    Object.assign(substituted, { scenario_id: "different-scenario" });
    const substitutedResult = replayEvidenceBundleV2(value.bundle, {
      trust, expectedRunId: value.bundle.run_id, evaluationContract: substituted,
      expectedEvaluationContractSha256: value.contractSha256, artifactResolver: value.resolver,
    });
    expect(substitutedResult.ok).toBe(false);
    if (substitutedResult.ok) throw new Error("expected contract substitution rejection");
    expect(substitutedResult.errors.some((error) => error.code === "evaluation_contract_mismatch")).toBe(true);
  });

  it("rejects nonexistent, mutated, and length-mismatched reopened artifact bytes", () => {
    const value = fixture();
    const missing = { resolver_id: value.resolver.resolver_id, resolve: () => null };
    const missingResult = replayEvidenceBundleV2(value.bundle, { trust, expectedRunId: value.bundle.run_id, evaluationContract: value.contract, expectedEvaluationContractSha256: value.contractSha256, artifactResolver: missing });
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) throw new Error("expected missing artifact rejection");
    expect(missingResult.errors.some((error) => error.code === "missing_artifact")).toBe(true);

    const corrupt = { resolver_id: value.resolver.resolver_id, resolve: (digest: string) => {
      const bytes = value.resolver.resolve(digest); if (!bytes) return null; bytes[0] ^= 1; return bytes;
    } };
    const corruptResult = replayEvidenceBundleV2(value.bundle, { trust, expectedRunId: value.bundle.run_id, evaluationContract: value.contract, expectedEvaluationContractSha256: value.contractSha256, artifactResolver: corrupt });
    expect(corruptResult.ok).toBe(false);
    if (corruptResult.ok) throw new Error("expected mutated artifact rejection");
    expect(corruptResult.errors.some((error) => error.code === "artifact_hash_mismatch")).toBe(true);
  });

  it("derives unsafe audibility from reopened alignment rather than terminal success", () => {
    const value = fixture("run-evidence-001", true);
    const result = value.replay(value.bundle);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.endpoints).toMatchObject({ useful_mission_success: false, unsafe_released_claim_count: 1 });
  });

  it("rejects terminal, world-event, and receipt success claims contradicted by reopened world bytes", () => {
    const falseWorld = fixture("run-false-world", false, false);
    const falseWorldResult = falseWorld.replay(falseWorld.bundle);
    expect(falseWorldResult.ok).toBe(false);
    if (falseWorldResult.ok) throw new Error("expected false world claim rejection");
    expect(falseWorldResult.errors.some((error) => error.code === "world_claim_mismatch")).toBe(true);

    const absentEffect = fixture("run-absent-effect", false, true, false);
    const absentEffectResult = absentEffect.replay(absentEffect.bundle);
    expect(absentEffectResult.ok).toBe(false);
    if (absentEffectResult.ok) throw new Error("expected receipt/world mismatch rejection");
    expect(absentEffectResult.errors.some((error) => error.code === "receipt_world_mismatch")).toBe(true);
  });

  it("fails closed on bundle byte mutation, event deletion, reorder, and substitution", () => {
    const value = fixture();
    const mutated = serializeEvidenceBundleV2(value.bundle).replace("provider-a", "provider-b");
    expect(value.replay(mutated).ok).toBe(false);
    const deleted = structuredClone(value.bundle) as unknown as { events: unknown[] }; deleted.events.splice(5, 1);
    expect(value.replay(deleted).ok).toBe(false);
    const reordered = structuredClone(value.bundle) as unknown as { events: unknown[] };
    [reordered.events[3], reordered.events[4]] = [reordered.events[4], reordered.events[3]];
    expect(value.replay(reordered).ok).toBe(false);
    const other = fixture("run-evidence-002");
    const substituted = structuredClone(value.bundle) as unknown as { events: unknown[] }; substituted.events[3] = other.bundle.events[3];
    expect(value.replay(substituted).ok).toBe(false);
  });

  it("fails closed on signer, resolver, terminal journal, and manifest-root mismatch", () => {
    const value = fixture();
    const otherKeys = generateKeyPairSync("ed25519");
    const signerResult = replayEvidenceBundleV2(value.bundle, {
      trust: { signer_id: "other", public_key_pem: otherKeys.publicKey.export({ type: "spki", format: "pem" }).toString() },
      expectedRunId: value.bundle.run_id, evaluationContract: value.contract,
      expectedEvaluationContractSha256: value.contractSha256, artifactResolver: value.resolver,
    });
    expect(signerResult.ok).toBe(false);
    const wrongResolver = { ...value.resolver, resolver_id: "other-resolver" };
    expect(replayEvidenceBundleV2(value.bundle, { trust, expectedRunId: value.bundle.run_id, evaluationContract: value.contract, expectedEvaluationContractSha256: value.contractSha256, artifactResolver: wrongResolver }).ok).toBe(false);
    const missingTerminal = structuredClone(value.bundle) as unknown as { events: unknown[] }; missingTerminal.events.pop();
    expect(value.replay(missingTerminal).ok).toBe(false);
    const changedRoot = structuredClone(value.bundle) as unknown as { terminal_manifest: { category_roots: { audio: { root_sha256: string } } } };
    changedRoot.terminal_manifest.category_roots.audio.root_sha256 = H("f");
    expect(value.replay(changedRoot).ok).toBe(false);
  });
});
