import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEV_FAILURE_EVIDENCE_DOMAIN,
  LC4_DEV_FAILURE_EVIDENCE_VERSION,
  Lc4DevFailureEvidenceError,
  classifyLc4DevTerminalWireType,
  createLc4DevFailureEvidence,
  lc4DevFailureEvidenceBody,
  type Lc4DevFailureEvidenceBody,
} from "../lc4-development-failure-evidence";

const HASH = "a".repeat(64);

function body(overrides: Partial<Lc4DevFailureEvidenceBody> = {}): Lc4DevFailureEvidenceBody {
  return {
    schema_version: 2,
    evidence_version: LC4_DEV_FAILURE_EVIDENCE_VERSION,
    redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids",
    failure_role: "primary_exchange",
    failure_stage: "provider_wait",
    failure_code: "provider_response_timeout",
    failure_class: "timeout",
    episode_id: "lc4-dev-openai-native",
    opportunity_id: "lc4-dev-op-01",
    provider: "openai",
    model: "gpt-realtime-1.5",
    playback_kind: "canonical",
    operation_order: [
      "caller_pcm_delivery_started",
      "caller_pcm_delivery_completed",
      "response_plan_prepared",
      "caller_pcm_committed",
      "response_generation_requested",
    ],
    caller_pcm_sha256: HASH,
    caller_pcm_byte_length: 197_100,
    caller_pcm_chunk_count: 206,
    caller_pcm_appended_chunk_count: 206,
    caller_pcm_appended_byte_length: 197_100,
    response_generation_requested: true,
    response_generation_started: false,
    response_terminal_observed: false,
    response_completed: false,
    output_pcm_sha256: null,
    output_pcm_byte_length: 0,
    output_pcm_chunk_count: 0,
    wire_observation_count: 209,
    terminal_wire_type: "response_request",
    terminal_wire_type_sha256: "b".repeat(64),
    terminal_wire_observation_sha256: "c".repeat(64),
    gateway_batch_count: 0,
    gateway_fatal_class: "none",
    secondary_failure_evidence_sha256: null,
    ...overrides,
  };
}

describe("LC4-DEV failure evidence", () => {
  it("creates deterministic domain-separated replay evidence", () => {
    const evidence = createLc4DevFailureEvidence(body());
    const { failure_evidence_sha256: claimed, ...persistedBody } = evidence;
    expect(claimed).toBe(sha256Hex(`${LC4_DEV_FAILURE_EVIDENCE_DOMAIN}${canonicalJson(persistedBody)}`));
    expect(createLc4DevFailureEvidence(body())).toEqual(evidence);
    expect(lc4DevFailureEvidenceBody(evidence)).toEqual(persistedBody);
    expect(() => lc4DevFailureEvidenceBody({
      ...evidence,
      failure_evidence_sha256: "f".repeat(64),
    })).toThrow(/hash is invalid/u);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("persists only allowlisted fields and never provider plaintext or secrets", () => {
    const sentinel = "sk-secret-provider-plaintext-SENTINEL";
    const input = {
      ...body(),
      raw_error: new Error(sentinel),
      provider_payload: { transcript: sentinel, arguments: sentinel },
      credential: sentinel,
    } as unknown as Lc4DevFailureEvidenceBody;
    const evidence = createLc4DevFailureEvidence(input);
    const serialized = canonicalJson(evidence);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("raw_error");
    expect(serialized).not.toContain("provider_payload");
    expect(serialized).not.toContain('"credential":');
    expect(Object.keys(evidence)).toHaveLength(33);
    expect(new Lc4DevFailureEvidenceError(evidence).message).toBe("LC4-DEV exchange failed: provider_response_timeout");
  });

  it("fails closed on inconsistent lifecycle, order, wire, and cleanup linkage", () => {
    expect(() => createLc4DevFailureEvidence(body({
      response_generation_requested: false,
      response_generation_started: true,
    }))).toThrow(/lifecycle/u);
    expect(() => createLc4DevFailureEvidence(body({
      response_generation_started: true,
      operation_order: [
        "caller_pcm_delivery_started",
        "caller_pcm_delivery_completed",
        "response_plan_prepared",
        "caller_pcm_committed",
        "response_generation_requested",
      ],
    }))).toThrow(/operation progression/u);
    expect(() => createLc4DevFailureEvidence(body({
      operation_order: ["response_generation_requested", "caller_pcm_delivery_started"],
    }))).toThrow(/progression/u);
    expect(() => createLc4DevFailureEvidence(body({
      wire_observation_count: 0,
    }))).toThrow(/wire commitment/u);
    expect(() => createLc4DevFailureEvidence(body({
      failure_role: "primary_exchange",
      secondary_failure_evidence_sha256: "d".repeat(64),
    }))).toThrow(/primary failure/u);
    expect(() => createLc4DevFailureEvidence(body({
      failure_role: "cleanup",
      failure_stage: "provider_wait",
    }))).toThrow(/cleanup classification/u);
  });

  it("accepts provider-native auto-response evidence without a client response request", () => {
    expect(createLc4DevFailureEvidence(body({
      provider: "xai",
      model: "grok-3-fast",
      operation_order: [
        "response_plan_session_update_sent",
        "response_plan_session_update_acknowledged",
        "caller_pcm_delivery_started",
        "server_vad_speech_started",
        "caller_pcm_delivery_completed",
        "server_vad_speech_stopped",
        "caller_pcm_auto_committed",
        "response_generation_auto_started",
        "response_generation_started",
        "response_terminal_observed",
      ],
      response_generation_requested: false,
      response_generation_started: true,
      response_terminal_observed: true,
      response_completed: true,
    }))).toMatchObject({
      response_generation_requested: false,
      response_generation_started: true,
      response_terminal_observed: true,
      response_completed: true,
    });
  });

  it("retains a closed-vocabulary provider disconnect before the next turn sends bytes", () => {
    const evidence = createLc4DevFailureEvidence(body({
      failure_stage: "pre_send_contract",
      failure_code: "provider_connection_closed",
      failure_class: "provider_external",
      operation_order: [],
      caller_pcm_byte_length: 4,
      caller_pcm_chunk_count: 1,
      caller_pcm_appended_chunk_count: 0,
      caller_pcm_appended_byte_length: 0,
      response_generation_requested: false,
      response_generation_started: false,
      response_terminal_observed: false,
      response_completed: false,
      wire_observation_count: 0,
      terminal_wire_type: "none",
      terminal_wire_type_sha256: null,
      terminal_wire_observation_sha256: null,
    }));
    expect(evidence).toMatchObject({
      failure_stage: "pre_send_contract",
      failure_code: "provider_connection_closed",
      failure_class: "provider_external",
      output_pcm_byte_length: 0,
    });
    expect(new Lc4DevFailureEvidenceError(evidence).message)
      .toBe("LC4-DEV exchange failed: provider_connection_closed");
  });

  it("maps raw wire types to a closed non-plaintext vocabulary", () => {
    expect(classifyLc4DevTerminalWireType(null)).toBe("none");
    expect(classifyLc4DevTerminalWireType("response.failed")).toBe("response_terminal");
    expect(classifyLc4DevTerminalWireType("error")).toBe("provider_error");
    expect(classifyLc4DevTerminalWireType("response.function_call_arguments.done")).toBe("tool_activity");
    expect(classifyLc4DevTerminalWireType("private.provider.event.SENTINEL")).toBe("other");
  });
});
