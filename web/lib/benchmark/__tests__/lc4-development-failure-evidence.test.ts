import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import { LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256 } from "../lc4-development-audio-contract";
import {
  LC4_DEV_FAILURE_EVIDENCE_DOMAIN,
  LC4_DEV_FAILURE_EVIDENCE_VERSION,
  Lc4DevFailureEvidenceError,
  classifyLc4DevTerminalWireType,
  createLc4DevFailureEvidence,
  lc4DevFailureEvidenceBody,
  type Lc4DevFailureEvidenceBody,
  type Lc4DevFailureOperation,
} from "../lc4-development-failure-evidence";
import {
  LC4_XAI_SERVER_VAD_SILENCE_TAIL,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
} from "../xai-server-vad";

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

function xaiDelimiterExhaustionBody(
  overrides: Partial<Lc4DevFailureEvidenceBody> = {},
  lifecycle: "no_speech_started" | "speech_started_without_stop" = "speech_started_without_stop",
): Lc4DevFailureEvidenceBody {
  const callerPcm = new Uint8Array(1_920);
  callerPcm[0] = 1;
  return body({
    failure_stage: "audio_append",
    failure_code: "server_vad_delimiter_exhausted",
    failure_class: "provider_external",
    provider: "xai",
    model: "grok-voice-think-fast-1.0",
    operation_order: lifecycle === "no_speech_started"
      ? [
          "response_plan_session_update_sent",
          "response_plan_session_update_acknowledged",
          "caller_pcm_delivery_started",
          "caller_pcm_delivery_completed",
          "server_vad_silence_tail_delivery_started",
          "server_vad_silence_tail_delivery_exhausted",
        ]
      : [
          "response_plan_session_update_sent",
          "response_plan_session_update_acknowledged",
          "caller_pcm_delivery_started",
          "server_vad_speech_started",
          "caller_pcm_delivery_completed",
          "server_vad_silence_tail_delivery_started",
          "server_vad_silence_tail_delivery_exhausted",
        ],
    caller_pcm_sha256: sha256Hex(callerPcm),
    caller_pcm_byte_length: callerPcm.byteLength,
    caller_pcm_chunk_count: 2,
    caller_pcm_appended_chunk_count: 2,
    caller_pcm_appended_byte_length: callerPcm.byteLength,
    response_generation_requested: false,
    response_generation_started: false,
    response_terminal_observed: false,
    response_completed: false,
    wire_observation_count: 108,
    terminal_wire_type: "audio_append",
    terminal_wire_type_sha256: "b".repeat(64),
    terminal_wire_observation_sha256: "c".repeat(64),
    server_vad_delimiter_exhaustion: {
      schema_version: 1,
      purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
      completion: "full_plan_delivered",
      policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
      pcm_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
      audio_bytes: LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length,
      duration_ms: LC4_XAI_SERVER_VAD_SILENCE_TAIL.duration_ms,
      chunk_count: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count,
      frame_bytes: 960,
      tail_bytes: 960,
      delivery_profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
      scheduled_offsets_ms: Array.from(
        { length: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count },
        (_, index) => index * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms,
      ),
    },
    ...overrides,
  });
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
        "server_vad_silence_tail_delivery_started",
        "server_vad_speech_stopped",
        "caller_pcm_auto_committed",
        "response_generation_auto_started",
        "server_vad_silence_tail_prefix_accepted",
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
    expect(() => createLc4DevFailureEvidence(body({
      provider: "xai",
      model: "grok-voice-think-fast-1.0",
      operation_order: [
        "caller_pcm_delivery_started",
        "caller_pcm_delivery_completed",
        "server_vad_silence_tail_delivery_started",
        "server_vad_silence_tail_prefix_accepted",
      ],
      response_generation_requested: false,
    }))).toThrow(/requires server_vad_speech_stopped/u);
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

  it.each([
    ["no speech-start", "no_speech_started"],
    ["speech-started without stop", "speech_started_without_stop"],
  ] as const)(
    "accepts only the exact xAI full-cap delimiter-exhaustion semantic contract: %s",
    (_label, lifecycle) => {
      const input = xaiDelimiterExhaustionBody({}, lifecycle);
      const evidence = createLc4DevFailureEvidence(input);
      expect(evidence).toMatchObject({
        failure_role: "primary_exchange",
        failure_stage: "audio_append",
        failure_code: "server_vad_delimiter_exhausted",
        failure_class: "provider_external",
        provider: "xai",
        caller_pcm_byte_length: 1_920,
        caller_pcm_chunk_count: 2,
        caller_pcm_appended_byte_length: 1_920,
        caller_pcm_appended_chunk_count: 2,
        response_generation_started: false,
        output_pcm_byte_length: 0,
        gateway_batch_count: 0,
      });
      expect(evidence.server_vad_delimiter_exhaustion).toMatchObject({
        completion: "full_plan_delivered",
        audio_bytes: 96_000,
        duration_ms: 2_000,
        chunk_count: 100,
        frame_bytes: 960,
        tail_bytes: 960,
        delivery_profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
      });
      expect(evidence.server_vad_delimiter_exhaustion?.scheduled_offsets_ms)
        .toEqual(Array.from({ length: 100 }, (_, index) => index * 20));
      expect(evidence.operation_order.includes("server_vad_speech_started"))
        .toBe(lifecycle === "speech_started_without_stop");
    },
  );

  it.each([
    ["cleanup role", { failure_role: "cleanup" as const }],
    ["wrong stage", { failure_stage: "provider_wait" as const }],
    ["wrong failure code", { failure_code: "provider_response_timeout" as const }],
    ["wrong failure class", { failure_class: "timeout" as const }],
    ["non-xAI provider", { provider: "openai" as const }],
    ["missing opportunity", { opportunity_id: null }],
    ["missing playback kind", { playback_kind: null }],
    ["zero caller bytes", {
      caller_pcm_sha256: null,
      caller_pcm_byte_length: 0,
      caller_pcm_chunk_count: 0,
      caller_pcm_appended_chunk_count: 0,
      caller_pcm_appended_byte_length: 0,
    }],
    ["missing caller hash", { caller_pcm_sha256: null }],
    ["odd PCM byte accounting", {
      caller_pcm_byte_length: 1_919,
      caller_pcm_appended_byte_length: 1_919,
    }],
    ["wrong caller chunk accounting", { caller_pcm_chunk_count: 3, caller_pcm_appended_chunk_count: 3 }],
    ["partial caller chunks", { caller_pcm_appended_chunk_count: 1 }],
    ["partial caller bytes", { caller_pcm_appended_byte_length: 960 }],
    ["response request", {
      response_generation_requested: true,
      operation_order: [
        "response_plan_session_update_sent",
        "response_plan_session_update_acknowledged",
        "caller_pcm_delivery_started",
        "server_vad_speech_started",
        "caller_pcm_delivery_completed",
        "server_vad_silence_tail_delivery_started",
        "server_vad_silence_tail_delivery_exhausted",
        "response_generation_requested",
      ] as const,
    }],
    ["response start", {
      response_generation_requested: true,
      response_generation_started: true,
      operation_order: [
        "response_plan_session_update_sent",
        "response_plan_session_update_acknowledged",
        "caller_pcm_delivery_started",
        "server_vad_speech_started",
        "caller_pcm_delivery_completed",
        "server_vad_silence_tail_delivery_started",
        "server_vad_silence_tail_delivery_exhausted",
        "response_generation_requested",
        "response_generation_started",
      ] as const,
    }],
    ["assistant output", {
      output_pcm_sha256: "d".repeat(64),
      output_pcm_byte_length: 960,
      output_pcm_chunk_count: 1,
      operation_order: [
        "response_plan_session_update_sent",
        "response_plan_session_update_acknowledged",
        "caller_pcm_delivery_started",
        "server_vad_speech_started",
        "caller_pcm_delivery_completed",
        "server_vad_silence_tail_delivery_started",
        "server_vad_silence_tail_delivery_exhausted",
        "assistant_pcm_captured",
      ] as const,
    }],
    ["gateway activity", { gateway_batch_count: 1 }],
    ["gateway fatal", { gateway_fatal_class: "parse" as const }],
    ["response terminal wire", { terminal_wire_type: "response_terminal" as const }],
  ])("rejects delimiter exhaustion with %s", (_label, overrides) => {
    expect(() => createLc4DevFailureEvidence(xaiDelimiterExhaustionBody(overrides)))
      .toThrow(/delimiter exhaustion|non-delimiter failure|cleanup classification|operation progression|lifecycle/u);
  });

  it.each([
    ["reordered operation prefix", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      operation_order: [
        "response_plan_session_update_sent",
        "response_plan_session_update_acknowledged",
        "caller_pcm_delivery_started",
        "caller_pcm_delivery_completed",
        "server_vad_speech_started",
        "server_vad_silence_tail_delivery_started",
        "server_vad_silence_tail_delivery_exhausted",
      ] as const,
    })],
    ["extra operation", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      operation_order: [...input.operation_order, "response_plan_prepared"] as const,
    })],
    ["wrong policy hash", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      server_vad_delimiter_exhaustion: {
        ...input.server_vad_delimiter_exhaustion!,
        policy_sha256: "d".repeat(64),
      },
    })],
    ["wrong PCM hash", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      server_vad_delimiter_exhaustion: {
        ...input.server_vad_delimiter_exhaustion!,
        pcm_sha256: "d".repeat(64),
      },
    })],
    ["99 frames", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      server_vad_delimiter_exhaustion: {
        ...input.server_vad_delimiter_exhaustion!,
        audio_bytes: 95_040,
        duration_ms: 1_980,
        chunk_count: 99,
        scheduled_offsets_ms: input.server_vad_delimiter_exhaustion!.scheduled_offsets_ms.slice(0, 99),
      },
    })],
    ["wrong frame bytes", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      server_vad_delimiter_exhaustion: {
        ...input.server_vad_delimiter_exhaustion!,
        frame_bytes: 480,
      },
    })],
    ["wrong tail bytes", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      server_vad_delimiter_exhaustion: {
        ...input.server_vad_delimiter_exhaustion!,
        tail_bytes: 480,
      },
    })],
    ["wrong delivery profile", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      server_vad_delimiter_exhaustion: {
        ...input.server_vad_delimiter_exhaustion!,
        delivery_profile_sha256: "d".repeat(64),
      },
    })],
    ["wrong scheduled offset", (input: Lc4DevFailureEvidenceBody) => ({
      ...input,
      server_vad_delimiter_exhaustion: {
        ...input.server_vad_delimiter_exhaustion!,
        scheduled_offsets_ms: input.server_vad_delimiter_exhaustion!.scheduled_offsets_ms.map(
          (offset, index) => index === 50 ? offset + 1 : offset,
        ),
      },
    })],
  ] as const)("rejects re-hashable but semantically false delimiter evidence: %s", (_label, mutate) => {
    for (const lifecycle of ["no_speech_started", "speech_started_without_stop"] as const) {
      expect(() => createLc4DevFailureEvidence(mutate(xaiDelimiterExhaustionBody({}, lifecycle))))
        .toThrow(/exact hard-cap commitment|progression/u);
    }
  });

  it.each([
    ["no speech-start", "no_speech_started"],
    ["speech-started without stop", "speech_started_without_stop"],
  ] as const)(
    "rejects stop, commit, response, and gateway contradictions after %s delimiter exhaustion",
    (_label, lifecycle) => {
      const input = xaiDelimiterExhaustionBody({}, lifecycle);
      const beforeExhaustion = input.operation_order.slice(0, -1);
      const contradictoryOperationOrders: readonly (readonly Lc4DevFailureOperation[])[] = [
        [...beforeExhaustion, "server_vad_silence_tail_delivery_completed"],
        [...beforeExhaustion, "server_vad_silence_tail_prefix_accepted"],
        [...beforeExhaustion, "server_vad_speech_stopped", "server_vad_silence_tail_delivery_exhausted"],
        [...beforeExhaustion, "caller_pcm_auto_committed", "server_vad_silence_tail_delivery_exhausted"],
        [...beforeExhaustion, "response_generation_auto_started", "server_vad_silence_tail_delivery_exhausted"],
      ];
      for (const operation_order of contradictoryOperationOrders) {
        expect(() => createLc4DevFailureEvidence({
          ...input,
          operation_order,
        })).toThrow(/exact hard-cap commitment|progression/u);
      }
      expect(() => createLc4DevFailureEvidence({
        ...input,
        gateway_batch_count: 1,
      })).toThrow(/exact hard-cap commitment/u);
      expect(() => createLc4DevFailureEvidence({
        ...input,
        response_generation_requested: true,
        operation_order: [...input.operation_order, "response_generation_requested"],
      })).toThrow(/exact hard-cap commitment|progression/u);
    },
  );

  it("rejects a semantically false delimiter artifact even when its outer hash matches", () => {
    const valid = createLc4DevFailureEvidence(xaiDelimiterExhaustionBody());
    const validBody = lc4DevFailureEvidenceBody(valid);
    const semanticallyFalseBody = {
      ...validBody,
      server_vad_delimiter_exhaustion: {
        ...valid.server_vad_delimiter_exhaustion!,
        delivery_profile_sha256: "d".repeat(64),
      },
    };
    const forged = {
      ...semanticallyFalseBody,
      failure_evidence_sha256: sha256Hex(
        `${LC4_DEV_FAILURE_EVIDENCE_DOMAIN}${canonicalJson(semanticallyFalseBody)}`,
      ),
    };
    expect(() => lc4DevFailureEvidenceBody(forged))
      .toThrow(/exact hard-cap commitment/u);
  });

  it("drops non-allowlisted nested delimiter fields before hashing", () => {
    const input = xaiDelimiterExhaustionBody();
    const delimiter = {
      ...input.server_vad_delimiter_exhaustion!,
      raw_provider_transcript: "SENTINEL",
    };
    const evidence = createLc4DevFailureEvidence({
      ...input,
      server_vad_delimiter_exhaustion: delimiter,
    });
    expect(canonicalJson(evidence)).not.toContain("SENTINEL");
    expect(evidence.server_vad_delimiter_exhaustion).not.toHaveProperty("raw_provider_transcript");
  });

  it("maps raw wire types to a closed non-plaintext vocabulary", () => {
    expect(classifyLc4DevTerminalWireType(null)).toBe("none");
    expect(classifyLc4DevTerminalWireType("response.failed")).toBe("response_terminal");
    expect(classifyLc4DevTerminalWireType("error")).toBe("provider_error");
    expect(classifyLc4DevTerminalWireType("response.function_call_arguments.done")).toBe("tool_activity");
    expect(classifyLc4DevTerminalWireType("private.provider.event.SENTINEL")).toBe("other");
  });
});
