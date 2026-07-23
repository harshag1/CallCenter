import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
  LC4_QUALIFICATION_V3_MAXIMUM_AUTHORIZATION_TTL_MS,
  LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
  LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
  LC4_XAI_SERVER_VAD_SETTING_SHA256,
  assertLc4QualificationV3Authorization,
  assertLc4QualificationV3PlanArtifact,
  createLc4QualificationV3AuthorizationArtifact,
  createLc4QualificationV3Targets,
  loadLc4QualificationV3AuthorizationFile,
  loadLc4QualificationV3ExplicitCredentials,
  loadLc4QualificationV3PrivateKeyFile,
  prepareLc4QualificationV3,
  reportLc4QualificationV3,
  runLc4QualificationV3,
  runLc4QualificationV3Cli,
  type Lc4QualificationV3AuthorizationBody,
  type Lc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3GitSource,
  type Lc4QualificationV3PlanArtifact,
  type Lc4QualificationV3TerminalBody,
} from "../lc4-qualification-v3-runner";
import {
  createLc4QualificationPayloadManifestV5,
  createSignedLc4QualificationPackageEnvelopeV5,
  type Lc4QualificationPackageBindingsV5,
  type Lc4QualificationPackageFile,
} from "../lc4-qualification-package-envelope";
import {
  productionOpenAiCompatibleSessionUpdate,
  productionSessionPayloadParitySha256,
} from "../production-realtime-provider";
import {
  LC4_S2S_COMPACT_CONTROL,
  LC4_S2S_COMPACT_CONTROL_SHA256,
  LC4_S2S_PACKETIZER_SHA256,
  LC4_S2S_SOURCE_TEXT,
  LC4_S2S_TOOL,
  LC4_S2S_TOOL_SCHEMA_SHA256,
  assertLc4S2sRoundtripExecution,
  type Lc4S2sAudioRenderer,
  type Lc4S2sRoundtripExecution,
} from "../provider-s2s-tool-roundtrip";
import type { LiveStsProvider } from "../live-sts-development-experiment";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeEventListener,
  RealtimeWireObservation,
  RealtimeWireObservationListener,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import {
  realtimeToolFrontierSha256,
  withXaiServerVadPcmSession,
  xaiServerVadTransportParitySha256,
} from "../../realtime/client/openai-compatible";
import {
  LC4_XAI_SERVER_VAD_SILENCE_TAIL,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
  LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
} from "../xai-server-vad";
import {
  replayProviderToolRoundtrip,
  projectRoundtripInputAudioEvidence,
  projectRoundtripOutputAudioEvidence,
  projectRoundtripPreToolOutputQuarantineEvidence,
  roundtripInputAudioChunkListSha256,
  roundtripCausalBindingSha256,
  roundtripSanitizedUsageSha256,
} from "../provider-roundtrip-replay";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const SOURCE: Lc4QualificationV3GitSource = Object.freeze({
  source_commit: "a".repeat(40),
  source_tree_oid: "b".repeat(40),
  source_tree_sha256: "c".repeat(64),
  worktree_clean: true,
});
const CREDENTIALS = Object.freeze({
  openai: "openai-qualification-secret",
  gemini: "gemini-qualification-secret",
  xai: "xai-qualification-secret",
});
const NOW = new Date("2026-07-22T20:00:00.000Z");

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicSpki = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    privatePem,
    publicSpkiBase64: publicSpki.toString("base64"),
    fingerprint: sha256Hex(publicSpki),
  });
}

const TEST_TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v6\n";
const TEST_TERMINAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal-artifact/v6\n";

function signTestTerminal(body: Lc4QualificationV3TerminalBody, privateKeyPem: string) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const withoutHash = Object.freeze({
    body,
    authority_public_key_spki_base64: publicKey.toString("base64"),
    authority_public_key_fingerprint_sha256: sha256Hex(publicKey),
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(
      null,
      Buffer.from(`${TEST_TERMINAL_DOMAIN}${canonicalJson(body)}`),
      privateKey,
    ).toString("base64"),
  });
  return Object.freeze({
    ...withoutHash,
    artifact_sha256: sha256Hex(`${TEST_TERMINAL_ARTIFACT_DOMAIN}${canonicalJson(withoutHash)}`),
  });
}

function pcm(sampleRateHz: 16_000 | 24_000): Uint8Array {
  const bytes = new Uint8Array(sampleRateHz * 12 / 10 * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < bytes.byteLength / 2; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(2 * Math.PI * 220 * index / sampleRateHz) * 4_000), true);
  }
  return bytes;
}

const renderer: Lc4S2sAudioRenderer = Object.freeze({
  identitySha256: "d".repeat(64),
  async render(text) {
    expect(text).toBe(LC4_S2S_SOURCE_TEXT);
    return Object.freeze({ pcm16k: pcm(16_000), pcm24k: pcm(24_000) });
  },
});

function authorizationFor(
  plan: Lc4QualificationV3PlanArtifact,
  authorityPrivateKeyPem: string,
  terminalKey: ReturnType<typeof keys>,
  authorizationId: string,
): ReturnType<typeof createLc4QualificationV3AuthorizationArtifact> {
  return createLc4QualificationV3AuthorizationArtifact({
    body: Object.freeze({
      schema_version: 1,
      authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
      authorization_id: authorizationId,
      authorization_nonce_sha256: sha256Hex(`nonce:${authorizationId}`),
      plan_artifact_sha256: plan.artifact_sha256,
      plan_sha256: plan.body.plan_sha256,
      source_commit: plan.body.source.source_commit,
      source_tree_sha256: plan.body.source.source_tree_sha256,
      credential_set_sha256: plan.body.credential_set_sha256,
      terminal_public_key_spki_base64: terminalKey.publicSpkiBase64,
      terminal_public_key_fingerprint_sha256: terminalKey.fingerprint,
      maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
      maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
      maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
      maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
      maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
      paid_retry_allowed: false,
      not_before: "2026-07-22T19:30:00.000Z",
      expires_at: "2026-07-22T20:30:00.000Z",
    }),
    authorityPrivateKeyPem,
  });
}

function acknowledgement(provider: LiveStsProvider, conditionalXaiServerVad = false): SessionConfigurationAcknowledgement {
  const verified = Object.freeze({ status: "verified" as const, requestedSha256: "1".repeat(64), acknowledgedSha256: "1".repeat(64), acknowledgedBy: "session.updated" as const });
  const unverifiable = Object.freeze({ status: "unverifiable" as const, requestedSha256: "2".repeat(64), reason: "provider does not echo this field" });
  if (provider === "gemini") return Object.freeze({
    schemaVersion: 1, strictParityVerified: false, paidBenchmarkReady: false, session: unverifiable,
    fields: Object.freeze({ model: unverifiable, voice: unverifiable, instructions: unverifiable, tools: unverifiable, tool_choice: Object.freeze({ status: "not_requested" as const }), input_audio: unverifiable, output_audio: unverifiable, turn_detection: unverifiable }),
  });
  if (provider === "xai") return Object.freeze({
    schemaVersion: 1, strictParityVerified: !conditionalXaiServerVad, paidBenchmarkReady: !conditionalXaiServerVad,
    session: conditionalXaiServerVad ? Object.freeze({
      status: "unverifiable" as const,
      requestedSha256: "1".repeat(64), acknowledgedSha256: "2".repeat(64), acknowledgedBy: "session.updated" as const,
      reason: "provider omitted bounded server-VAD paths",
      omission: Object.freeze({
        kind: "requested_paths_omitted" as const,
        paths: Object.freeze([
          "session.turn_detection.prefix_padding_ms",
          "session.turn_detection.silence_duration_ms",
          "session.turn_detection.threshold",
          "session.turn_detection.type",
        ]),
        acknowledgedShape: "partial_value" as const,
      }),
    }) : verified,
    fields: Object.freeze({
      model: verified, voice: verified, instructions: verified, tools: verified,
      tool_choice: verified, input_audio: verified, output_audio: verified,
      turn_detection: conditionalXaiServerVad ? Object.freeze({
        status: "unverifiable" as const,
        requestedSha256: "3".repeat(64),
        acknowledgedSha256: "4".repeat(64),
        acknowledgedBy: "session.updated" as const,
        reason: "Provider session.updated returned an empty turn_detection object",
        omission: Object.freeze({
          kind: "requested_paths_omitted" as const,
          paths: Object.freeze([
            "turn_detection.prefix_padding_ms",
            "turn_detection.silence_duration_ms",
            "turn_detection.threshold",
            "turn_detection.type",
          ]),
          acknowledgedShape: "empty_object" as const,
        }),
      }) : verified,
    }),
  });
  return Object.freeze({
    schemaVersion: 1, strictParityVerified: true, paidBenchmarkReady: true, session: verified,
    fields: Object.freeze({ model: verified, voice: verified, instructions: verified, tools: verified, tool_choice: verified, input_audio: verified, output_audio: verified, turn_detection: verified }),
  });
}

class SetupClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly sessionConfigurationAcknowledgement;
  readonly #listeners = new Set<RealtimeEventListener>();
  readonly #wireListeners = new Set<RealtimeWireObservationListener>();
  constructor(provider: LiveStsProvider, conditionalXaiServerVad = false) {
    this.provider = provider;
    this.sessionConfigurationAcknowledgement = acknowledgement(provider, conditionalXaiServerVad);
  }
  async connect() {
    this.state = "ready";
    let predecessor: string | null = null;
    const observe = (
      direction: "outbound" | "inbound",
      wireType: string,
      sequence: number,
      identities: RealtimeWireObservation["identities"] = Object.freeze({}),
      extraProjection: Readonly<Record<string, unknown>> = Object.freeze({}),
    ) => {
      const projection = Object.freeze({
        direction,
        wireType,
        sequence,
        ...(direction === "inbound"
          ? { session: { configurationEvidence: this.sessionConfigurationAcknowledgement } }
          : {}),
        ...extraProjection,
      });
      const core = Object.freeze({
        schemaVersion: 1 as const, provider: this.provider, direction, connectionEpoch: 1, sequence,
        observedAtMs: sequence, observedAtMonotonicMs: sequence, wireType,
        payloadSha256: sha256Hex(canonicalJson(projection)), payloadBytes: 64,
        projectionSha256: realtimeWireProjectionSha256(projection),
        previousObservationSha256: predecessor,
        identities, projection,
      });
      const observation = Object.freeze({ ...core, observationSha256: realtimeWireObservationSha256(core) });
      predecessor = observation.observationSha256;
      for (const listener of this.#wireListeners) listener(observation);
    };
    if (this.provider === "xai") {
      const sessionIdSha256 = "8".repeat(64);
      observe("outbound", "session.update", 1);
      observe("inbound", "session.created", 2, { sessionIdSha256 }, {
        session: { fieldSha256: { turn_detection: "3".repeat(64), voice: "1".repeat(64) } },
      });
      observe("inbound", "session.updated", 3, { sessionIdSha256 }, {
        session: { configurationEvidence: this.sessionConfigurationAcknowledgement, toolCount: 1 },
      });
    } else {
      observe("outbound", this.provider === "gemini" ? "setup" : "session.update", 1);
      observe("inbound", this.provider === "gemini" ? "setupComplete" : "session.updated", 2);
    }
    const event: NormalizedRealtimeEvent = {
      type: "session.ready", provider: this.provider, receivedAtMs: 1,
      wireType: this.provider === "gemini" ? "setupComplete" : "session.updated",
      configuration: this.sessionConfigurationAcknowledgement,
    };
    for (const listener of this.#listeners) listener(event);
  }
  close() { this.state = "closed"; }
  onEvent(listener: RealtimeEventListener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireObservation(listener: RealtimeWireObservationListener) { this.#wireListeners.add(listener); return () => this.#wireListeners.delete(listener); }
  onWireEvent() { return () => undefined; }
  appendInputAudio() { throw new Error("setup only"); }
  prepareResponse() { throw new Error("setup only"); }
  commitInputAudio() { throw new Error("setup only"); }
  createResponse() { throw new Error("setup only"); }
  sendTurn() { throw new Error("setup only"); }
  submitToolResults() { throw new Error("setup only"); }
}

function passedExecution(input: Parameters<NonNullable<Parameters<typeof runLc4QualificationV3>[0]["dependencies"]>["executeRoundtrip"]>[0]): Lc4S2sRoundtripExecution {
  const wire: RealtimeWireObservation[] = [];
  const observe = (
    direction: "inbound" | "outbound",
    wireType: string,
    identities: RealtimeWireObservation["identities"] = Object.freeze({}),
    extraProjection: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) => {
    const sequence = wire.length + 1;
    const projection = Object.freeze({ direction, wireType, sequence, ...extraProjection });
    const core = Object.freeze({
      schemaVersion: 1 as const, provider: input.provider, direction, connectionEpoch: 1, sequence,
      observedAtMs: sequence, observedAtMonotonicMs: sequence, wireType,
      payloadSha256: sha256Hex(canonicalJson(projection)), payloadBytes: 64,
      projectionSha256: realtimeWireProjectionSha256(projection),
      previousObservationSha256: wire.at(-1)?.observationSha256 ?? null,
      identities, projection,
    });
    const observation = Object.freeze({ ...core, observationSha256: realtimeWireObservationSha256(core) });
    wire.push(observation);
    return observation;
  };
  const callId = `${input.provider}-call`;
  const initialResponseId = `${input.provider}-initial`;
  const continuationResponseId = `${input.provider}-continuation`;
  const callIdSha256 = realtimeWireIdentitySha256("call", callId);
  const initialResponseIdSha256 = realtimeWireIdentitySha256("response", initialResponseId);
  const continuationResponseIdSha256 = realtimeWireIdentitySha256("response", continuationResponseId);
  const inputAudioSha256 = sha256Hex(input.audio.data);
  const inputAudioProjection = Object.freeze({
    audio: Object.freeze({
      direction: "input" as const,
      validCanonicalBase64: true,
      sha256: inputAudioSha256,
      byteLength: input.audio.data.byteLength,
      format: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: input.audio.sampleRateHz, channels: 1 as const }),
    }),
  });
  const outputAudioProjection = Object.freeze({
    audio: Object.freeze({
      direction: "output" as const,
      validCanonicalBase64: true,
      sha256: sha256Hex(new Uint8Array([1, 0])),
      byteLength: 2,
      format: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: input.provider === "gemini" ? 24_000 : input.audio.sampleRateHz, channels: 1 as const }),
    }),
  });
  const xaiTarget = createLc4QualificationV3Targets().find((target) => target.provider === "xai")!;
  const xaiTransportParitySha256 = xaiServerVadTransportParitySha256(
    withXaiServerVadPcmSession(productionOpenAiCompatibleSessionUpdate("xai", xaiTarget.configuration)),
    xaiTarget.model,
  );
  const xaiToolFrontierSha256 = realtimeToolFrontierSha256([LC4_S2S_TOOL]);
  const xaiWire = input.provider === "xai" ? (() => {
    const control = observe("outbound", "session.update", Object.freeze({}), {
      dynamicControl: {
        sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
        byteLength: Buffer.byteLength(LC4_S2S_COMPACT_CONTROL, "utf8"),
        authority: "advisory_only_gateway_and_speech_gate_enforced",
        toolFrontierSha256: xaiToolFrontierSha256,
        transportParitySha256: xaiTransportParitySha256,
        delivery: "session.update_before_audio",
      },
    });
    const ack = observe("inbound", "session.updated");
    const inputAudio = observe("outbound", "input_audio_buffer.append", Object.freeze({}), inputAudioProjection);
    const speechStart = observe("inbound", "input_audio_buffer.speech_started");
    const suffixFrame = new Uint8Array(LC4_XAI_SERVER_VAD_SILENCE_TAIL.sample_rate_hz * 2 / 50);
    const suffixFrameSha256 = sha256Hex(suffixFrame);
    const silenceTail = Object.freeze(Array.from(
      { length: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count },
      () => observe("outbound", "input_audio_buffer.append", Object.freeze({}), {
        audio: Object.freeze({
          direction: "input" as const,
          validCanonicalBase64: true,
          sha256: suffixFrameSha256,
          byteLength: suffixFrame.byteLength,
          format: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: 24_000, channels: 1 as const }),
        }),
      }),
    ));
    const speechStop = observe("inbound", "input_audio_buffer.speech_stopped");
    const commit = observe("inbound", "input_audio_buffer.committed");
    const rootResponse = observe("inbound", "response.created", {
      responseIdSha256: initialResponseIdSha256,
    });
    const call = observe("inbound", "response.done", {
      responseIdSha256: initialResponseIdSha256, callIdSha256,
    }, { gatewayCalls: [{
      gateway: "capability_gateway", callIdSha256, responseIdSha256: initialResponseIdSha256,
      argumentsSha256: "a".repeat(64), argumentsBytes: 67, argumentsJsonValid: true,
      targetToolNameSha256: realtimeWireIdentitySha256("target-tool", "complete_current_stage"),
      targetArgumentsSha256: sha256Hex(canonicalJson({})),
    }], terminal: { status: "completed" } });
    const result = observe("outbound", "conversation.item.create", { callIdSha256 }, {
      gatewayResults: [{
        gateway: "capability_gateway", callIdSha256,
        resultSha256: sha256Hex(canonicalJson({ ok: true, qualification_stage: "completed" })),
        resultBytes: 49, resultJsonValid: true,
      }],
    });
    const continuation = observe("outbound", "response.create");
    const continuationStarted = observe("inbound", "response.created", { responseIdSha256: continuationResponseIdSha256 });
    const outputAudio = observe("inbound", "response.audio.delta", { responseIdSha256: continuationResponseIdSha256 }, outputAudioProjection);
    const terminal = observe("inbound", "response.done", { responseIdSha256: continuationResponseIdSha256 }, {
      terminal: { status: "completed" }, usage: { totalTokens: 8 },
    });
    return { control, ack, inputAudio, speechStart, silenceTail, speechStop, commit, rootResponse, call, result, continuation, continuationStarted, outputAudio, terminal };
  })() : null;
  const commonWire = input.provider !== "xai" ? (() => {
    const inputAudio = observe(
      "outbound",
      input.provider === "gemini" ? "realtimeInput.audio" : "input_audio_buffer.append",
      Object.freeze({}),
      inputAudioProjection,
    );
    const trigger = observe("outbound", input.provider === "gemini" ? "realtimeInput.activityEnd" : "response.create");
    const call = observe("inbound", input.provider === "gemini" ? "toolCall" : "response.function_call_arguments.done", {
      callIdSha256,
      ...(input.provider === "gemini" ? {} : { responseIdSha256: initialResponseIdSha256 }),
    }, { gatewayCalls: [{
      gateway: "capability_gateway", callIdSha256,
      ...(input.provider === "gemini" ? {} : { responseIdSha256: initialResponseIdSha256 }),
      argumentsSha256: "a".repeat(64), argumentsBytes: 67, argumentsJsonValid: true,
      targetToolNameSha256: realtimeWireIdentitySha256("target-tool", "complete_current_stage"),
      targetArgumentsSha256: sha256Hex(canonicalJson({})),
    }] });
    const result = observe("outbound", input.provider === "gemini" ? "toolResponse" : "conversation.item.create", { callIdSha256 }, {
      gatewayResults: [{
        gateway: "capability_gateway", callIdSha256,
        resultSha256: sha256Hex(canonicalJson({ ok: true, qualification_stage: "completed" })),
        resultBytes: 49, resultJsonValid: true,
      }],
    });
    const continuation = input.provider === "gemini" ? result : observe("outbound", "response.create");
    const continuationStarted = observe("inbound", input.provider === "gemini" ? "serverContent" : "response.created", {
      ...(input.provider === "gemini" ? {} : { responseIdSha256: continuationResponseIdSha256 }),
    }, input.provider === "gemini" ? outputAudioProjection : {});
    const outputAudio = input.provider === "openai"
      ? observe("inbound", "response.output_audio.delta", { responseIdSha256: continuationResponseIdSha256 }, outputAudioProjection)
      : continuationStarted;
    const terminal = observe("inbound", input.provider === "gemini" ? "serverContent" : "response.done", {
      ...(input.provider === "gemini" ? {} : { responseIdSha256: continuationResponseIdSha256 }),
    }, { terminal: { status: "completed" }, usage: { totalTokens: 8 } });
    return { inputAudio, trigger, call, result, continuation, continuationStarted, outputAudio, terminal };
  })() : null;
  const causalWire = xaiWire ?? commonWire!;
  const triggerObservationSha256 = input.provider === "xai"
    ? xaiWire!.speechStop.observationSha256
    : commonWire!.trigger.observationSha256;
  const sanitizedUsage = Object.freeze({
    schema_version: 1 as const,
    source: "provider_reported" as const,
    response_id_sha256: continuationResponseIdSha256,
    terminal_observation_sha256: causalWire.terminal.observationSha256,
    provider_usage_observation_sha256: causalWire.terminal.observationSha256,
    contributing_wire_observation_sha256s: Object.freeze([causalWire.terminal.observationSha256]),
    counters: Object.freeze({ totalTokens: 8 }),
  });
  const causalBody = Object.freeze({
    schema_version: 1 as const,
    provider: input.provider,
    response_id_source: input.provider === "gemini" ? "client_local" as const : "provider" as const,
    connection_epoch: 1 as const,
    input_turn: 1,
    trigger_observation_sha256: triggerObservationSha256,
    initial_response_id_sha256: initialResponseIdSha256,
    call_id_sha256: callIdSha256,
    call_response_id_sha256: initialResponseIdSha256,
    call_observation_sha256: causalWire.call.observationSha256,
    result_observation_sha256: causalWire.result.observationSha256,
    continuation_request_observation_sha256: causalWire.continuation.observationSha256,
    continuation_response_id_sha256: continuationResponseIdSha256,
    continuation_start_observation_sha256: causalWire.continuationStarted.observationSha256,
    terminal_observation_sha256: causalWire.terminal.observationSha256,
    usage_observation_sha256: causalWire.terminal.observationSha256,
    usage_response_id_sha256: continuationResponseIdSha256,
  });
  const causalBinding = Object.freeze({ ...causalBody, evidence_sha256: roundtripCausalBindingSha256(causalBody) });
  const inputAudioEvidence = projectRoundtripInputAudioEvidence(wire, {
    chunk_sha256s: Object.freeze([inputAudioSha256]),
    chunk_list_sha256: roundtripInputAudioChunkListSha256([inputAudioSha256]),
    audio_sha256: input.audioObject.sha256,
    delivery_profile_sha256: "3".repeat(64),
    packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
    audio_bytes: input.audioObject.byte_length,
    chunk_count: 1,
    frame_bytes: input.audioObject.byte_length,
    tail_bytes: input.audioObject.byte_length,
    sample_rate_hz: input.audioObject.sample_rate_hz,
    ...(input.provider !== "xai" ? {} : {
      transport_suffix: {
        purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
        completion: "full_plan_delivered" as const,
        policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
        pcm_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
        audio_bytes: LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length,
        duration_ms: LC4_XAI_SERVER_VAD_SILENCE_TAIL.duration_ms,
        chunk_sha256s: Object.freeze(Array.from(
          { length: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count },
          () => sha256Hex(new Uint8Array(960)),
        )),
        chunk_list_sha256: roundtripInputAudioChunkListSha256(Array.from(
          { length: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count },
          () => sha256Hex(new Uint8Array(960)),
        )),
        chunk_count: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count,
        frame_bytes: 960,
        tail_bytes: 960,
      },
    }),
  });
  const outputAudioEvidence = projectRoundtripOutputAudioEvidence({
    provider: input.provider,
    wire,
    continuation_start_observation_sha256: causalWire.continuationStarted.observationSha256,
    terminal_observation_sha256: causalWire.terminal.observationSha256,
    continuation_response_id_sha256: continuationResponseIdSha256,
  });
  expect(inputAudioEvidence).not.toBeNull();
  expect(outputAudioEvidence).not.toBeNull();
  const preToolOutputQuarantine = xaiWire === null ? null
    : projectRoundtripPreToolOutputQuarantineEvidence({
        provider: "xai",
        wire,
        response_started_observation_sha256: xaiWire.rootResponse.observationSha256,
        terminal_observation_sha256: xaiWire.call.observationSha256,
        response_id_sha256: initialResponseIdSha256,
      });
  if (input.provider === "xai") expect(preToolOutputQuarantine).not.toBeNull();
  const replaySummary = Object.freeze({
    schema_version: 1 as const,
    provider: input.provider,
    model: input.model,
    connection_epoch: 1 as const,
    call: Object.freeze({ observation_sha256: causalWire.call.observationSha256, call_id_sha256: callIdSha256, response_id_sha256: initialResponseIdSha256 }),
    result: Object.freeze({ observation_sha256: causalWire.result.observationSha256, call_id_sha256: callIdSha256 }),
    continuation: Object.freeze({
      request_observation_sha256: causalWire.continuation.observationSha256,
      origin_response_id_sha256: initialResponseIdSha256,
      started_observation_sha256: causalWire.continuationStarted.observationSha256,
      response_id_sha256: continuationResponseIdSha256,
    }),
    terminal: Object.freeze({ observation_sha256: causalWire.terminal.observationSha256, response_id_sha256: continuationResponseIdSha256, status: "completed" as const }),
    usage: Object.freeze({ evidence_sha256: roundtripSanitizedUsageSha256(sanitizedUsage), response_id_sha256: continuationResponseIdSha256 }),
    input_audio: inputAudioEvidence!,
    output_audio: outputAudioEvidence!,
    ...(preToolOutputQuarantine === null ? {} : {
      pre_tool_output_quarantine: preToolOutputQuarantine,
    }),
  });
  const replay = replayProviderToolRoundtrip({
    expected: { provider: input.provider, model: input.model },
    summary: replaySummary, wire_observations: wire, sanitized_usage: [sanitizedUsage], causal_binding: causalBinding,
  });
  expect(replay.valid, replay.errors.join(", ")).toBe(true);
  const body = Object.freeze({
    schema_version: 3 as const,
    roundtrip_version: "HACC-LC4-S2S-TOOL-ROUNDTRIP-v6" as const,
    provider: input.provider,
    model: input.model,
    attempted_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
    status: "passed" as const,
    failure_class: "none" as const,
    audio: input.audioObject,
    delivery: Object.freeze({
      packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
      delivery_profile_sha256: "3".repeat(64),
      audio_sha256: input.audioObject.sha256,
      audio_bytes: input.audioObject.byte_length,
      chunk_count: 1,
      frame_bytes: input.audioObject.byte_length,
      tail_bytes: input.audioObject.byte_length,
      scheduled_offsets_ms: Object.freeze([0]),
    }),
    compact_control_sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
    tool_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
    response_generation_requested: input.provider !== "xai",
    provider_auto_response_observed: input.provider === "xai",
    transport_failure_diagnostic: null,
    turn_boundary_mode: input.provider === "xai" ? "provider_native_server_vad" as const : "manual_commit" as const,
    server_vad_setting_sha256: input.provider === "xai" ? LC4_XAI_SERVER_VAD_SETTING_SHA256 : null,
    server_vad_transport_disclosure_sha256: input.provider === "xai" ? LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256 : null,
    transport_parity_sha256: input.provider === "xai" ? xaiTransportParitySha256 : null,
    tool_frontier_sha256: input.provider === "xai" ? xaiToolFrontierSha256 : "c".repeat(64),
    per_turn_session_update_observation_sha256: xaiWire?.control.observationSha256 ?? null,
    per_turn_session_ack_observation_sha256: xaiWire?.ack.observationSha256 ?? null,
    server_vad_speech_start_observation_sha256: xaiWire?.speechStart.observationSha256 ?? null,
    server_vad_speech_stop_observation_sha256: xaiWire?.speechStop.observationSha256 ?? null,
    server_vad_auto_commit_observation_sha256: xaiWire?.commit.observationSha256 ?? null,
    server_vad_auto_response_observation_sha256: xaiWire?.rootResponse.observationSha256 ?? null,
    manual_turn_commit_observation_sha256: input.provider === "xai" ? null : null,
    response_trigger_observation_sha256: input.provider === "xai" ? xaiWire?.speechStop.observationSha256 ?? null : null,
    tool_call_observed: true,
    tool_result_submitted: true,
    tool_result_event_observed: true,
    tool_result_wire_observed: true,
    post_tool_continuation_requested: true,
    post_tool_continuation_observed: true,
    post_tool_terminal_observed: true,
    post_tool_usage_observed: true,
    provider_tool_call_evidence_sha256: "4".repeat(64),
    tool_result_evidence_sha256: "5".repeat(64),
    input_audio_evidence: inputAudioEvidence,
    output_audio_evidence: outputAudioEvidence,
    pre_tool_output_quarantine: preToolOutputQuarantine,
    wire_observations: Object.freeze(wire),
    usage: Object.freeze([{ totalTokens: 8, raw: { total: 8 } }]),
    replay_summary: replaySummary,
    replay_causal_binding: causalBinding,
    sanitized_usage: Object.freeze([sanitizedUsage]),
    public_execution_sha256: replay.public_execution_sha256,
    replay_sha256: replay.replay_sha256,
    operation_order: Object.freeze(input.provider === "xai"
      ? ["session_ready", "server_vad_control_updated", "server_vad_control_acknowledged", "server_vad_speech_started", "server_vad_speech_stopped", "server_vad_auto_commit_observed", "provider_auto_response_observed", "exact_tool_call_observed", "matching_tool_result_submitted", "post_tool_continuation_requested", "post_tool_terminal_observed"]
      : ["session_ready", "response_generation_requested", "exact_tool_call_observed", "matching_tool_result_submitted", "post_tool_terminal_observed"]),
    failure_evidence_sha256: "6".repeat(64),
  });
  const execution = Object.freeze({
    ...body,
    evidence_sha256: sha256Hex(`harshas-amazing-call-center/lc4-s2s-roundtrip-evidence/v6\n${canonicalJson(body)}`),
  });
  assertLc4S2sRoundtripExecution(execution);
  return execution;
}

