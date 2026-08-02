import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
  LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
  LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
  LC4_XAI_SERVER_VAD_SETTING_SHA256,
  createXaiServerVadGateARiskArtifact,
  createXaiServerVadGateBBindingArtifact,
  createLc4QualificationV3AuthorizationArtifact,
  createLc4QualificationV3PaidTargets,
  createLc4QualificationV3Targets,
  credentialIdentity,
  credentialSetSha256,
  prepareLc4QualificationV3,
  retainRoundtrip,
  runLc4QualificationV3,
  type Lc4QualificationV3GitSource,
  type Lc4QualificationV3PlanArtifact,
} from "../lc4-qualification-v3-runner";
import type { Lc4QualificationPackageFile } from "../lc4-qualification-package-envelope";
import {
  productionOpenAiCompatibleSessionUpdate,
} from "../production-realtime-provider";
import {
  LC4_S2S_COMPACT_CONTROL,
  LC4_S2S_COMPACT_CONTROL_SHA256,
  LC4_S2S_HISTORY_PROBE,
  LC4_S2S_HISTORY_PROBE_SHA256,
  LC4_S2S_HISTORY_PROVIDER_VISIBLE_SHA256,
  LC4_S2S_HISTORY_SOURCE_BINDING_SHA256,
  LC4_S2S_PACKETIZER_SHA256,
  LC4_S2S_SOURCE_TEXT,
  LC4_S2S_TOOL,
  LC4_S2S_TOOL_SCHEMA_SHA256,
  assertLc4S2sRoundtripExecution,
  loadLc4S2sPcm,
  type Lc4S2sAudioRenderer,
  type Lc4S2sHistoryHydrationEvidence,
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
import {
  assertLc4DevQualificationAdmissionReceipt,
  assertLc4DevRetainedQualificationV4Receipt,
  loadLc4DevRetainedQualificationV4,
  type Lc4DevRetainedQualificationV4Receipt,
} from "../lc4-development-qualification-v3";
import { assertLc4DevPreflightQualificationAdmission } from "../lc4-development-live-runner";
import {
  createSignedLc4QualificationV4Package,
  verifySignedLc4QualificationV4Package,
  verifySignedLc4QualificationV4PackageCustody,
} from "../lc4-qualification-v4-package";
import {
  LC4_QUALIFICATION_V4_PROVIDER_ORDER,
  LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
  runLc4QualificationV4ProviderShards,
  type Lc4QualificationV4Binding,
  type Lc4QualificationV4Manifest,
  type Lc4QualificationV4Aggregate,
  type Lc4QualificationV4ReplayShard,
  type Lc4QualificationV4Reservation,
  type Lc4QualificationV4PhaseTerminal,
  type Lc4QualificationV4ShardTerminal,
} from "../lc4-qualification-v4-shards";
import {
  finalizeLc4QualificationBudget,
  lc4QualificationBudgetBindingSha256,
  reserveOrResumeLc4QualificationBudget,
  type Lc4QualificationBudgetBinding,
} from "../lc4-qualification-budget";
import { qualifyProviderTargetShard } from "../provider-qualification";
import {
  LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE,
  LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
} from "../lc4-development-qualification-v3";

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

function passedExecution(
  input: Parameters<NonNullable<Parameters<typeof runLc4QualificationV3>[0]["dependencies"]>["executeRoundtrip"]>[0],
  deliveryProfileSha256 = "3".repeat(64),
): Lc4S2sRoundtripExecution {
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
  const historyWire = input.provider === "gemini" ? (() => {
    const outbound = observe("outbound", "clientContent", Object.freeze({}), {
      initialHistory: {
        protocol: "initial_history_in_client_content",
        entryCount: 3,
        providerContentTurnCount: 4,
        functionCallCount: 1,
        functionResponseCount: 1,
        turnComplete: true,
        generationTriggered: false,
        providerAcknowledgement: "not_defined_by_protocol",
        providerVisibleHistorySha256: LC4_S2S_HISTORY_PROVIDER_VISIBLE_SHA256,
        geminiContentSha256: sha256Hex("qualification-test-gemini-history"),
      },
    });
    return { outbound: [outbound, outbound, outbound, outbound], inbound: [] };
  })() : (() => {
    const projections = [
      {
        kind: "user_message",
        contentSha256: sha256Hex(LC4_S2S_HISTORY_PROBE[0].text),
        contentBytes: Buffer.byteLength(LC4_S2S_HISTORY_PROBE[0].text, "utf8"),
      },
      {
        kind: "synthetic_tool_call",
        nameSha256: sha256Hex(LC4_S2S_HISTORY_PROBE[1].calls[0].toolName),
        nameBytes: Buffer.byteLength(LC4_S2S_HISTORY_PROBE[1].calls[0].toolName, "utf8"),
        namePresent: true,
        argumentsSha256: sha256Hex(canonicalJson(
          LC4_S2S_HISTORY_PROBE[1].calls[0].toolArguments,
        )),
        argumentsBytes: Buffer.byteLength(canonicalJson(
          LC4_S2S_HISTORY_PROBE[1].calls[0].toolArguments,
        ), "utf8"),
        argumentsPresent: true,
        argumentsJsonValid: true,
      },
      {
        kind: "synthetic_tool_output",
        outputSha256: sha256Hex(LC4_S2S_HISTORY_PROBE[1].calls[0].output),
        outputBytes: Buffer.byteLength(LC4_S2S_HISTORY_PROBE[1].calls[0].output, "utf8"),
        outputPresent: true,
      },
      {
        kind: "assistant_message",
        contentSha256: sha256Hex(LC4_S2S_HISTORY_PROBE[2].text),
        contentBytes: Buffer.byteLength(LC4_S2S_HISTORY_PROBE[2].text, "utf8"),
      },
    ] as const;
    const outbound: RealtimeWireObservation[] = [];
    const inbound: RealtimeWireObservation[] = [];
    for (const [index, projection] of projections.entries()) {
      const itemIdentities = Object.freeze({
        itemIdSha256: sha256Hex(`qualification-test-history-item-${index + 1}`),
        ...(index === 1 || index === 2 ? { callIdSha256 } : {}),
      });
      outbound.push(observe("outbound", "conversation.item.create", itemIdentities, {
        conversationHistoryItem: projection,
      }));
      const inboundProjection = input.provider === "xai" && index === 1
        ? {
            ...projection,
            argumentsSha256: sha256Hex(""),
            argumentsBytes: 0,
            argumentsPresent: true,
            argumentsJsonValid: false,
          }
        : projection;
      inbound.push(observe(
        "inbound",
        input.provider === "xai" ? "conversation.item.added" : "conversation.item.created",
        itemIdentities,
        { conversationHistoryItem: inboundProjection },
      ));
    }
    return { outbound, inbound };
  })();
  const xaiTarget = createLc4QualificationV3Targets().find((target) => target.provider === "xai")!;
  const xaiTransportParitySha256 = xaiServerVadTransportParitySha256(
    withXaiServerVadPcmSession(productionOpenAiCompatibleSessionUpdate(
      "xai",
      xaiTarget.configuration,
      "provider_native_server_vad",
    )),
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
    if (input.provider === "gemini") observe("outbound", "realtimeInput.activityStart");
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
    delivery_profile_sha256: deliveryProfileSha256,
    packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
    audio_bytes: input.audioObject.byte_length,
    chunk_count: 1,
    frame_bytes: input.audioObject.byte_length,
    tail_bytes: input.audioObject.byte_length,
    sample_rate_hz: input.audioObject.sample_rate_hz,
    ...(input.provider !== "xai" ? {} : {
      transport_suffix: {
        purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
        completion: "provider_native_speech_stop" as const,
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
  const firstLiveInput = wire.find((observation) => (
    observation.direction === "outbound"
      && (observation.wireType === "input_audio_buffer.append"
        || observation.wireType === "realtimeInput.activityStart")
  )) ?? wire[0]!;
  const historyEvidenceBody = Object.freeze({
    schema_version: 2 as const,
    probe_sha256: LC4_S2S_HISTORY_PROBE_SHA256,
    provider: input.provider,
    status: input.provider === "gemini"
      ? "sent_unacknowledged_by_provider_protocol" as const
      : input.provider === "xai"
        ? "identity_acknowledged_content_unverifiable" as const
      : "acknowledged" as const,
    connection_epoch: 1,
    turn_count: 3 as const,
    provider_item_count: 4 as const,
    provider_visible_history_sha256: LC4_S2S_HISTORY_PROVIDER_VISIBLE_SHA256,
    source_binding_sha256: LC4_S2S_HISTORY_SOURCE_BINDING_SHA256,
    item_kinds: Object.freeze([
      "user_message",
      "synthetic_tool_call",
      "synthetic_tool_output",
      "assistant_message",
    ] as const),
    item_acknowledgement_scopes: Object.freeze(
      Array.from(
        { length: 4 },
        (_, index) => input.provider === "gemini"
          ? "unacknowledged_by_provider_protocol" as const
          : input.provider === "xai" && index === 1
            ? "identity_only_content_omitted" as const
          : "exact_content" as const,
      ),
    ) as Lc4S2sHistoryHydrationEvidence["item_acknowledgement_scopes"],
    outbound_observation_sha256s: Object.freeze(
      historyWire.outbound.map((observation) => observation.observationSha256),
    ),
    inbound_observation_sha256s: Object.freeze(
      historyWire.inbound.map((observation) => observation.observationSha256),
    ),
    last_history_observation_sequence: Math.max(
      ...historyWire.outbound.map((observation) => observation.sequence),
      ...historyWire.inbound.map((observation) => observation.sequence),
    ),
    first_live_input_observation_sha256: firstLiveInput.observationSha256,
    first_live_input_sequence: firstLiveInput.sequence,
    pre_input_generation_trigger_count: 0 as const,
    pre_input_output_audio_bytes: 0 as const,
    pre_input_output_transcript_count: 0 as const,
    pre_input_tool_call_count: 0 as const,
    receipt_sha256: "7".repeat(64),
  });
  const historyHydrationEvidence = Object.freeze({
    ...historyEvidenceBody,
    evidence_sha256: sha256Hex(
      `harshas-amazing-call-center/lc4-s2s-history-hydration-evidence/v2\n${canonicalJson(historyEvidenceBody)}`,
    ),
  });
  const body = Object.freeze({
    schema_version: 4 as const,
    roundtrip_version: "HACC-LC4-S2S-TOOL-ROUNDTRIP-v7" as const,
    provider: input.provider,
    model: input.model,
    attempted_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
    status: "passed" as const,
    failure_class: "none" as const,
    audio: input.audioObject,
    delivery: Object.freeze({
      packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
      delivery_profile_sha256: deliveryProfileSha256,
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
    turn_boundary_mode: input.provider === "xai"
      ? "provider_native_server_vad" as const
      : input.provider === "gemini"
        ? "provider_activity_markers" as const
        : "manual_commit" as const,
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
    history_hydration_evidence: historyHydrationEvidence,
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
    evidence_sha256: sha256Hex(`harshas-amazing-call-center/lc4-s2s-roundtrip-evidence/v7\n${canonicalJson(body)}`),
  });
  assertLc4S2sRoundtripExecution(execution);
  return execution;
}

const V4_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-retained-qualification-v4/v1\n";

function sessionConfigurationSha256(provider: LiveStsProvider, model: string, configuration: unknown): string {
  return sha256Hex(`harshas-amazing-call-center/provider-session-configuration/v1\n${canonicalJson({
    provider,
    model,
    configuration,
  })}`);
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function signedV4FilesystemFixture(options: Readonly<{
  failPaidProvider?: LiveStsProvider;
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-v4-projection-"));
  const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-v4-repository-"));
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
    planId: "qualification-v4-projection-plan",
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
    "qualification-v4-projection-attempt",
  );
  const setupTargets = createLc4QualificationV3Targets();
  const paidTargets = createLc4QualificationV3PaidTargets();
  const binding: Lc4QualificationV4Binding = Object.freeze({
    attempt_id: authorization.body.authorization_id,
    authorization_artifact_sha256: authorization.artifact_sha256,
    authorization_maximum_total_micro_usd: authorization.body.maximum_total_micro_usd,
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    source_commit: plan.body.source.source_commit,
    source_tree_sha256: plan.body.source.source_tree_sha256,
    credential_set_sha256: plan.body.credential_set_sha256,
    provider_profile_manifest_sha256: plan.body.provider_profile_manifest_sha256,
    setup_configuration_matrix_sha256: plan.body.setup_configuration_matrix_sha256,
    paid_configuration_matrix_sha256: plan.body.paid_configuration_matrix_sha256,
    providers: Object.freeze(plan.body.targets.map((planned) => {
      const setup = setupTargets.find((target) => target.provider === planned.provider)!;
      const paid = paidTargets.find((target) => target.provider === planned.provider)!;
      return Object.freeze({
        provider: planned.provider,
        model: planned.model,
        setup_configuration_sha256: sessionConfigurationSha256(planned.provider, setup.model, setup.configuration),
        paid_configuration_sha256: sessionConfigurationSha256(planned.provider, paid.model, paid.configuration),
        credential_sha256: credentialIdentity(planned.provider, CREDENTIALS[planned.provider]).credential_sha256,
        caller_audio_sha256: planned.caller_audio_sha256,
        caller_audio_bytes: planned.caller_audio_bytes,
        audio_delivery_profile_sha256: planned.audio_delivery_profile_sha256,
      });
    })),
  });
  expect(credentialSetSha256(CREDENTIALS)).toBe(plan.body.credential_set_sha256);
  const budgetBinding: Lc4QualificationBudgetBinding = Object.freeze({
    attemptId: authorization.body.authorization_id,
    authorizationId: authorization.body.authorization_id,
    authorizationArtifactSha256: authorization.artifact_sha256,
    planSha256: plan.body.plan_sha256,
    sourceCommit: plan.body.source.source_commit,
    sourceTreeSha256: plan.body.source.source_tree_sha256,
    credentialSetSha256: plan.body.credential_set_sha256,
    providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
    configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
    devConfigurationMatrixSha256: plan.body.paid_configuration_matrix_sha256,
    providersModels: Object.freeze(Object.fromEntries(plan.body.targets.map((target) => [target.provider, target.model])) as Record<LiveStsProvider, string>),
    expiresAt: authorization.body.expires_at,
  });
  expect(lc4QualificationBudgetBindingSha256(budgetBinding)).toMatch(/^[a-f0-9]{64}$/u);
  const reservation = await reserveOrResumeLc4QualificationBudget({ root, binding: budgetBinding, now: () => NOW });
  const executions = new Map<LiveStsProvider, Lc4S2sRoundtripExecution>();
  const aggregate = await runLc4QualificationV4ProviderShards({
    root,
    repository_root: repositoryRoot,
    binding,
    invoked_at: NOW.toISOString(),
    dependencies: {
      async runSetup(context) {
        const target = setupTargets.find((candidate) => candidate.provider === context.provider)!;
        const shardRoot = resolve(root, "qualification-v4-shards", `${LC4_QUALIFICATION_V4_PROVIDER_ORDER.indexOf(context.provider)}-${context.provider}`);
        const producedArtifact = await qualifyProviderTargetShard({
          root: shardRoot,
          protocolId: plan.body.protocol_id,
          planSha256: plan.body.plan_sha256,
          sourceCommit: plan.body.source.source_commit,
          target,
          matrixTargets: setupTargets,
          credentials: CREDENTIALS,
          signedCredentialSetSha256: plan.body.credential_set_sha256,
          qualificationId: `qv4-${context.provider}`,
          createClient: () => new SetupClient(context.provider),
          now: () => NOW,
        });
        const artifact = producedArtifact;
        const result = artifact.results[0]!;
        const wire = result.setupWireEvidence!.observations;
        if (context.provider === "xai") {
          const planned = plan.body.targets.find((candidate) => candidate.provider === "xai")!;
          const risk = createXaiServerVadGateARiskArtifact({
            setup: result,
            sourceCommit: plan.body.source.source_commit,
            planSha256: plan.body.plan_sha256,
            configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
            providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
            productionSessionPayloadSha256: planned.production_session_payload_sha256!,
          });
          await writeFile(resolve(shardRoot, "xai-server-vad-gate-a-risk.json"), `${canonicalJson(risk)}\n`, { flag: "wx", mode: 0o400 });
        }
        return Object.freeze({
          status: "passed" as const,
          failure_class: "none",
          evidence_sha256: artifact.artifactSha256,
          wire_head_sha256: wire.at(-1)!.observationSha256,
          wire_observation_count: wire.length,
          reconnect_count: 0,
          usage_event_count: 0,
          usage_evidence_sha256: sha256Hex(canonicalJson([])),
          provider_sessions_opened: 1 as const,
          paid_sessions_opened: 0 as const,
          generation_phases_attempted: 0 as const,
          tool_roundtrips_attempted: 0 as const,
        });
      },
      async runPaid(context) {
        const target = paidTargets.find((candidate) => candidate.provider === context.provider)!;
        const audio = await loadLc4S2sPcm({ root, artifact: plan.body.audio_fixture, provider: context.provider });
        const execution = passedExecution({
          provider: context.provider,
          model: target.model,
          audio,
          audioObject: plan.body.audio_fixture.provider_renditions[context.provider],
        } as Parameters<typeof passedExecution>[0], plan.body.targets.find(
          (candidate) => candidate.provider === context.provider,
        )!.audio_delivery_profile_sha256);
        executions.set(context.provider, execution);
        const shardRoot = resolve(root, "qualification-v4-shards", `${LC4_QUALIFICATION_V4_PROVIDER_ORDER.indexOf(context.provider)}-${context.provider}`);
        await retainRoundtrip(shardRoot, execution);
        if (context.provider === "xai") {
          const risk = await json<ReturnType<typeof createXaiServerVadGateARiskArtifact>>(resolve(shardRoot, "xai-server-vad-gate-a-risk.json"));
          const gateB = createXaiServerVadGateBBindingArtifact({
            risk,
            execution,
            sourceCommit: plan.body.source.source_commit,
            planSha256: plan.body.plan_sha256,
            providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
            expectedTransportParitySha256: plan.body.targets.find((candidate) => candidate.provider === "xai")!.xai_transport_parity_sha256!,
          });
          await writeFile(resolve(shardRoot, "xai-server-vad-gate-b-binding.json"), `${canonicalJson(gateB)}\n`, { flag: "wx", mode: 0o400 });
        }
        const failed = options.failPaidProvider === context.provider;
        return Object.freeze({
          status: failed ? "failed" as const : "passed" as const,
          failure_class: failed ? `${context.provider}_paid_failed` : "none",
          evidence_sha256: execution.evidence_sha256,
          wire_head_sha256: execution.wire_observations.at(-1)!.observationSha256,
          wire_observation_count: execution.wire_observations.length,
          reconnect_count: 0,
          usage_event_count: execution.sanitized_usage.length,
          usage_evidence_sha256: sha256Hex(canonicalJson(execution.sanitized_usage)),
          provider_sessions_opened: 1 as const,
          paid_sessions_opened: 1 as const,
          generation_phases_attempted: 2 as const,
          tool_roundtrips_attempted: 1 as const,
        });
      },
    },
  });
  const budget = await finalizeLc4QualificationBudget({
    reservation,
    attemptId: authorization.body.authorization_id,
    usageEventCount: aggregate.usage_event_count,
    usageEvidenceSha256: aggregate.usage_evidence_sha256,
    outcome: aggregate.status === "passed" ? "completed" : "failed",
    now: () => NOW,
  });
  const manifest = await json<Lc4QualificationV4Manifest>(resolve(root, "qualification-v4-shard-manifest.json"));
  const retainedAggregate = await json<Lc4QualificationV4Aggregate>(resolve(root, "qualification-v4-aggregate.json"));
  const shards: Lc4QualificationV4ReplayShard[] = [];
  const evidenceFiles: Lc4QualificationPackageFile[] = [{
    path: "v4-invocation.json",
    bytes: await readFile(resolve(root, "qualification-v4-invocation.json")),
  }];
  for (const [index, provider] of LC4_QUALIFICATION_V4_PROVIDER_ORDER.entries()) {
    const prefix = `${String(index).padStart(2, "0")}-${provider}`;
    const shardRoot = resolve(root, "qualification-v4-shards", `${index}-${provider}`);
    const shardTerminal = await json<Lc4QualificationV4ShardTerminal>(resolve(shardRoot, "shard-terminal.json"));
    shards.push(Object.freeze({
      reservation: await json<Lc4QualificationV4Reservation>(resolve(shardRoot, "reservation.json")),
      setup_admission: shardTerminal.setup_terminal_sha256 === null
        ? null
        : await json<never>(resolve(shardRoot, "setup-admission.json")),
      setup_terminal: shardTerminal.setup_terminal_sha256 === null
        ? null
        : await json<Lc4QualificationV4PhaseTerminal>(resolve(shardRoot, "setup-terminal.json")),
      paid_admission: shardTerminal.paid_terminal_sha256 === null
        ? null
        : await json<never>(resolve(shardRoot, "paid-admission.json")),
      paid_terminal: shardTerminal.paid_terminal_sha256 === null
        ? null
        : await json<Lc4QualificationV4PhaseTerminal>(resolve(shardRoot, "paid-terminal.json")),
      shard_terminal: shardTerminal,
    }));
    for (const [source, target] of [
      [`qualifications/${provider}-qv4-${provider}.json`, `${prefix}-setup-qualification.json`],
      [`${provider}-spoken-roundtrip.json`, `${prefix}-spoken-roundtrip.json`],
      [`${provider}-spoken-roundtrip-wire.jsonl`, `${prefix}-spoken-roundtrip-wire.jsonl`],
      [`${provider}-spoken-roundtrip-usage.jsonl`, `${prefix}-spoken-roundtrip-usage.jsonl`],
    ] as const) {
      const path = resolve(shardRoot, source);
      if (await lstat(path).then(() => true, () => false)) {
        evidenceFiles.push({ path: target, bytes: await readFile(path) });
      }
    }
    if (provider === "xai") {
      for (const name of ["xai-server-vad-gate-a-risk.json", "xai-server-vad-gate-b-binding.json"] as const) {
        const path = resolve(shardRoot, name);
        if (await lstat(path).then(() => true, () => false)) {
          evidenceFiles.push({ path: name, bytes: await readFile(path) });
        }
      }
    }
  }
  const signedPackage = createSignedLc4QualificationV4Package({
    binding,
    manifest,
    aggregate: retainedAggregate,
    shards,
    plan,
    authorization,
    budget,
    budgetBinding,
    terminalPrivateKeyPem: terminalKey.privatePem,
    sealedAt: NOW.toISOString(),
    evidenceFiles,
  });
  const attempts = resolve(root, "attempts");
  await mkdir(attempts, { recursive: true, mode: 0o700 });
  const retained = resolve(attempts, aggregate.status === "passed"
    ? `${authorization.body.authorization_id}.v4-package.complete`
    : `${authorization.body.authorization_id}.v4-package.sealed-failure`);
  await mkdir(retained, { mode: 0o700 });
  for (const file of signedPackage.files) {
    await writeFile(resolve(retained, file.path), file.bytes, { flag: "wx", mode: 0o400 });
  }
  await writeFile(resolve(retained, "qualification-package-envelope.json"), `${canonicalJson(signedPackage.envelope)}\n`, { flag: "wx", mode: 0o400 });
  return Object.freeze({
    root,
    complete: retained,
    trustRoot: authority.fingerprint,
    plan,
    authorization,
    executions,
    aggregate,
    binding,
    budgetBinding,
    signedPackage,
  });
}

function rehashForgedReceipt(receipt: Lc4DevRetainedQualificationV4Receipt, mutation: Record<string, unknown>) {
  const body = { ...structuredClone(receipt), ...mutation } as Record<string, unknown>;
  delete body.receipt_sha256;
  return {
    ...body,
    receipt_sha256: sha256Hex(`${V4_RECEIPT_DOMAIN}${canonicalJson(body)}`),
  } as unknown as Lc4DevRetainedQualificationV4Receipt;
}

describe("LC4 qualification v4 to DEV admission projection", () => {
  it("seals a passed/failed/cancelled qualification as custody evidence without completion eligibility", async () => {
    const fixture = await signedV4FilesystemFixture({ failPaidProvider: "gemini" });
    expect(fixture.aggregate).toMatchObject({
      status: "failed",
      primary_failure_class: "gemini_paid_failed",
    });
    expect(fixture.complete).toContain(".v4-package.sealed-failure");
    expect(fixture.signedPackage.terminal.body.status).toBe("failed");
    const paths = fixture.signedPackage.files.map((file) => file.path);
    expect(paths).toContain("02-xai-shard-terminal.json");
    expect(paths).not.toContain("02-xai-setup-admission.json");
    expect(paths).not.toContain("02-xai-setup-terminal.json");
    expect(paths).not.toContain("02-xai-paid-admission.json");
    expect(paths).not.toContain("02-xai-paid-terminal.json");

    const custody = await verifySignedLc4QualificationV4PackageCustody({
      envelope: fixture.signedPackage.envelope,
      files: fixture.signedPackage.files,
      expectedTrustRootFingerprintSha256: fixture.trustRoot,
      expectedBinding: fixture.binding,
      budgetBinding: fixture.budgetBinding,
    });
    expect(custody).toMatchObject({
      publication_eligible: false,
      aggregate: { status: "failed" },
      terminal: { body: { status: "failed" } },
    });
    await expect(verifySignedLc4QualificationV4Package({
      envelope: fixture.signedPackage.envelope,
      files: fixture.signedPackage.files,
      expectedTrustRootFingerprintSha256: fixture.trustRoot,
      expectedBinding: fixture.binding,
      budgetBinding: fixture.budgetBinding,
    })).rejects.toThrow(/not completed or publication eligible/);
    await expect(loadLc4DevRetainedQualificationV4({
      root: fixture.root,
      qualification_trust_root_sha256: fixture.trustRoot,
      now: NOW,
    })).rejects.toThrow(/exactly one signed package/);

    const tamperedFiles = fixture.signedPackage.files.map((file) => (
      file.path === "01-gemini-paid-terminal.json"
        ? { ...file, bytes: Buffer.from(Buffer.from(file.bytes).toString("utf8").replace("gemini_paid_failed", "forged_paid_failure")) }
        : file
    ));
    await expect(verifySignedLc4QualificationV4PackageCustody({
      envelope: fixture.signedPackage.envelope,
      files: tamperedFiles,
      expectedTrustRootFingerprintSha256: fixture.trustRoot,
      expectedBinding: fixture.binding,
      budgetBinding: fixture.budgetBinding,
    })).rejects.toThrow();
  });

  it("loads one fully signed replay-valid filesystem package into the common DEV admission contract", async () => {
    const fixture = await signedV4FilesystemFixture();
    const receipt = await loadLc4DevRetainedQualificationV4({
      root: fixture.root,
      qualification_trust_root_sha256: fixture.trustRoot,
      now: NOW,
    });
    expect(receipt).toMatchObject({
      schema_version: 4,
      status: "passed",
      qualification_runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
      providers: ["openai", "gemini", "xai"],
      source_commit: SOURCE.source_commit,
      transport_qualification_scope: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE,
      transport_qualification_scope_sha256: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    });
    expect(() => assertLc4DevRetainedQualificationV4Receipt(receipt)).not.toThrow();
    expect(() => assertLc4DevQualificationAdmissionReceipt(receipt)).not.toThrow();
    expect(() => assertLc4DevPreflightQualificationAdmission(receipt, NOW)).not.toThrow();
    expect(() => assertLc4DevPreflightQualificationAdmission(
      receipt,
      new Date("2027-07-22T20:00:00.000Z"),
    )).toThrow(/stale or future-dated/u);
  });

  it("rejects a signed package after retained paid evidence is mutated", async () => {
    const fixture = await signedV4FilesystemFixture();
    const path = resolve(fixture.complete, "00-openai-spoken-roundtrip.json");
    await chmod(path, 0o600);
    const value = await json<Record<string, unknown>>(path);
    await writeFile(path, `${canonicalJson({ ...value, model: "forged-model" })}\n`, { mode: 0o400 });
    await expect(loadLc4DevRetainedQualificationV4({
      root: fixture.root,
      qualification_trust_root_sha256: fixture.trustRoot,
      now: NOW,
    })).rejects.toThrow();
  });

  it.each([
    ["invocation", "v4-invocation.json", (value: Record<string, unknown>) => ({ ...value, invoked_at: "2026-07-22T19:59:59.000Z" })],
    ["budget", "budget-settlement.json", (value: Record<string, unknown>) => ({ ...value, conservative_settled_micro_usd: 1 })],
    ["envelope signature", "qualification-package-envelope.json", (value: Record<string, unknown>) => ({ ...value, signature_base64: Buffer.alloc(64, 9).toString("base64") })],
  ] as const)("rejects retained %s tamper", async (_label, name, mutate) => {
    const fixture = await signedV4FilesystemFixture();
    const path = resolve(fixture.complete, name);
    await chmod(path, 0o600);
    await writeFile(path, `${canonicalJson(mutate(await json<Record<string, unknown>>(path)))}\n`, { mode: 0o400 });
    await expect(loadLc4DevRetainedQualificationV4({
      root: fixture.root,
      qualification_trust_root_sha256: fixture.trustRoot,
      now: NOW,
    })).rejects.toThrow();
  });

  it("rejects fully outer-rehashed source, credential, profile, config, audio, expiry, Gate A/B, and signature forgeries", async () => {
    const fixture = await signedV4FilesystemFixture();
    const receipt = await loadLc4DevRetainedQualificationV4({
      root: fixture.root,
      qualification_trust_root_sha256: fixture.trustRoot,
      now: NOW,
    });
    const xai = receipt.spoken_gate_evidence[2]!;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["source", { source_commit: "f".repeat(40) }],
      ["credential", { credential_set_sha256: sha256Hex("forged-credential") }],
      ["profile", { provider_profile_manifest_sha256: sha256Hex("forged-profile") }],
      ["configuration", { setup_configuration_matrix_sha256: sha256Hex("forged-config") }],
      ["audio", { spoken_gate_evidence: [...receipt.spoken_gate_evidence.slice(0, 2), { ...xai, caller_audio_sha256: sha256Hex("forged-audio") }] }],
      ["expiry", { authorization: { ...receipt.authorization, body: { ...receipt.authorization.body, expires_at: "2026-07-22T20:01:00.000Z" } } }],
      ["gate-a", { xai_server_vad_gate_a_risk: { ...receipt.xai_server_vad_gate_a_risk, risk_sha256: sha256Hex("forged-gate-a") } }],
      ["gate-b", { xai_server_vad_gate_b_binding: { ...receipt.xai_server_vad_gate_b_binding, binding_sha256: sha256Hex("forged-gate-b") } }],
      ["signature", { terminal: { ...receipt.terminal, signature_base64: Buffer.alloc(64, 7).toString("base64") } }],
    ];
    for (const [label, mutation] of cases) {
      expect(
        () => assertLc4DevQualificationAdmissionReceipt(rehashForgedReceipt(receipt, mutation)),
        label,
      ).toThrow();
    }
  });

  it("rejects a v4 receipt with its discriminator removed even after receipt rehash", async () => {
    const fixture = await signedV4FilesystemFixture();
    const receipt = await loadLc4DevRetainedQualificationV4({
      root: fixture.root,
      qualification_trust_root_sha256: fixture.trustRoot,
      now: NOW,
    });
    const forged = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete forged.setup_qualifications;
    delete forged.receipt_sha256;
    forged.receipt_sha256 = sha256Hex(
      `${V4_RECEIPT_DOMAIN}${canonicalJson(forged)}`,
    );
    expect(() => assertLc4DevQualificationAdmissionReceipt(
      forged as unknown as Lc4DevRetainedQualificationV4Receipt,
    )).toThrow("admission discriminator mismatch");
  });
});
