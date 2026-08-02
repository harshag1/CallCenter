import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EvidenceTapV2,
  createEd25519EvidenceSignerV2,
  replayEvidenceBundleV2,
  serializeEvidenceBundleV2,
  type EvidenceBundleV2,
} from "..";

const keys = generateKeyPairSync("ed25519");
const signer = createEd25519EvidenceSignerV2({
  signerId: "offline-evidence-authority",
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const trust = { signer_id: signer.signer_id, public_key_pem: signer.public_key_pem } as const;
const H = (character: string) => character.repeat(64);

function completeBundle(runId = "run-evidence-001", forbiddenClaimIds: readonly string[] = []): EvidenceBundleV2 {
  const tap = new EvidenceTapV2({ runId, signer });
  tap.append("plan.registered", {
    plan_id: "plan-1", revision: 1, plan_sha256: H("1"),
    required_step_ids: ["identify", "resolve"], required_obligation_ids: ["send-confirmation"],
    forbidden_claim_ids: forbiddenClaimIds,
  }, "2026-08-02T18:00:00.000Z");
  tap.append("catalog.published", {
    catalog_id: "catalog-1", plan_id: "plan-1", revision: 1,
    catalog_sha256: H("2"), capability_ids: ["return.commit"],
  }, "2026-08-02T18:00:00.010Z");
  tap.append("provider.normalized", {
    provider: "provider-a", session_id: "session-1", provider_event_id: "wire-1", provider_sequence: 0,
    kind: "input_audio_end", turn_id: "turn-1", raw_event_sha256: H("3"),
  }, "2026-08-02T18:00:00.100Z");
  tap.append("action.attempted", {
    attempt_id: "attempt-1", action_id: "return.create", capability_id: "return.commit",
    plan_revision: 1, arguments_sha256: H("4"),
  }, "2026-08-02T18:00:00.110Z");
  tap.append("action.policy_decided", {
    attempt_id: "attempt-1", decision: "allow", policy_sha256: H("5"), reason_code: "within_scope",
  }, "2026-08-02T18:00:00.120Z");
  tap.append("action.receipt", {
    attempt_id: "attempt-1", receipt_id: "receipt-1", status: "committed",
    semantic_effect_id: "effect-1", result_sha256: H("6"), world_revision: 1,
  }, "2026-08-02T18:00:00.130Z");
  tap.append("worker.event", {
    worker_event_id: "worker-event-1", worker_id: "worker-1", parent_worker_id: null,
    call_id: "call-1", plan_revision: 1, kind: "spawned", result_sha256: null,
  }, "2026-08-02T18:00:00.140Z");
  tap.append("worker.event", {
    worker_event_id: "worker-event-2", worker_id: "worker-1", parent_worker_id: null,
    call_id: "call-1", plan_revision: 1, kind: "completed", result_sha256: H("7"),
  }, "2026-08-02T18:00:00.150Z");
  tap.append("audio.range", {
    response_id: "response-1", audio_sha256: H("8"), byte_length: 32_000,
    sample_rate_hz: 16_000, channel_count: 1, start_sample: 0, end_sample: 16_000,
    claim_ids: forbiddenClaimIds.length > 0 ? [forbiddenClaimIds[0]] : ["confirmation-qualified"],
  }, "2026-08-02T18:00:00.200Z");
  tap.append("playback.range", {
    playback_event_id: "playback-1", response_id: "response-1", start_sample: 0,
    end_sample: 16_000, status: "released",
  }, "2026-08-02T18:00:00.250Z");
  tap.append("playback.range", {
    playback_event_id: "playback-2", response_id: "response-1", start_sample: 0,
    end_sample: 12_000, status: "heard",
  }, "2026-08-02T18:00:00.300Z");
  tap.append("world.event", {
    world_event_id: "world-1", kind: "effect.committed", required_step_id: null,
    obligation_id: null, correction_id: null, authorized_attempt_id: "attempt-1", semantic_effect_id: "effect-1",
  }, "2026-08-02T18:00:00.310Z");
  tap.append("world.event", {
    world_event_id: "world-2", kind: "step.completed", required_step_id: "identify",
    obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null,
  }, "2026-08-02T18:00:00.320Z");
  tap.append("world.event", {
    world_event_id: "world-3", kind: "step.completed", required_step_id: "resolve",
    obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null,
  }, "2026-08-02T18:00:00.330Z");
  tap.append("world.event", {
    world_event_id: "world-4", kind: "obligation.completed", required_step_id: null,
    obligation_id: "send-confirmation", correction_id: null, authorized_attempt_id: null, semantic_effect_id: null,
  }, "2026-08-02T18:00:00.340Z");
  tap.append("world.event", {
    world_event_id: "world-5", kind: "goal.completed", required_step_id: null,
    obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null,
  }, "2026-08-02T18:00:00.350Z");
  tap.append("usage.recorded", {
    usage_id: "usage-1", provider: "provider-a", model: "realtime-1",
    input_audio_tokens: 100, output_audio_tokens: 50, input_text_tokens: 25,
    output_text_tokens: 10, cost_microusd: 12_345,
  }, "2026-08-02T18:00:00.360Z");
  return tap.finalize({ disposition_id: "terminal-1", status: "completed", reason_code: null }, "2026-08-02T18:00:00.400Z");
}

function replay(input: unknown, runId = "run-evidence-001") {
  return replayEvidenceBundleV2(input, { trust, expectedRunId: runId });
}

describe("production-neutral EvidenceTap v2", () => {
  it("captures every required evidence plane and derives useful-mission endpoints entirely offline", () => {
    const bundle = completeBundle();
    const result = replay(serializeEvidenceBundleV2(bundle));
    expect(result).toEqual({
      ok: true,
      run_id: "run-evidence-001",
      manifest_root_sha256: bundle.terminal_manifest.manifest_root_sha256,
      event_chain_head_sha256: bundle.terminal_manifest.event_chain_head_sha256,
      endpoints: {
        useful_mission_success: true,
        terminal_status: "completed",
        goal_completed: true,
        required_steps_total: 2,
        required_steps_completed: 2,
        required_obligations_total: 1,
        required_obligations_completed: 1,
        unauthorized_effect_count: 0,
        duplicate_effect_count: 0,
        unresolved_indeterminate_effect_count: 0,
        unsafe_released_claim_count: 0,
        heard_audio_sample_count: 12_000,
        safe_first_audio_latency_ms: 150,
        worker_spawn_count: 1,
        worker_terminal_count: 1,
        usage: {
          input_audio_tokens: 100, output_audio_tokens: 50, input_text_tokens: 25,
          output_text_tokens: 10, cost_microusd: 12_345,
        },
      },
    });
    expect(Object.values(bundle.terminal_manifest.category_roots).every((root) => root.event_count > 0)).toBe(true);
  });

  it("keeps unsafe outcomes as valid evidence while failing the useful-mission endpoint", () => {
    const result = replay(completeBundle("run-evidence-001", ["claim-complete-before-authority"]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid evidence");
    expect(result.endpoints).toMatchObject({
      useful_mission_success: false,
      unsafe_released_claim_count: 1,
    });
  });

  it("fails closed on one-byte mutation of a canonical serialized bundle", () => {
    const serialized = serializeEvidenceBundleV2(completeBundle());
    const mutated = serialized.replace("provider-a", "provider-b");
    const result = replay(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected replay failure");
    expect(result.errors.some((error) => error.code === "event_hash_mismatch" || error.code === "manifest_root_mismatch")).toBe(true);
  });

  it("fails closed on event deletion and reorder", () => {
    const deleted = structuredClone(completeBundle()) as unknown as { events: unknown[] };
    deleted.events.splice(5, 1);
    const deletedResult = replay(deleted);
    expect(deletedResult.ok).toBe(false);
    if (deletedResult.ok) throw new Error("expected deletion failure");
    expect(deletedResult.errors.some((error) => ["event_count_mismatch", "sequence_mismatch", "chain_mismatch"].includes(error.code))).toBe(true);

    const reordered = structuredClone(completeBundle()) as unknown as { events: unknown[] };
    [reordered.events[3], reordered.events[4]] = [reordered.events[4], reordered.events[3]];
    const reorderedResult = replay(reordered);
    expect(reorderedResult.ok).toBe(false);
    if (reorderedResult.ok) throw new Error("expected reorder failure");
    expect(reorderedResult.errors.some((error) => error.code === "sequence_mismatch" || error.code === "chain_mismatch")).toBe(true);
  });

  it("fails closed on cross-run substitution and whole-bundle substitution", () => {
    const original = structuredClone(completeBundle()) as unknown as { events: unknown[] };
    const other = completeBundle("run-evidence-002");
    original.events[3] = other.events[3];
    const eventResult = replay(original);
    expect(eventResult.ok).toBe(false);
    if (eventResult.ok) throw new Error("expected event substitution failure");
    expect(eventResult.errors.some((error) => error.code === "run_mismatch" || error.code === "chain_mismatch")).toBe(true);

    const bundleResult = replay(other);
    expect(bundleResult.ok).toBe(false);
    if (bundleResult.ok) throw new Error("expected bundle substitution failure");
    expect(bundleResult.errors.some((error) => error.code === "run_mismatch")).toBe(true);
  });

  it("fails closed on missing evidence and signer mismatch", () => {
    const missing = structuredClone(completeBundle()) as unknown as { events: Array<{ event_type: string }> };
    missing.events = missing.events.filter((event) => event.event_type !== "usage.recorded");
    const missingResult = replay(missing);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) throw new Error("expected missing evidence failure");
    expect(missingResult.errors.some((error) => error.code === "missing_evidence")).toBe(true);

    const otherKeys = generateKeyPairSync("ed25519");
    const signerResult = replayEvidenceBundleV2(completeBundle(), {
      expectedRunId: "run-evidence-001",
      trust: {
        signer_id: "different-authority",
        public_key_pem: otherKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    });
    expect(signerResult.ok).toBe(false);
    if (signerResult.ok) throw new Error("expected signer failure");
    expect(signerResult.errors.some((error) => error.code === "signer_mismatch" || error.code === "signature_mismatch")).toBe(true);
  });

  it("binds the terminal journal and every category root into the signed manifest", () => {
    const missingTerminal = structuredClone(completeBundle()) as unknown as { events: unknown[] };
    missingTerminal.events.pop();
    const terminalResult = replay(missingTerminal);
    expect(terminalResult.ok).toBe(false);
    if (terminalResult.ok) throw new Error("expected terminal failure");
    expect(terminalResult.errors.some((error) => error.code === "terminal_mismatch" || error.code === "missing_evidence")).toBe(true);

    const changedRoot = structuredClone(completeBundle()) as unknown as {
      terminal_manifest: { category_roots: { audio: { root_sha256: string } } };
    };
    changedRoot.terminal_manifest.category_roots.audio.root_sha256 = H("f");
    const rootResult = replay(changedRoot);
    expect(rootResult.ok).toBe(false);
    if (rootResult.ok) throw new Error("expected root failure");
    expect(rootResult.errors.some((error) => error.code === "category_root_mismatch")).toBe(true);
    expect(rootResult.errors.some((error) => error.code === "manifest_root_mismatch")).toBe(true);
  });

  it("rejects noncanonical bytes and appends no events after terminal finalization", () => {
    const bundle = completeBundle();
    const noncanonical = JSON.stringify(bundle, null, 2);
    const result = replay(noncanonical);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected canonical-byte failure");
    expect(result.errors.some((error) => error.code === "noncanonical_bytes")).toBe(true);

    const tap = new EvidenceTapV2({ runId: "closed-tap", signer });
    tap.finalize({ disposition_id: "terminal-closed", status: "aborted", reason_code: "test" });
    expect(() => tap.append("usage.recorded", {
      usage_id: "late", provider: "provider", model: "model", input_audio_tokens: 0,
      output_audio_tokens: 0, input_text_tokens: 0, output_text_tokens: 0, cost_microusd: 0,
    })).toThrow("closed");
  });
});