function failedRetainedExecution(
  input: Parameters<NonNullable<Parameters<typeof runLc4QualificationV3>[0]["dependencies"]>["executeRoundtrip"]>[0],
): Lc4S2sRoundtripExecution {
  const passing = passedExecution(input);
  const { evidence_sha256: discardedEvidenceSha256, ...passingBody } = passing;
  expect(discardedEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
  const body = Object.freeze({
    ...passingBody,
    status: "failed" as const,
    failure_class: "provider_error" as const,
    replay_summary: input.provider === "openai" ? passing.replay_summary : null,
    replay_causal_binding: input.provider === "openai" ? passing.replay_causal_binding : null,
    public_execution_sha256: null,
    replay_sha256: null,
  });
  const failed = Object.freeze({
    ...body,
    evidence_sha256: sha256Hex(
      `harshas-amazing-call-center/lc4-s2s-roundtrip-evidence/v6\n${canonicalJson(body)}`,
    ),
  });
  assertLc4S2sRoundtripExecution(failed);
  return failed;
}

describe("LC4 qualification v3 signed runner", () => {
  it("signs the exact source/fixture plan and rejects plan mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-evidence-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-plan-test",
      dependencies: { inspectGitSource: async () => SOURCE, loadCredentials: async () => CREDENTIALS, materializeAudio: (await import("../provider-s2s-tool-roundtrip")).materializeLc4S2sAudioFixture },
    });
    expect(plan.body).toMatchObject({
      provider_calls_authorized: false,
      maximum_provider_sessions: 6,
      maximum_paid_sessions: 3,
      maximum_generation_phases: 6,
      maximum_tool_roundtrips: 3,
    });
    expect(plan.body.control_size_diagnostic.qualification_gate).toBe(false);
    const xaiConfiguration = createLc4QualificationV3Targets().find((target) => target.provider === "xai")!.configuration;
    expect(plan.body.targets.find((target) => target.provider === "xai")?.production_session_payload_sha256)
      .toBe(productionSessionPayloadParitySha256("xai", xaiConfiguration));
    expect(() => assertLc4QualificationV3PlanArtifact(plan, authority.fingerprint)).not.toThrow();
    expect(() => assertLc4QualificationV3PlanArtifact({
      ...plan,
      body: { ...plan.body, maximum_paid_sessions: 2 as 3 },
    }, authority.fingerprint)).toThrow("hash mismatch");
  });

  it("creates only a fresh outside-repository 0700 evidence root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-root-boundary-"));
    roots.push(workspace);
    const repositoryRoot = join(workspace, "repository");
    await mkdir(repositoryRoot, { mode: 0o700 });
    const authority = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const prepare = (root: string, planId: string) => prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId,
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      },
    });

    const absent = join(workspace, "absent-evidence");
    await expect(prepare(absent, "qualification-v3-absent-root")).resolves.toBeDefined();
    expect((await lstat(absent)).mode & 0o777).toBe(0o700);

    const safeEmpty = join(workspace, "safe-empty-evidence");
    await mkdir(safeEmpty, { mode: 0o700 });
    await expect(prepare(safeEmpty, "qualification-v3-safe-empty-root")).resolves.toBeDefined();

    const nonempty = join(workspace, "nonempty-evidence");
    await mkdir(nonempty, { mode: 0o700 });
    await writeFile(join(nonempty, "foreign.txt"), "foreign", { mode: 0o600 });
    await expect(prepare(nonempty, "qualification-v3-nonempty-root")).rejects.toThrow("fresh and empty");

    const loose = join(workspace, "loose-evidence");
    await mkdir(loose, { mode: 0o755 });
    await expect(prepare(loose, "qualification-v3-loose-root")).rejects.toThrow("private 0700");

    const linkTarget = join(workspace, "link-target");
    const linked = join(workspace, "linked-evidence");
    await mkdir(linkTarget, { mode: 0o700 });
    await symlink(linkTarget, linked);
    await expect(prepare(linked, "qualification-v3-linked-root")).rejects.toThrow("private 0700");

    await expect(prepare(join(repositoryRoot, "inside"), "qualification-v3-inside-root"))
      .rejects.toThrow("outside the repository");
    await expect(prepare("relative-evidence", "qualification-v3-relative-root"))
      .rejects.toThrow("absolute normalized path");
  });

  it("loads CLI keys and authorization only from stable private absolute files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-secure-files-"));
    roots.push(workspace);
    const identity = keys();
    const keyPath = join(workspace, "terminal.pem");
    await writeFile(keyPath, identity.privatePem, { mode: 0o600 });
    await expect(loadLc4QualificationV3PrivateKeyFile(keyPath, "test terminal key"))
      .resolves.toBe(identity.privatePem);
    await expect(loadLc4QualificationV3PrivateKeyFile("terminal.pem", "test terminal key"))
      .rejects.toThrow("absolute normalized path");

    const keyLink = join(workspace, "terminal-link.pem");
    await symlink(keyPath, keyLink);
    await expect(loadLc4QualificationV3PrivateKeyFile(keyLink, "test terminal key"))
      .rejects.toThrow("private regular non-linked file");

    const prepareStdout: string[] = [];
    const prepareStderr: string[] = [];
    const cliEvidenceRoot = join(workspace, "cli-evidence");
    await expect(runLc4QualificationV3Cli([
      "prepare",
      "--root", cliEvidenceRoot,
      "--repository-root", workspace,
      "--authority-private-key", keyLink,
      "--trust-root-fingerprint", identity.fingerprint,
      "--provider-env-file", join(workspace, "provider.env"),
      "--repo-env-file", join(workspace, "repo.env"),
    ], {
      stdout: (value) => prepareStdout.push(value),
      stderr: (value) => prepareStderr.push(value),
    })).resolves.toBe(1);
    expect(prepareStdout).toEqual([]);
    expect(prepareStderr.join("\n")).toContain('"code":"cli_input_invalid"');
    await expect(lstat(cliEvidenceRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const looseKey = join(workspace, "loose.pem");
    await writeFile(looseKey, identity.privatePem, { mode: 0o644 });
    await expect(loadLc4QualificationV3PrivateKeyFile(looseKey, "test terminal key"))
      .rejects.toThrow("private regular non-linked file");

    const hardLink = join(workspace, "terminal-hardlink.pem");
    await link(keyPath, hardLink);
    await expect(loadLc4QualificationV3PrivateKeyFile(keyPath, "test terminal key"))
      .rejects.toThrow("private regular non-linked file");

    const authorizationPath = join(workspace, "authorization.json");
    await writeFile(authorizationPath, "{}\n", { mode: 0o400 });
    await expect(loadLc4QualificationV3AuthorizationFile(authorizationPath)).resolves.toEqual({});
    const authorizationLink = join(workspace, "authorization-link.json");
    await symlink(authorizationPath, authorizationLink);
    const runStderr: string[] = [];
    await expect(runLc4QualificationV3Cli([
      "run",
      "--root", workspace,
      "--repository-root", workspace,
      "--authorization", authorizationLink,
      "--trust-root-fingerprint", identity.fingerprint,
      "--terminal-private-key", keyPath,
      "--provider-env-file", join(workspace, "provider.env"),
      "--repo-env-file", join(workspace, "repo.env"),
    ], {
      stdout: () => undefined,
      stderr: (value) => runStderr.push(value),
    })).resolves.toBe(1);
    expect(runStderr.join("\n")).toContain('"code":"cli_input_invalid"');
    await chmod(authorizationPath, 0o444);
    await expect(loadLc4QualificationV3AuthorizationFile(authorizationPath))
      .rejects.toThrow("private regular non-linked file");

    const malformedPath = join(workspace, "malformed-authorization.json");
    await writeFile(malformedPath, "{\n", { mode: 0o400 });
    await expect(loadLc4QualificationV3AuthorizationFile(malformedPath))
      .rejects.toThrow("valid UTF-8 JSON");
  });

  it("retains a signed replay-complete terminal and self-excluding package envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-evidence-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-run-plan",
      dependencies: { inspectGitSource: async () => SOURCE, loadCredentials: async () => CREDENTIALS, materializeAudio: audioModule.materializeLc4S2sAudioFixture },
    });
    const authBody: Lc4QualificationV3AuthorizationBody = Object.freeze({
      schema_version: 1,
      authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
      authorization_id: "qualification-v3-attempt-001",
      authorization_nonce_sha256: "7".repeat(64),
      plan_artifact_sha256: plan.artifact_sha256,
      plan_sha256: plan.body.plan_sha256,
      source_commit: plan.body.source.source_commit,
      source_tree_sha256: plan.body.source.source_tree_sha256,
      credential_set_sha256: plan.body.credential_set_sha256,
      terminal_public_key_spki_base64: terminalKey.publicSpkiBase64,
      terminal_public_key_fingerprint_sha256: terminalKey.fingerprint,
      maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
      maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
      maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
      maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
      maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
      paid_retry_allowed: false,
      not_before: "2026-07-22T19:30:00.000Z",
      expires_at: "2026-07-22T20:30:00.000Z",
    });
    const authorization = createLc4QualificationV3AuthorizationArtifact({ body: authBody, authorityPrivateKeyPem: authority.privatePem });
    expect(LC4_QUALIFICATION_V3_MAXIMUM_AUTHORIZATION_TTL_MS).toBe(3_600_000);
    const overlongAuthorization = createLc4QualificationV3AuthorizationArtifact({
      body: Object.freeze({
        ...authBody,
        authorization_id: "qualification-v3-attempt-overlong",
        authorization_nonce_sha256: "e".repeat(64),
        not_before: "2026-07-22T19:00:00.000Z",
      }),
      authorityPrivateKeyPem: authority.privatePem,
    });
    expect(() => assertLc4QualificationV3Authorization({
      artifact: overlongAuthorization,
      plan,
      trustRootFingerprint: authority.fingerprint,
      now: NOW,
    })).toThrow("maximum TTL");
    const terminal = await runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
        createClient: (provider) => new SetupClient(provider, true),
        executeRoundtrip: async (input) => passedExecution(input),
      },
    });
    expect(terminal.body).toMatchObject({
      status: "passed",
      provider_sessions_opened: 6,
      paid_sessions_opened: 3,
      generation_phases_attempted: 6,
      tool_roundtrips_attempted: 3,
      paid_retries_attempted: 0,
      server_vad_qualification: {
        gate_a_classification: "acknowledged_unverifiable_server_vad",
        retained_risk: "provider_omitted_turn_detection_fields",
        gate_b_required: true,
        gate_b_status: "behaviorally_verified",
        gate_b_evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        exact_setting_verified: false,
        operational_vad_verified: true,
        benchmark_ready: true,
      },
    });
    const gateB = JSON.parse(await readFile(
      join(root, "attempts", `${authBody.authorization_id}.complete`, "xai-server-vad-gate-b-binding.json"),
      "utf8",
    )) as { body?: never } & Record<string, unknown>;
    expect(gateB).toMatchObject({
      caller_audio_bytes: plan.body.targets.find((target) => target.provider === "xai")?.caller_audio_bytes,
      server_vad_silence_tail_policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
      server_vad_silence_tail_pcm_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
      server_vad_silence_tail_bytes: LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length,
      server_vad_silence_tail_observation_list_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      silence_tail_precedes_speech_stop_verified: true,
    });
    const envelope = JSON.parse(await readFile(join(root, "attempts", `${authBody.authorization_id}.complete`, "qualification-package-envelope.json"), "utf8")) as { body: { self_excluded: boolean; entries: { path: string }[] } };
    expect(envelope.body.self_excluded).toBe(true);
    expect(envelope.body.entries.map((entry) => entry.path)).not.toContain("qualification-package-envelope.json");
    expect(envelope.body.entries.some((entry) => /\.pem$|\.env$/u.test(entry.path))).toBe(false);
    expect(terminal.body.roundtrip_public_execution_sha256).toHaveLength(3);
    expect(terminal.body.roundtrip_replay_sha256).toHaveLength(3);
    expect(terminal.body.package_bindings).toMatchObject({
      provider_session_count: 6,
      paid_session_count: 3,
      generation_phase_count: 6,
      tool_roundtrip_count: 3,
      retry_count: 0,
      reconnect_count: 0,
    });
    const report = await reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint });
    expect(report).toMatchObject({
      invoked_attempts: 1,
      refused_attempts: 0,
      stranded_invocations: 0,
      complete_attempts: 1,
      partial_attempts: 0,
      gate_c_qualification_gate: false,
      latest: {
        server_vad_qualification: {
          gate_a_classification: "acknowledged_unverifiable_server_vad",
          gate_b_status: "behaviorally_verified",
          benchmark_ready: true,
        },
      },
    });
    const riskPath = join(root, "attempts", `${authBody.authorization_id}.complete`, "xai-server-vad-gate-a-risk.json");
    const risk = JSON.parse(await readFile(riskPath, "utf8")) as { policy_sha256: string };
    await chmod(riskPath, 0o600);
    await writeFile(riskPath, `${canonicalJson({ ...risk, policy_sha256: "0".repeat(64) })}\n`);
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint }))
      .rejects.toThrow(/qualification package|risk artifact/u);
  });

  it("reports three retained failed executions without inventing replay-success hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-all-failed-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-all-failed-plan",
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      },
    });
    const authorization = authorizationFor(
      plan,
      authority.privatePem,
      terminalKey,
      "qualification-v3-all-failed-attempt",
    );
    const terminal = await runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
        createClient: (provider) => new SetupClient(provider, true),
        executeRoundtrip: async (input) => failedRetainedExecution(input),
      },
    });
    expect(terminal.body).toMatchObject({
      status: "failed",
      provider_sessions_opened: 6,
      paid_sessions_opened: 3,
      generation_phases_attempted: 6,
      tool_roundtrips_attempted: 3,
    });
    expect(terminal.body.results).toHaveLength(3);
    expect(terminal.body.roundtrip_evidence_sha256).toHaveLength(3);
    expect(terminal.body.roundtrip_public_execution_sha256).toEqual([]);
    expect(terminal.body.roundtrip_replay_sha256).toEqual([]);
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint }))
      .resolves.toMatchObject({
        complete_attempts: 1,
        fully_replay_verified_complete_attempts: 0,
        retained_completed_executions: 3,
        replay_verified_completed_executions: 0,
        legacy_replay_valid_under_current_verifier_executions: 1,
        legacy_nullable_replay_hash_array_attempts: 0,
        latest: {
          status: "failed",
          results: [
            { provider: "openai", status: "failed" },
            { provider: "gemini", status: "failed" },
            { provider: "xai", status: "failed" },
          ],
          roundtrip_public_execution_sha256: [],
          roundtrip_replay_sha256: [],
        },
      });
  });

  it("reports a sealed pre-retention runner exception without setup acceptance and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-pre-setup-failure-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-pre-setup-failure-plan",
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      },
    });
    const authorization = authorizationFor(
      plan,
      authority.privatePem,
      terminalKey,
      "qualification-v3-pre-setup-failure-attempt",
    );
    const originalTerminal = await runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
        createClient: (provider) => new SetupClient(provider, true),
        executeRoundtrip: async () => {
          throw new Error("synthetic post-setup runner exception");
        },
      },
    });
    expect(originalTerminal.body).toMatchObject({
      status: "failed",
      primary_failure_class: expect.stringMatching(/^runner_exception:[a-f0-9]{64}$/u),
      provider_sessions_opened: 4,
      paid_sessions_opened: 1,
      generation_phases_attempted: 2,
      tool_roundtrips_attempted: 1,
      results: [],
    });
    expect(originalTerminal.body.package_bindings).toMatchObject({
      provider_session_count: 4,
      paid_session_count: 1,
      generation_phase_count: 2,
      tool_roundtrip_count: 1,
      replay_event_count: expect.any(Number),
      replay_chain_head_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const directory = join(root, "attempts", `${authorization.body.authorization_id}.complete`);
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint }))
      .resolves.toMatchObject({
        complete_attempts: 1,
        fully_replay_verified_complete_attempts: 0,
        sealed_mid_paid_runner_exceptions: 1,
        replay_verified_completed_executions: 0,
        legacy_completed_only_package_bindings: 0,
        latest: {
          provider_sessions_opened: 4,
          paid_sessions_opened: 1,
          generation_phases_attempted: 2,
          tool_roundtrips_attempted: 1,
          package_bindings: {
            provider_session_count: 4,
            paid_session_count: 1,
            generation_phase_count: 2,
            tool_roundtrip_count: 1,
          },
        },
      });

    const terminalPath = join(directory, "terminal.json");
    const envelopePath = join(directory, "qualification-package-envelope.json");
    const originalTerminalBytes = await readFile(terminalPath);
    const originalEnvelopeBytes = await readFile(envelopePath);
    const { terminal_sha256: discardedMidPaidTerminalSha256, ...midPaidBody } = originalTerminal.body;
    expect(discardedMidPaidTerminalSha256).toMatch(/^[a-f0-9]{64}$/u);
    const tamperedBindings = Object.freeze({
      ...originalTerminal.body.package_bindings,
      provider_session_count: 5,
      paid_session_count: 2,
      generation_phase_count: 4,
      tool_roundtrip_count: 2,
    }) satisfies Lc4QualificationPackageBindingsV5;
    const tamperedBodyWithoutHash = Object.freeze({
      ...midPaidBody,
      package_bindings: tamperedBindings,
      provider_sessions_opened: 5,
      paid_sessions_opened: 2,
      generation_phases_attempted: 4,
      tool_roundtrips_attempted: 2,
    });
    const tamperedTerminal = signTestTerminal(Object.freeze({
      ...tamperedBodyWithoutHash,
      terminal_sha256: sha256Hex(
        `${TEST_TERMINAL_DOMAIN}${canonicalJson(tamperedBodyWithoutHash)}`,
      ),
    }) satisfies Lc4QualificationV3TerminalBody, terminalKey.privatePem);
    await chmod(terminalPath, 0o600);
    await writeFile(terminalPath, `${canonicalJson(tamperedTerminal)}\n`, { mode: 0o400 });
    const tamperedPackageFiles = await Promise.all((await readdir(directory))
      .filter((path) => path !== "qualification-package-envelope.json")
      .sort()
      .map(async (path): Promise<Lc4QualificationPackageFile> => Object.freeze({
        path,
        bytes: await readFile(join(directory, path)),
      })));
    const tamperedEnvelope = createSignedLc4QualificationPackageEnvelopeV5({
      files: tamperedPackageFiles,
      terminalClaims: Object.freeze({
        terminal_artifact_sha256: tamperedTerminal.artifact_sha256,
        payload_root_sha256: tamperedTerminal.body.payload_root_sha256,
        bindings: tamperedTerminal.body.package_bindings,
      }),
      terminalPath: "terminal.json",
      envelopePath: "qualification-package-envelope.json",
      authorityPrivateKeyPem: terminalKey.privatePem,
    });
    await chmod(envelopePath, 0o600);
    await writeFile(envelopePath, `${canonicalJson(tamperedEnvelope)}\n`, { mode: 0o400 });
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint }))
      .rejects.toThrow("incomplete paid admission");
    await chmod(terminalPath, 0o600);
    await writeFile(terminalPath, originalTerminalBytes, { mode: 0o400 });
    await chmod(envelopePath, 0o600);
    await writeFile(envelopePath, originalEnvelopeBytes, { mode: 0o400 });

    await unlink(join(directory, "setup-acceptance.json"));
    const evidenceFiles = await Promise.all((await readdir(directory))
      .filter((path) => path !== "terminal.json" && path !== "qualification-package-envelope.json")
      .sort()
      .map(async (path): Promise<Lc4QualificationPackageFile> => Object.freeze({
        path,
        bytes: await readFile(join(directory, path)),
      })));
    const payload = createLc4QualificationPayloadManifestV5({
      files: Object.freeze([
        ...evidenceFiles,
        Object.freeze({ path: "terminal.json", bytes: Buffer.from("pending") }),
      ]),
      terminalPath: "terminal.json",
      envelopePath: "qualification-package-envelope.json",
    });
    const bindings = Object.freeze({
      ...originalTerminal.body.package_bindings,
      provider_session_count: 3,
      paid_session_count: 0,
      generation_phase_count: 0,
      tool_roundtrip_count: 0,
    }) satisfies Lc4QualificationPackageBindingsV5;
    const { terminal_sha256: discardedTerminalSha256, ...originalBody } = originalTerminal.body;
    expect(discardedTerminalSha256).toMatch(/^[a-f0-9]{64}$/u);
    const bodyWithoutTerminalSha256 = Object.freeze({
      ...originalBody,
      payload_root_sha256: payload.payload_root_sha256,
      package_bindings: bindings,
      provider_sessions_opened: 3,
      paid_sessions_opened: 0,
      generation_phases_attempted: 0,
      tool_roundtrips_attempted: 0,
    });
    const terminalBody = Object.freeze({
      ...bodyWithoutTerminalSha256,
      terminal_sha256: sha256Hex(`${TEST_TERMINAL_DOMAIN}${canonicalJson(bodyWithoutTerminalSha256)}`),
    }) satisfies Lc4QualificationV3TerminalBody;
    const terminal = signTestTerminal(terminalBody, terminalKey.privatePem);
    await chmod(join(directory, "terminal.json"), 0o600);
    await writeFile(join(directory, "terminal.json"), `${canonicalJson(terminal)}\n`, { mode: 0o400 });
    const packageFiles = Object.freeze([
      ...evidenceFiles,
      Object.freeze({ path: "terminal.json", bytes: await readFile(join(directory, "terminal.json")) }),
    ]);
    const envelope = createSignedLc4QualificationPackageEnvelopeV5({
      files: packageFiles,
      terminalClaims: Object.freeze({
        terminal_artifact_sha256: terminal.artifact_sha256,
        payload_root_sha256: terminal.body.payload_root_sha256,
        bindings: terminal.body.package_bindings,
      }),
      terminalPath: "terminal.json",
      envelopePath: "qualification-package-envelope.json",
      authorityPrivateKeyPem: terminalKey.privatePem,
    });
    await chmod(join(directory, "qualification-package-envelope.json"), 0o600);
    await writeFile(
      join(directory, "qualification-package-envelope.json"),
      `${canonicalJson(envelope)}\n`,
      { mode: 0o400 },
    );

    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint }))
      .resolves.toMatchObject({
        complete_attempts: 1,
        fully_replay_verified_complete_attempts: 0,
        sealed_pre_retention_runner_exceptions: 1,
        latest: {
          status: "failed",
          primary_failure_class: expect.stringMatching(/^runner_exception:[a-f0-9]{64}$/u),
          provider_sessions_opened: 3,
          paid_sessions_opened: 0,
          generation_phases_attempted: 0,
          tool_roundtrips_attempted: 0,
        },
      });

    const riskPath = join(directory, "xai-server-vad-gate-a-risk.json");
    const risk = JSON.parse(await readFile(riskPath, "utf8")) as { risk_sha256: string };
    await chmod(riskPath, 0o600);
    await writeFile(riskPath, `${canonicalJson({ ...risk, risk_sha256: "0".repeat(64) })}\n`);
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint }))
      .rejects.toThrow(/qualification package|risk artifact/u);
  });

  it("loads only two explicit regular files with stable repository-last precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-env-"));
    roots.push(root);
    const provider = join(root, "provider.env");
    const repository = join(root, "repository.env");
    await writeFile(provider, [
      "OPENAI_API_KEY=provider-openai-secret",
      "GEMINI_API_KEY=provider-gemini-secret",
      "XAI_API_KEY=provider-xai-secret",
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(repository, [
      "OPENAI_API_KEY=repository-openai-secret",
      "XAI_API_KEY=repository-xai-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    const previous = {
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      xai: process.env.XAI_API_KEY,
      selected: process.env.BENCHMARK_PROVIDER_ENV_FILE,
    };
    process.env.OPENAI_API_KEY = "hostile-ambient-openai";
    process.env.GEMINI_API_KEY = "hostile-ambient-gemini";
    process.env.XAI_API_KEY = "hostile-ambient-xai";
    process.env.BENCHMARK_PROVIDER_ENV_FILE = join(root, "ambient-must-not-be-read.env");
    try {
      await expect(loadLc4QualificationV3ExplicitCredentials({
        providerEnvFile: provider,
        repoEnvFile: repository,
      })).resolves.toEqual({
        openai: "repository-openai-secret",
        gemini: "provider-gemini-secret",
        xai: "repository-xai-secret",
      });
    } finally {
      for (const [name, value] of Object.entries({
        OPENAI_API_KEY: previous.openai,
        GEMINI_API_KEY: previous.gemini,
        XAI_API_KEY: previous.xai,
        BENCHMARK_PROVIDER_ENV_FILE: previous.selected,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    await expect(loadLc4QualificationV3ExplicitCredentials({
      providerEnvFile: join(root, "missing.env"),
      repoEnvFile: repository,
    })).rejects.toMatchObject({ stage: "credentials", code: "credential_source_invalid" });
    const providerLink = join(root, "provider-link.env");
    await symlink(provider, providerLink);
    await expect(loadLc4QualificationV3ExplicitCredentials({
      providerEnvFile: providerLink,
      repoEnvFile: repository,
    })).rejects.toMatchObject({ stage: "credentials", code: "credential_source_invalid" });
    await expect(loadLc4QualificationV3ExplicitCredentials({
      providerEnvFile: `${root}/nested/../provider.env`,
      repoEnvFile: repository,
    })).rejects.toMatchObject({ stage: "credentials", code: "credential_source_invalid" });
  });

  it("re-checks authorization expiry before every provider admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-expiry-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-expiry-plan",
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      },
    });
    const authorization = createLc4QualificationV3AuthorizationArtifact({
      body: Object.freeze({
        schema_version: 1,
        authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
        authorization_id: "qualification-v3-expiry-attempt",
        authorization_nonce_sha256: "f".repeat(64),
        plan_artifact_sha256: plan.artifact_sha256,
        plan_sha256: plan.body.plan_sha256,
        source_commit: plan.body.source.source_commit,
        source_tree_sha256: plan.body.source.source_tree_sha256,
        credential_set_sha256: plan.body.credential_set_sha256,
        terminal_public_key_spki_base64: terminalKey.publicSpkiBase64,
        terminal_public_key_fingerprint_sha256: terminalKey.fingerprint,
        maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
        maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
        maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
        maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
        maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
        paid_retry_allowed: false,
        not_before: "2026-07-22T19:30:00.000Z",
        expires_at: "2026-07-22T20:30:00.000Z",
      }),
      authorityPrivateKeyPem: authority.privatePem,
    });
    const mutableAuthorization = JSON.parse(canonicalJson(authorization)) as Lc4QualificationV3AuthorizationArtifact;
    expect(Object.isFrozen(mutableAuthorization.body)).toBe(false);
    let clock = NOW;
    const providerAdmissions: Array<Readonly<{ provider: LiveStsProvider; admitted_at: string }>> = [];
    let roundtrips = 0;
    const terminal = await runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization: mutableAuthorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => clock,
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
        createClient: (provider) => {
          providerAdmissions.push(Object.freeze({ provider, admitted_at: clock.toISOString() }));
          clock = new Date("2026-07-22T20:30:00.000Z");
          return new SetupClient(provider, true);
        },
        executeRoundtrip: async (input) => {
          roundtrips += 1;
          return passedExecution(input);
        },
      },
    });
    expect(terminal.body.status).toBe("failed");
    expect(providerAdmissions).toEqual([{ provider: "openai", admitted_at: NOW.toISOString() }]);
    expect(roundtrips).toBe(0);
    expect(terminal.body.provider_sessions_opened).toBe(1);
    expect(terminal.body.paid_sessions_opened).toBe(0);
    expect(Object.isFrozen(mutableAuthorization)).toBe(true);
    expect(Object.isFrozen(mutableAuthorization.body)).toBe(true);
  });

  it("rejects evidence-root replacement after invocation but before provider admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-replaced-root-"));
    const movedRoot = `${root}.moved`;
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, movedRoot, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-root-replacement-plan",
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      },
    });
    const authorization = authorizationFor(
      plan,
      authority.privatePem,
      terminalKey,
      "qualification-v3-root-replacement-attempt",
    );
    let credentialReads = 0;
    let clientConstructions = 0;
    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies: {
        inspectGitSource: async () => {
          await rename(root, movedRoot);
          await mkdir(root, { mode: 0o700 });
          return SOURCE;
        },
        loadCredentials: async () => {
          credentialReads += 1;
          return CREDENTIALS;
        },
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
        createClient: (provider) => {
          clientConstructions += 1;
          return new SetupClient(provider, true);
        },
        executeRoundtrip: async (input) => passedExecution(input),
      },
    })).rejects.toMatchObject({ stage: "plan", code: "plan_validation_failed" });
    expect(credentialReads).toBe(0);
    expect(clientConstructions).toBe(0);
    await expect(lstat(join(movedRoot, "attempts", `${authorization.body.authorization_id}.invoked.json`)))
      .resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(lstat(join(root, "attempts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("strands authority and retains a signed refusal before budget or provider construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-refusal-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-refusal-plan",
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      },
    });
    const authBody: Lc4QualificationV3AuthorizationBody = Object.freeze({
      schema_version: 1,
      authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
      authorization_id: "qualification-v3-refusal-001",
      authorization_nonce_sha256: "8".repeat(64),
      plan_artifact_sha256: plan.artifact_sha256,
      plan_sha256: plan.body.plan_sha256,
      source_commit: plan.body.source.source_commit,
      source_tree_sha256: plan.body.source.source_tree_sha256,
      credential_set_sha256: plan.body.credential_set_sha256,
      terminal_public_key_spki_base64: terminalKey.publicSpkiBase64,
      terminal_public_key_fingerprint_sha256: terminalKey.fingerprint,
      maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
      maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
      maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
      maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
      maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
      paid_retry_allowed: false,
      not_before: "2026-07-22T19:30:00.000Z",
      expires_at: "2026-07-22T20:30:00.000Z",
    });
    const authorization = createLc4QualificationV3AuthorizationArtifact({
      body: authBody,
      authorityPrivateKeyPem: authority.privatePem,
    });
    let sourceInspections = 0;
    let credentialReads = 0;
    let clientConstructions = 0;
    const dependencies = {
      inspectGitSource: async () => {
        sourceInspections += 1;
        return SOURCE;
      },
      loadCredentials: async () => {
        credentialReads += 1;
        return Object.freeze({ ...CREDENTIALS, openai: "rotated-openai-qualification-secret" });
      },
      materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      createClient: (provider: LiveStsProvider) => {
        clientConstructions += 1;
        return new SetupClient(provider);
      },
      executeRoundtrip: async (input: Parameters<typeof passedExecution>[0]) => passedExecution(input),
    };
    await chmod(root, 0o755);
    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies,
    })).rejects.toMatchObject({ stage: "plan", code: "plan_validation_failed" });
    expect(sourceInspections).toBe(0);
    expect(credentialReads).toBe(0);
    expect(clientConstructions).toBe(0);
    await expect(lstat(join(root, "attempts"))).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(root, 0o700);

    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: keys().privatePem,
      now: () => NOW,
      dependencies,
    })).rejects.toMatchObject({ stage: "terminal_key", code: "terminal_key_validation_failed" });
    await expect(readFile(join(root, "attempts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(sourceInspections).toBe(0);
    expect(credentialReads).toBe(0);
    expect(clientConstructions).toBe(0);

    const invocation = runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies,
    });
    await expect(invocation).rejects.toMatchObject({
      stage: "credentials",
      code: "credential_set_mismatch",
    });
    expect(sourceInspections).toBe(1);
    expect(credentialReads).toBe(1);
    expect(clientConstructions).toBe(0);
    await expect(readFile(join(root, "attempts", `${authBody.authorization_id}.invoked.json`), "utf8")).resolves.toContain(authBody.authorization_id);
    await expect(readFile(join(root, "attempts", `${authBody.authorization_id}.refusal.json`), "utf8")).resolves.toContain("credential_set_mismatch");
    await expect(readFile(join(root, "budget", "qualification-v3.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint })).resolves.toMatchObject({
      invoked_attempts: 1,
      refused_attempts: 1,
      stranded_invocations: 0,
      complete_attempts: 0,
      partial_attempts: 0,
    });

    const sourceAuthorization = createLc4QualificationV3AuthorizationArtifact({
      body: Object.freeze({
        ...authBody,
        authorization_id: "qualification-v3-source-refusal-001",
        authorization_nonce_sha256: "9".repeat(64),
      }),
      authorityPrivateKeyPem: authority.privatePem,
    });
    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization: sourceAuthorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies: {
        ...dependencies,
        inspectGitSource: async () => {
          sourceInspections += 1;
          return Object.freeze({ ...SOURCE, source_tree_sha256: "d".repeat(64) });
        },
      },
    })).rejects.toMatchObject({ stage: "source", code: "source_mismatch" });
    expect(sourceInspections).toBe(2);
    expect(credentialReads).toBe(1);
    expect(clientConstructions).toBe(0);
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint })).resolves.toMatchObject({
      invoked_attempts: 2,
      refused_attempts: 2,
      stranded_invocations: 0,
      complete_attempts: 0,
      partial_attempts: 0,
    });

    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies,
    })).rejects.toMatchObject({ stage: "invocation", code: "authorization_already_invoked" });
    expect(sourceInspections).toBe(2);
    expect(credentialReads).toBe(1);
    expect(clientConstructions).toBe(0);
  });
});
