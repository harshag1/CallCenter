import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  Pcm16Audio,
  RealtimeConversationHistoryHydrationAcknowledgement,
  RealtimeConversationHistoryTurn,
  NormalizedRealtimeEvent,
  RealtimeToolResult,
  RealtimeEventListener,
  RealtimeWireObservation,
  RealtimeWireObservationListener,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import {
  GEMINI_CAPABILITY_GATEWAY_NAME,
  projectGeminiInitialHistoryClientContent,
} from "../../realtime/client/gemini-live";
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
} from "../lc4-development-qualification-v3";
import { assertLc4DevPreflightQualificationAdmission } from "../lc4-development-live-runner";
import {
  createSignedLc4QualificationV4Package,
} from "../lc4-qualification-v4-package";
import {
  LC4_QUALIFICATION_V4_PROVIDER_ORDER,
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
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  independentAsrContractSha256,
  prepareIndependentAsrCalibration,
  runIndependentAsrAdapter,
  type AsrCalibrationSourceFixture,
  type AudiblePcmChunk,
  type IndependentAsrCalibrationPlan,
  type IndependentAsrContract,
  type IndependentAsrRequest,
} from "../audible-evidence";
import {
  LC4_DEV_PINNED_VOICE,
  createLc4DevCallerAudioLoader,
  materializeLc4DevelopmentAudio,
  type Lc4DevAudioRenderer,
} from "../lc4-development-audio-materializer";
import {
  createLc4DevCallerBranchAuthority,
  createLc4DevCallerBranchMatrixArtifact,
} from "../lc4-development-caller-branch";
import { createLc4DevMunicipalControlPlane } from "../lc4-development-control-plane";
import {
  createLc4DevelopmentLiveDependencies,
  createLc4ImmutableCas,
  createLc4PinnedListenerManifestSha256,
} from "../lc4-development-live-dependencies";
import { createLc4HeadlessListenerPlaybackAuthority } from "../lc4-development-headless-listener-authority";
import {
  createLc4DevelopmentPinnedListenerEvaluator,
  LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
  LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
  lc4DevelopmentListenerCriterionBindings,
} from "../lc4-development-listener-semantics";
import { createLc4DevRepairPlaybackController } from "../lc4-development-repair-playback";
import {
  createLc4DevLivePreflightArtifact,
  createLc4DevLivePrepareArtifact,
  createLc4DevAsrRunnerTrust,
  executeLc4DevLiveRun,
} from "../lc4-development-live-runner";
import { createLc4DevOperatorAuthorizationDag, type Lc4DevOperatorSigner } from "../lc4-development-operator-cli";
import { Lc4DevBudgetLifecycle, reserveLc4DevRunBudget } from "../lc4-development-budget";
import { createBenchmarkKernelAttestationSigner } from "../kernel-attestation";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import { LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE } from "../lc4-provider-profiles";
import {
  createLc4DevelopmentRealtimeAdapter,
  lc4DevCredentialIdentitySetSha256,
} from "../lc4-production-provider-adapter";
import { replayLc4PublicationTransportEvidence } from "../lc4-publication-transport-replay";
import {
  LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
  LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
  createLc4XaiFiniteManualGateDAuthorization,
  createLc4XaiFiniteManualGateDPlan,
  createLc4XaiFiniteManualGateDSigner,
  executeLc4XaiFiniteManualGateD,
  lc4XaiFiniteManualGateDExecutionReplaySha256,
  type Lc4XaiFiniteManualGateDExecutionEvidence,
  type Lc4XaiFiniteManualGateDProductionAdapter,
  type Lc4XaiFiniteManualGateDReceipt,
} from "../lc4-xai.manual-qualification";
import {
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "../lc4-production-provider-contract";
import { lc4XaiManualResponseWireIdentitySha256, type Lc4SanitizedWireObservation } from "../lc4-xai-manual-turn-causality";

const productionClient = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../production-realtime-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../production-realtime-provider")>()),
  createProductionRealtimeClient: productionClient.create,
}));

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

async function signedV4FilesystemFixture() {
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
        return Object.freeze({
          status: "passed" as const,
          failure_class: "none",
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
    outcome: "completed",
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
    shards.push(Object.freeze({
      reservation: await json<Lc4QualificationV4Reservation>(resolve(shardRoot, "reservation.json")),
      setup_admission: await json<never>(resolve(shardRoot, "setup-admission.json")),
      setup_terminal: await json<Lc4QualificationV4PhaseTerminal>(resolve(shardRoot, "setup-terminal.json")),
      paid_admission: await json<never>(resolve(shardRoot, "paid-admission.json")),
      paid_terminal: await json<Lc4QualificationV4PhaseTerminal>(resolve(shardRoot, "paid-terminal.json")),
      shard_terminal: await json<Lc4QualificationV4ShardTerminal>(resolve(shardRoot, "shard-terminal.json")),
    }));
    for (const [source, target] of [
      [`qualifications/${provider}-qv4-${provider}.json`, `${prefix}-setup-qualification.json`],
      [`${provider}-spoken-roundtrip.json`, `${prefix}-spoken-roundtrip.json`],
      [`${provider}-spoken-roundtrip-wire.jsonl`, `${prefix}-spoken-roundtrip-wire.jsonl`],
      [`${provider}-spoken-roundtrip-usage.jsonl`, `${prefix}-spoken-roundtrip-usage.jsonl`],
    ] as const) evidenceFiles.push({ path: target, bytes: await readFile(resolve(shardRoot, source)) });
    if (provider === "xai") {
      for (const name of ["xai-server-vad-gate-a-risk.json", "xai-server-vad-gate-b-binding.json"] as const) {
        evidenceFiles.push({ path: name, bytes: await readFile(resolve(shardRoot, name)) });
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
  const complete = resolve(attempts, `${authorization.body.authorization_id}.v4-package.complete`);
  await mkdir(complete, { mode: 0o700 });
  for (const file of signedPackage.files) {
    await writeFile(resolve(complete, file.path), file.bytes, { flag: "wx", mode: 0o400 });
  }
  await writeFile(resolve(complete, "qualification-package-envelope.json"), `${canonicalJson(signedPackage.envelope)}\n`, { flag: "wx", mode: 0o400 });
  return Object.freeze({ root, complete, trustRoot: authority.fingerprint, plan, authorization, executions, authority });
}

type PendingDevCall = Readonly<{
  semantic_intent: string;
  target_tool: string;
  target_arguments: Readonly<Record<string, unknown>>;
}>;

/** Provider-free wire implementation used only at the production-client seam. */
class PublicationRuntimeClient implements NormalizedRealtimeClient {
  readonly provider: LiveStsProvider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly #events = new Set<RealtimeEventListener>();
  readonly #wire = new Set<RealtimeWireObservationListener>();
  readonly #pending: (phase: "canonical" | "repair") => readonly PendingDevCall[];
  readonly #transcript: () => string;
  readonly #onPcm: (pcm: Uint8Array, transcript: string) => void;
  readonly #onProviderCallId: (callId: string) => void;
  readonly #sessionIdentity: string;
  #sequence = 0;
  #previous: string | null = null;
  #response = 0;
  #commit = 0;
  #geminiInputOpen = false;
  #preparedPhase: "canonical" | "repair" = "canonical";

  constructor(input: Readonly<{
    provider: LiveStsProvider;
    pending: (phase: "canonical" | "repair") => readonly PendingDevCall[];
    transcript: () => string;
    onPcm: (pcm: Uint8Array, transcript: string) => void;
    onProviderCallId: (callId: string) => void;
    sessionIdentity: string;
  }>) {
    this.provider = input.provider;
    this.#pending = input.pending;
    this.#transcript = input.transcript;
    this.#onPcm = input.onPcm;
    this.#onProviderCallId = input.onProviderCallId;
    if (!/^\d{2}$/u.test(input.sessionIdentity)) {
      throw new Error("publication runtime session identity is invalid");
    }
    this.#sessionIdentity = input.sessionIdentity;
  }

  async connect() {
    this.state = "ready";
    this.#observe(
      this.provider === "gemini" ? "setupComplete" : "session.created",
      Object.freeze({ sessionReady: true }),
      "inbound",
      this.provider === "gemini"
        ? Object.freeze({})
        : Object.freeze({
            sessionIdSha256: sha256Hex(
              `publication-${this.provider}-session-${this.#sessionIdentity}`,
            ),
          }),
    );
  }
  close() { this.state = "closed"; }
  onEvent(listener: RealtimeEventListener) { this.#events.add(listener); return () => this.#events.delete(listener); }
  onWireEvent() { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener) { this.#wire.add(listener); return () => this.#wire.delete(listener); }

  #observe(
    wireType: string,
    projection: Readonly<Record<string, unknown>>,
    direction: "inbound" | "outbound" = "outbound",
    identities: RealtimeWireObservation["identities"] = Object.freeze({}),
    payloadOverride?: Readonly<{ payloadSha256: string; payloadBytes: number }>,
  ): RealtimeWireObservation {
    const sequence = ++this.#sequence;
    const core = Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      direction,
      connectionEpoch: 1,
      sequence,
      observedAtMs: sequence,
      observedAtMonotonicMs: sequence,
      wireType,
      payloadSha256: payloadOverride?.payloadSha256
        ?? sha256Hex(canonicalJson({ wireType, direction, sequence, projection })),
      payloadBytes: payloadOverride?.payloadBytes
        ?? Buffer.byteLength(canonicalJson(projection), "utf8"),
      projectionSha256: realtimeWireProjectionSha256(projection),
      previousObservationSha256: this.#previous,
      identities,
      projection,
    });
    const observation = Object.freeze({
      ...core,
      observationSha256: realtimeWireObservationSha256(core),
    });
    this.#previous = observation.observationSha256;
    for (const listener of this.#wire) listener(observation);
    return observation;
  }

  #emit(event: NormalizedRealtimeEvent) {
    for (const listener of this.#events) listener(event);
  }

  async hydrateConversationHistory(
    turns: readonly RealtimeConversationHistoryTurn[],
  ): Promise<RealtimeConversationHistoryHydrationAcknowledgement> {
    const normalized = Object.freeze(turns.map((turn) => {
      if ("text" in turn) return Object.freeze({ ...turn });
      const calls = turn.role === "tool" ? [turn] : turn.calls;
      return Object.freeze({
        role: "tool_batch" as const,
        calls: Object.freeze(calls.map((call) => Object.freeze({
          toolName: call.toolName,
          toolArguments: JSON.parse(canonicalJson(call.toolArguments)),
          output: call.output,
          sourceSha256: call.sourceSha256,
        }))),
      });
    }));
    const historySha256 = sha256Hex(
      `harshas-amazing-call-center/realtime-conversation-history/provider-visible/v2\n${canonicalJson(
        normalized.map((turn) => "text" in turn
          ? { role: turn.role, text: turn.text }
          : { role: "tool_batch", calls: turn.calls.map((call) => ({
              toolName: call.toolName,
              toolArguments: call.toolArguments,
              output: call.output,
            })) }),
      )}`,
    );
    const sourceBindingSha256 = sha256Hex(
      `harshas-amazing-call-center/realtime-conversation-history/source-binding/v2\n${canonicalJson({
        historySha256,
        sources: normalized.map((turn, index) => "text" in turn
          ? { ordinal: index + 1, sourceSha256: turn.sourceSha256 }
          : {
              ordinal: index + 1,
              role: "tool_batch",
              calls: turn.calls.map((call, callIndex) => ({
                callOrdinal: callIndex + 1,
                sourceSha256: call.sourceSha256,
              })),
            }),
      })}`,
    );
    const toolCount = normalized.reduce((sum, turn) => sum + ("calls" in turn ? turn.calls.length : 0), 0);
    const geminiProjection = this.provider === "gemini"
      ? projectGeminiInitialHistoryClientContent(normalized, new Set([GEMINI_CAPABILITY_GATEWAY_NAME]))
      : null;
    const geminiObservation = geminiProjection
      ? this.#observe("clientContent", {
          initialHistory: {
            protocol: "initial_history_in_client_content",
            entryCount: normalized.length,
            providerContentTurnCount: geminiProjection.providerContentTurnCount,
            textPartCount: geminiProjection.textPartCount,
            functionCallCount: toolCount,
            functionResponseCount: toolCount,
            turnComplete: true,
            generationTriggered: false,
            providerAcknowledgement: "not_defined_by_protocol",
            providerVisibleHistorySha256: historySha256,
            geminiContentSha256: geminiProjection.geminiContentSha256,
          },
        })
      : null;
    let providerItemOrdinal = 0;
    const items = normalized.flatMap((turn, turnIndex) => {
      const expanded = "text" in turn
        ? [{
            kind: turn.role === "user" ? "user_message" as const : "assistant_message" as const,
            sourceSha256: turn.sourceSha256,
            content: turn.text,
            name: null,
            callId: null,
          }]
        : turn.calls.flatMap((call, callIndex) => [{
            kind: "synthetic_tool_call" as const,
            sourceSha256: call.sourceSha256,
            content: canonicalJson(call.toolArguments),
            name: call.toolName,
            callId: `history-${turnIndex + 1}-${callIndex + 1}`,
          }, {
            kind: "synthetic_tool_output" as const,
            sourceSha256: call.sourceSha256,
            content: call.output,
            name: null,
            callId: `history-${turnIndex + 1}-${callIndex + 1}`,
          }]);
      return expanded.map((entry) => {
        providerItemOrdinal += 1;
        const identities = Object.freeze({
          itemIdSha256: sha256Hex(`publication-history-item:${providerItemOrdinal}`),
          ...(entry.callId ? { callIdSha256: sha256Hex(`call\n${entry.callId}`) } : {}),
        });
        const contentSha256 = sha256Hex(entry.content);
        const contentBytes = Buffer.byteLength(entry.content, "utf8");
        const projection = entry.kind === "synthetic_tool_call"
          ? { kind: entry.kind, nameSha256: sha256Hex(entry.name!), nameBytes: Buffer.byteLength(entry.name!, "utf8"), namePresent: true, argumentsSha256: contentSha256, argumentsBytes: contentBytes, argumentsPresent: true, argumentsJsonValid: true }
          : entry.kind === "synthetic_tool_output"
            ? { kind: entry.kind, outputSha256: contentSha256, outputBytes: contentBytes, outputPresent: true }
            : { kind: entry.kind, contentSha256, contentBytes };
        const outbound = geminiObservation ?? this.#observe("conversation.item.create", { conversationHistoryItem: projection }, "outbound", identities);
        const inbound = geminiObservation ? undefined : this.#observe(
          this.provider === "xai" ? "conversation.item.added" : "conversation.item.created",
          { conversationHistoryItem: projection },
          "inbound",
          identities,
        );
        return Object.freeze({
          historyTurnOrdinal: turnIndex + 1,
          providerItemOrdinal,
          kind: entry.kind,
          sourceSha256: entry.sourceSha256,
          ...(entry.callId ? { syntheticCallIdSha256: identities.callIdSha256 } : {}),
          outboundObservation: this.#reference(outbound),
          ...(inbound ? { inboundObservation: this.#reference(inbound) } : {}),
        });
      });
    });
    return Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      connectionEpoch: 1,
      status: this.provider === "gemini" ? "sent_unacknowledged_by_provider_protocol" as const : "acknowledged" as const,
      turnCount: normalized.length,
      providerItemCount: items.length,
      historySha256,
      sourceBindingSha256,
      items: Object.freeze(items),
    });
  }

  #reference(observation: RealtimeWireObservation) {
    return Object.freeze({
      availability: "observed" as const,
      connectionEpoch: observation.connectionEpoch,
      sequence: observation.sequence,
      observationSha256: observation.observationSha256,
      payloadSha256: observation.payloadSha256,
      projectionSha256: observation.projectionSha256,
    });
  }

  appendInputAudio(audio: Pcm16Audio) {
    const base64 = Buffer.from(audio.data).toString("base64");
    const canonicalPcmProjection = Object.freeze({
      validCanonicalBase64: true,
      byteLength: audio.data.byteLength,
      sha256: sha256Hex(audio.data),
      encodedBytes: Buffer.byteLength(base64, "utf8"),
      format: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: audio.sampleRateHz, channels: 1 as const }),
    });
    const projection = this.provider === "gemini"
      ? Object.freeze({
          audio: Object.freeze({
            direction: "input" as const,
            chunks: Object.freeze([Object.freeze({
              ...canonicalPcmProjection,
              mimeTypeRecognized: true,
            })]),
          }),
        })
      : Object.freeze({ audio: canonicalPcmProjection });
    if (this.provider === "gemini" && !this.#geminiInputOpen) {
      this.#observe("realtimeInput.activityStart", { audio: { direction: "input", activity: "start" } });
      this.#geminiInputOpen = true;
    }
    const rawEvent = this.provider === "gemini"
      ? {
          realtimeInput: {
            audio: {
              data: base64,
              mimeType: `audio/pcm;rate=${audio.sampleRateHz}`,
            },
          },
        }
      : { type: "input_audio_buffer.append", audio: base64 };
    const serialized = JSON.stringify(rawEvent);
    this.#observe(
      this.provider === "gemini" ? "realtimeInput.audio" : "input_audio_buffer.append",
      projection,
      "outbound",
      Object.freeze({}),
      Object.freeze({
        payloadSha256: sha256Hex(serialized),
        payloadBytes: Buffer.byteLength(serialized, "utf8"),
      }),
    );
  }

  prepareResponse(preparation: Parameters<NormalizedRealtimeClient["prepareResponse"]>[0]) {
    this.#preparedPhase = preparation.additionalInstructions.includes('"phase":"repair"')
      ? "repair"
      : "canonical";
  }
  prepareToolContinuation(preparation: Parameters<NormalizedRealtimeClient["prepareResponse"]>[0]) {
    this.#preparedPhase = preparation.additionalInstructions.includes('"phase":"repair"')
      ? "repair"
      : "canonical";
  }
  commitInputAudio() {
    if (this.provider === "gemini") {
      this.#observe("realtimeInput.activityEnd", { audio: { direction: "input", activity: "end" } });
      this.#geminiInputOpen = false;
    } else {
      this.#commit += 1;
      this.#observe("input_audio_buffer.commit", {});
    }
  }
  async waitForInputAudioCommit() {
    const observed = this.#observe("input_audio_buffer.committed", {}, "inbound");
    const wireObservation = this.#reference(observed);
    this.#emit({
      type: "input.audio_committed", provider: this.provider, receivedAtMs: observed.sequence,
      wireType: observed.wireType, connectionEpoch: 1, commitOrdinal: this.#commit, wireObservation,
    });
    return Object.freeze({ provider: "xai" as const, connectionEpoch: 1, commitOrdinal: this.#commit, status: "acknowledged" as const, wireObservation });
  }
  sendTurn() { throw new Error("publication runtime must use append/commit"); }

  submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean) {
    for (const result of results) {
      this.#observe(this.provider === "gemini" ? "toolResponse" : "conversation.item.create", {
        toolResult: { outputSha256: sha256Hex(canonicalJson(result.output)) },
      }, "outbound", { callIdSha256: realtimeWireIdentitySha256("call", result.callId) });
    }
    if (createResponse) this.createResponse();
  }

  createResponse() {
    const responseOrdinal = ++this.#response;
    // Provider-native IDs intentionally restart on every physical session.
    // The host must distinguish them through the signed connection scope.
    const responseId = `publication-${this.provider}-response-${responseOrdinal}`;
    if (this.provider !== "gemini") this.#observe("response.create", {});
    const calls = this.#pending(this.#preparedPhase).slice(0, 1);
    if (calls.length > 0) {
      queueMicrotask(() => {
        if (this.provider !== "gemini") {
          const started = this.#observe(
            "response.created",
            { response_id: responseId },
            "inbound",
            { responseIdSha256: realtimeWireIdentitySha256("response", responseId) },
          );
          this.#emit({
            type: "response.started",
            provider: this.provider,
            receivedAtMs: started.sequence,
            wireType: started.wireType,
            responseId,
            wireObservation: this.#reference(started),
          });
        }
        const dispatches = calls.map((call, index) => {
          const callId = `${responseId}-batch-${responseOrdinal}-call-${index + 1}`;
          this.#onProviderCallId(callId);
          const provenance = Object.freeze({
            schemaVersion: 2 as const,
            provider: this.provider,
            nativeCallId: callId,
            nativeResponseId: responseId,
            connectionEpoch: 1,
            providerSessionIdSha256: this.provider === "gemini"
              ? null
              : sha256Hex(
                  `publication-${this.provider}-session-${this.#sessionIdentity}`,
                ),
            terminalWireType: "response.function_call_arguments.done" as const,
          });
          return { call, callId, provenance };
        });
        const toolObservations = dispatches.map(({ callId }) => this.#observe(
          this.provider === "gemini" ? "toolCall" : "response.function_call_arguments.done",
          { toolBatch: { callCount: 1 } },
          "inbound",
          {
            responseIdSha256: realtimeWireIdentitySha256("response", responseId),
            callIdSha256: realtimeWireIdentitySha256("call", callId),
          },
        ));
        const observed = toolObservations.at(-1)!;
        if (this.provider === "gemini") {
          this.#emit({
            type: "tool.calls", provider: "gemini", receivedAtMs: observed.sequence,
            wireType: observed.wireType, responseId, wireObservation: this.#reference(observed),
            calls: dispatches.map(({ call, callId }) => ({
              callId,
              name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
              argumentsText: canonicalJson({ tool_name: call.semantic_intent, arguments: call.target_arguments }),
              argumentsJson: { tool_name: call.semantic_intent, arguments: call.target_arguments },
              responseId,
              responseIdSource: "client_local" as const,
              causalBinding: Object.freeze({
                connectionEpoch: 1,
                inputTurn: responseOrdinal,
                trigger: "audio_activity_end" as const,
                clientMessageOrdinal: responseOrdinal,
                providerCallId: callId,
                localResponseId: responseId,
              }),
              terminalWireType: "toolCall",
            })),
          });
        } else {
          const nonGeminiProvider = this.provider;
          this.#emit({
            type: "tool.dispatch", provider: this.provider, receivedAtMs: observed.sequence,
            wireType: observed.wireType, responseId, gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
            wireObservation: this.#reference(observed),
            dispatches: dispatches.map(({ call, callId, provenance }) => {
              const narrowedProvenance = Object.freeze({ ...provenance, provider: nonGeminiProvider });
              return ({
              callId,
              provenance: narrowedProvenance,
              request: {
                method: "tools/call" as const,
                params: {
                  name: call.semantic_intent,
                  arguments: call.target_arguments,
                  _meta: {
                    [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: callId,
                    [PROVIDER_PROVENANCE_META_KEY]: narrowedProvenance,
                  },
                },
              },
              });
            }),
          });
        }
      });
      return;
    }
    queueMicrotask(() => {
      const nonGeminiStarted = this.provider === "gemini"
        ? null
        : this.#observe(
            "response.created",
            { response_id: responseId },
            "inbound",
            { responseIdSha256: realtimeWireIdentitySha256("response", responseId) },
          );
      const transcript = this.#transcript();
      // The deterministic ASR fixture must never assign two transcripts to the
      // same played PCM. Encoding the transcript digest as even-length PCM
      // keeps the speech-evidence function stable across all session rotates.
      const pcm = Uint8Array.from(Buffer.from(sha256Hex(transcript), "hex"));
      this.#onPcm(pcm, transcript);
      const canonicalPcmProjection = Object.freeze({
        validCanonicalBase64: true,
        byteLength: pcm.byteLength,
        sha256: sha256Hex(pcm),
        encodedBytes: Buffer.byteLength(Buffer.from(pcm).toString("base64"), "utf8"),
        format: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: 24_000, channels: 1 as const }),
      });
      const audioProjection = this.provider === "gemini"
        ? Object.freeze({
            audio: Object.freeze({
              direction: "output" as const,
              chunks: Object.freeze([Object.freeze({
                ...canonicalPcmProjection,
                mimeTypeRecognized: true,
              })]),
            }),
          })
        : Object.freeze({ audio: canonicalPcmProjection });
      const audio = this.#observe(
        this.provider === "gemini" ? "serverContent" : "response.audio.delta",
        audioProjection,
        "inbound",
        { responseIdSha256: realtimeWireIdentitySha256("response", responseId) },
      );
      const audioReference = this.#reference(audio);
      const started = this.provider === "gemini"
        ? audio
        : nonGeminiStarted!;
      this.#emit({
        type: "response.started",
        provider: this.provider,
        receivedAtMs: started.sequence,
        wireType: started.wireType,
        responseId,
        wireObservation: this.#reference(started),
      });
      this.#emit({ type: "output.transcript", provider: this.provider, receivedAtMs: audio.sequence, wireType: audio.wireType, responseId, phase: "final", text: transcript, source: "audio", wireObservation: audioReference });
      this.#emit({ type: "output.audio", provider: this.provider, receivedAtMs: audio.sequence, wireType: audio.wireType, responseId, audio: pcm, format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }, wireObservation: audioReference });
      const terminal = this.#observe(this.provider === "gemini" ? "serverContent" : "response.done", { terminal: { status: "completed" } }, "inbound", { responseIdSha256: realtimeWireIdentitySha256("response", responseId) });
      this.#emit({ type: "response.completed", provider: this.provider, receivedAtMs: terminal.sequence, wireType: terminal.wireType, responseId, status: "completed", wireObservation: this.#reference(terminal) });
    });
  }
}

async function gateDForDevelopmentPrepare(
  prepare: ReturnType<typeof createLc4DevLivePrepareArtifact>,
): Promise<Lc4XaiFiniteManualGateDReceipt> {
  const authority = createLc4XaiFiniteManualGateDSigner(keys().privatePem);
  const terminal = createLc4XaiFiniteManualGateDSigner(keys().privatePem);
  const clip = Uint8Array.from([1, 0, 2, 0]);
  const plan = createLc4XaiFiniteManualGateDPlan({
    gate_id: "publication-full-evidence-gate-d",
    prepared_at: NOW.toISOString(),
    source_commit: prepare.source_commit,
    source_tree_sha256: prepare.source_tree_sha256,
    harmless_clip_pcm: clip,
    signer: authority,
  });
  const authorization = createLc4XaiFiniteManualGateDAuthorization({
    plan,
    plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
    authorization_id: "publication-full-evidence-gate-d-auth",
    authorization_nonce_sha256: sha256Hex("publication-full-evidence-gate-d-nonce"),
    credential_identity_sha256: sha256Hex("publication-full-evidence-gate-d-credential"),
    terminal_signer: terminal,
    not_before: new Date(NOW.getTime() - 60_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 59 * 60_000).toISOString(),
    authority_signer: authority,
  });
  const roles = Object.freeze([
    ["outbound", "input_audio_buffer.commit"], ["inbound", "input_audio_buffer.committed"],
    ["outbound", "response.create"], ["inbound", "response.created"],
    ["inbound", "response.audio.delta"], ["inbound", "response.function_call_arguments.done"],
    ["inbound", "response.done"], ["outbound", "conversation.item.create"],
    ["outbound", "response.create"], ["inbound", "response.created"],
    ["inbound", "response.audio.delta"], ["inbound", "response.done"],
  ] as const);
  const rootResponse = lc4XaiManualResponseWireIdentitySha256("publication-gate-d-root");
  const postResponse = lc4XaiManualResponseWireIdentitySha256("publication-gate-d-post");
  const callId = sha256Hex("publication-gate-d-call");
  let previous: string | null = null;
  const observations: Lc4SanitizedWireObservation[] = roles.map(([direction, wireType], offset) => {
    const sequence = offset + 1;
    const observationSha256 = sha256Hex(canonicalJson({ direction, wireType, sequence, previous }));
    const observation = Object.freeze({
      provider: "xai" as const,
      direction,
      connection_epoch: 1,
      sequence,
      wire_type: wireType,
      payload_sha256: sha256Hex(`publication-gate-d-payload:${sequence}`),
      payload_bytes: 8,
      projection_sha256: sha256Hex(`publication-gate-d-projection:${sequence}`),
      observation_sha256: observationSha256,
      previous_observation_sha256: previous,
      identity_hashes: Object.freeze({
        ...([4, 5, 6, 7].includes(sequence) ? { responseIdSha256: rootResponse } : {}),
        ...([10, 11, 12].includes(sequence) ? { responseIdSha256: postResponse } : {}),
        ...([6, 7, 8].includes(sequence) ? { callIdSha256: callId } : {}),
      }),
    });
    previous = observationSha256;
    return observation;
  });
  const causalityBody = Object.freeze({
    schema_version: 1 as const,
    connection_epoch: 1,
    commit_observation_sha256: observations[0]!.observation_sha256,
    commit_sequence: 1,
    commit_ack_observation_sha256: observations[1]!.observation_sha256,
    commit_ack_sequence: 2,
    response_create_observation_sha256: observations[2]!.observation_sha256,
    response_create_sequence: 3,
    response_start_observation_sha256: observations[3]!.observation_sha256,
    response_start_sequence: 4,
    response_id_sha256: rootResponse,
  });
  const body = Object.freeze({
    schema_version: 2 as const,
    provider: "xai" as const,
    model: plan.body.model,
    voice: plan.body.voice,
    transport_purpose: "finite_prerecorded_efficacy" as const,
    transport_mode: "manual_commit" as const,
    transport_profile_sha256: plan.body.transport_profile_sha256,
    production_adapter_binding_sha256: LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    caller_pcm_sha256: plan.body.harmless_clip.pcm_sha256,
    caller_pcm_byte_length: plan.body.harmless_clip.pcm_byte_length,
    caller_pcm_appended_sha256: plan.body.harmless_clip.pcm_sha256,
    caller_pcm_appended_byte_length: plan.body.harmless_clip.pcm_byte_length,
    provider_sessions_opened: 1 as const,
    generation_phases: 2 as const,
    capability_gateway_tool_roundtrips: 1 as const,
    retries: 0 as const,
    reconnects: 0 as const,
    fallbacks: 0 as const,
    operation_order: LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
    manual_turn_causality: Object.freeze({
      ...causalityBody,
      causality_sha256: sha256Hex(`harshas-amazing-call-center/lc4-xai-manual-turn-causality/v1\n${canonicalJson(causalityBody)}`),
    }),
    wire_observations: Object.freeze(observations),
    initial_assistant_pcm_sha256: sha256Hex("publication-gate-d-initial"),
    initial_assistant_pcm_byte_length: 4,
    initial_assistant_pcm_observation_sha256: observations[4]!.observation_sha256,
    capability_gateway_tool_call_sha256: sha256Hex("publication-gate-d-tool-call"),
    capability_gateway_tool_call_observation_sha256: observations[6]!.observation_sha256,
    capability_gateway_tool_result_sha256: sha256Hex("publication-gate-d-tool-result"),
    capability_gateway_tool_result_observation_sha256: observations[7]!.observation_sha256,
    post_tool_continuation_sha256: sha256Hex("publication-gate-d-continuation"),
    post_tool_continuation_observation_sha256: observations[8]!.observation_sha256,
    post_tool_response_start_observation_sha256: observations[9]!.observation_sha256,
    post_tool_assistant_pcm_sha256: sha256Hex("publication-gate-d-post-pcm"),
    post_tool_assistant_pcm_byte_length: 4,
    post_tool_assistant_pcm_observation_sha256: observations[10]!.observation_sha256,
    capability_gateway_call_id_sha256: callId,
    post_tool_continuation_origin_response_id_sha256: rootResponse,
    post_tool_response_id_sha256: postResponse,
    terminal_observation_sha256: observations[11]!.observation_sha256,
  });
  const evidence: Lc4XaiFiniteManualGateDExecutionEvidence = Object.freeze({
    ...body,
    replay_sha256: lc4XaiFiniteManualGateDExecutionReplaySha256(body),
  });
  const adapter: Lc4XaiFiniteManualGateDProductionAdapter = Object.freeze({
    [LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY]: true as const,
    kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1",
    production_adapter_binding_sha256: LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    execute: async () => evidence,
  });
  const markerRoot = await mkdtemp(join(tmpdir(), "publication-gate-d-"));
  roots.push(markerRoot);
  return executeLc4XaiFiniteManualGateD({
    plan,
    authorization,
    terminal_signer: terminal,
    credential_identity_sha256: authorization.body.credential_identity_sha256,
    caller_pcm: clip,
    inspected_source: { source_commit: prepare.source_commit, source_tree_sha256: prepare.source_tree_sha256, worktree_clean: true },
    now: NOW,
    completion_clock: () => new Date(NOW.getTime() + 1_000),
    expected_plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
    invocation_marker_path: join(markerRoot, "invocation.json"),
    construct_production_adapter: () => adapter,
  });
}

const TEST_ASR_CONTRACT: IndependentAsrContract = Object.freeze({
  schema_version: 1,
  contract_id: "lc4-publication-full-evidence-asr-v1",
  engine: Object.freeze({
    implementation: "whisper.cpp",
    source_repository: "https://github.com/ggml-org/whisper.cpp",
    source_revision: "1".repeat(40),
    executable_sha256: sha256Hex("publication-asr-executable"),
    dependency_lock_sha256: sha256Hex("publication-asr-lock"),
    model_id: "deterministic-publication-asr",
    model_revision: "2".repeat(40),
    weights_sha256: sha256Hex("publication-asr-weights"),
  }),
  decoding: Object.freeze({
    language: "en", task: "transcribe", temperature_milli: 0, beam_size: 5,
    best_of: 5, word_timestamps: true, condition_on_previous_text: false,
    initial_prompt_sha256: null,
  }),
  resampling_profile_sha256: sha256Hex("publication-asr-resampling"),
  result_schema_sha256: INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
});

function completedAsr(request: IndependentAsrRequest, transcript: string) {
  return Object.freeze({
    status: "completed" as const,
    source_request_sha256: request.request_sha256,
    source_played_audio_sha256: request.source_played_audio_sha256,
    source_chunk_sequence_sha256: request.source_chunk_sequence_sha256,
    language: "en",
    transcript,
    processed_through_sample: request.played_sample_count,
    no_speech_probability_ppm: 1_000,
    spans: Object.freeze([Object.freeze({
      span_id: "span-1", text: transcript, utf8_start: 0,
      utf8_end: Buffer.byteLength(transcript, "utf8"), audio_start_sample: 0,
      audio_end_sample: request.played_sample_count, confidence_ppm: 999_000,
    })]),
  });
}

async function publicationCalibration(
  signer: ReturnType<typeof createBenchmarkKernelAttestationSigner>,
  publicKeyPem: string,
) {
  const plan: IndependentAsrCalibrationPlan = Object.freeze({
    calibration_id: "lc4-publication-full-evidence-calibration",
    protocol_sha256: sha256Hex("HACC-LC4-DEV-v1"),
    corpus_manifest_sha256: sha256Hex("publication-calibration-corpus"),
    evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
    expected_route_ids: Object.freeze(["fixture-output", "listener-sink"]),
    thresholds: Object.freeze({
      min_fixture_coverage_ppm: 950_000,
      max_word_error_upper_bound_ppm: 100_000,
      max_semantic_false_negative_upper_bound_ppm: 100_000,
      max_semantic_false_positive_upper_bound_ppm: 100_000,
      max_alignment_boundary_p95_ms: 250,
      max_route_word_error_gap_ppm: 50_000,
    }),
  });
  const fixtures: AsrCalibrationSourceFixture[] = [];
  for (const routeId of plan.expected_route_ids) {
    for (let index = 0; index < 32; index += 1) {
      const id = `${routeId}-${index}`;
      const chunks: AudiblePcmChunk[] = [Object.freeze({
        chunkId: "calibration", encoding: "pcm16", sampleRateHz: 24_000,
        channels: 1, data: Uint8Array.from([index + 1, 0, index + 2, 0]),
      })];
      const request = (await import("../audible-evidence")).createIndependentAsrRequest({
        runId: "publication-calibration", unitId: id, invocationId: `inv-${id}`,
        adapterBlindNonceSha256: sha256Hex(`publication-calibration:${id}`),
        contract: TEST_ASR_CONTRACT, chunks, playedThroughByte: chunks[0]!.data.byteLength,
      });
      const transcript = "authoritative evidence checked";
      const invocation = await runIndependentAsrAdapter({
        request, contract: TEST_ASR_CONTRACT, runnerSigner: signer,
        execute: () => ({ result: completedAsr(request, transcript), exitCode: 0, runtimeMs: 1, stdout: "", stderr: "" }),
      });
      fixtures.push(Object.freeze({
        fixture_id: id, route_id: routeId, split: "held_out", corpus_sample_id: `sample-${index}`,
        reference_transcript: transcript, expected_semantic_phrases: Object.freeze(["authoritative evidence"]),
        forbidden_semantic_phrases: Object.freeze(["unsupported completion"]),
        reference_audio_start_sample: 0, reference_audio_end_sample: request.played_sample_count, invocation,
      }));
    }
  }
  return prepareIndependentAsrCalibration({
    plan,
    contract: TEST_ASR_CONTRACT,
    fixtures,
    runnerTrust: Object.freeze({ keyId: signer.keyId, publicKeySha256: signer.publicKeySha256, publicKeyPem }),
  });
}

function rendered(sampleRate: 16_000 | 24_000 | 48_000, seed: number): Uint8Array {
  const output = new Uint8Array(Math.floor(sampleRate / 10) * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < output.byteLength / 2; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin((index + seed) / 9) * 6_000), true);
  }
  return output;
}

const developmentRenderer: Lc4DevAudioRenderer = Object.freeze({
  identity: Object.freeze({
    renderer: "injected-test-renderer",
    identity_sha256: sha256Hex("publication-deterministic-renderer"),
    toolchain: null,
    voice: LC4_DEV_PINNED_VOICE,
    normalization: "ffmpeg-loudnorm-I-20-LRA-7-TP-3",
  }),
  assertReady() {},
  assertUnchanged() {},
  async render({ sourceTextSha256 }) {
    const seed = Number.parseInt(sourceTextSha256.slice(0, 4), 16);
    return Object.freeze({ master48k: rendered(48_000, seed), pcm16k: rendered(16_000, seed), pcm24k: rendered(24_000, seed) });
  },
});

function operatorIdentity(): Lc4DevOperatorSigner {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({
    private_key: pair.privateKey,
    public_key_spki_der: publicDer,
    public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pkcs8_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_fingerprint_sha256: sha256Hex(publicDer),
  });
}

describe("LC4 publication full retained-evidence replay", () => {
  it("reconstructs the provider-free six-episode production runtime from signed listener CAS artifacts", async () => {
    const qualificationFs = await signedV4FilesystemFixture();
    const qualification = await loadLc4DevRetainedQualificationV4({
      root: qualificationFs.root,
      qualification_trust_root_sha256: qualificationFs.trustRoot,
      now: NOW,
    });
    assertLc4DevRetainedQualificationV4Receipt(qualification);
    assertLc4DevQualificationAdmissionReceipt(qualification);
    assertLc4DevPreflightQualificationAdmission(qualification, NOW);

    const runtimeRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-publication-full-"));
    roots.push(runtimeRoot);
    const audioRoot = resolve(runtimeRoot, "audio");
    const evidenceRoot = resolve(runtimeRoot, "evidence");
    const audio = await materializeLc4DevelopmentAudio({ outputRoot: audioRoot, renderer: developmentRenderer });
    const corpus = createLc4PublicDevelopmentCorpus();
    const placeholderPrepare = createLc4DevLivePrepareArtifact({
      execution_id: "lc4-publication-full-evidence",
      created_at: NOW.toISOString(),
      source_commit: SOURCE.source_commit,
      source_tree_sha256: SOURCE.source_tree_sha256,
      audio_manifest_sha256: audio.manifest.manifest_sha256,
      audio_bindings: audio.manifest.caller_audio_bindings,
      xai_finite_manual_gate_d: Object.freeze({
        receipt_sha256: sha256Hex("publication-placeholder-gate-d"),
        plan_authority_trust_root_sha256: sha256Hex("publication-placeholder-gate-d-authority"),
        transport_profile_sha256: LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
      }),
    });
    const gateD = await gateDForDevelopmentPrepare(placeholderPrepare);
    const prepare = createLc4DevLivePrepareArtifact({
      execution_id: placeholderPrepare.execution_id,
      created_at: placeholderPrepare.created_at,
      source_commit: placeholderPrepare.source_commit,
      source_tree_sha256: placeholderPrepare.source_tree_sha256,
      audio_manifest_sha256: audio.manifest.manifest_sha256,
      audio_bindings: audio.manifest.caller_audio_bindings,
      xai_finite_manual_gate_d: Object.freeze({
        receipt_sha256: gateD.receipt_sha256,
        plan_authority_trust_root_sha256: gateD.plan_authority_trust_root_sha256,
        transport_profile_sha256: gateD.transport_profile_sha256,
      }),
    });

    const operator = operatorIdentity();
    const authorityKeyId = `lc4-dev-authority-${operator.public_key_fingerprint_sha256.slice(0, 24)}`;
    const kernelSigner = createBenchmarkKernelAttestationSigner({
      keyId: authorityKeyId,
      privateKeyPem: operator.private_key_pkcs8_pem,
      publicKeyPem: operator.public_key_spki_pem,
    });
    const control = createLc4DevMunicipalControlPlane({
      audio_manifest: audio.manifest,
      repair_manifest: audio.repairManifest,
      signer: kernelSigner,
      now: () => NOW,
      corpus,
    });
    let gatewayExecutorInvocationCount = 0;
    let gatewayExecutorFailure: unknown = null;
    const countingControl = Object.freeze({
      ...control,
      gateway_executor: Object.freeze({
        ...control.gateway_executor,
        async execute(input: Parameters<typeof control.gateway_executor.execute>[0]) {
          gatewayExecutorInvocationCount += 1;
          try {
            return await control.gateway_executor.execute(input);
          } catch (error) {
            gatewayExecutorFailure = error;
            throw error;
          }
        },
      }),
    });
    const branchMatrix = createLc4DevCallerBranchMatrixArtifact({
      audio_manifest_sha256: audio.manifest.manifest_sha256,
      audio_bindings: audio.manifest.caller_branch_audio_bindings,
      signing_identity: {
        key_id: authorityKeyId,
        private_key_pem: operator.private_key_pkcs8_pem,
        public_key_pem: operator.public_key_spki_pem,
      },
    });
    const branchAuthority = createLc4DevCallerBranchAuthority({
      matrix: branchMatrix,
      signing_identity: {
        key_id: authorityKeyId,
        private_key_pem: operator.private_key_pkcs8_pem,
        public_key_pem: operator.public_key_spki_pem,
      },
    });
    const branchTrust = Object.freeze({
      key_id: authorityKeyId,
      public_key_pem: operator.public_key_spki_pem,
    });

    const asrPair = generateKeyPairSync("ed25519");
    const asrSigner = createBenchmarkKernelAttestationSigner({
      keyId: "lc4-publication-full-evidence-asr",
      privateKeyPem: asrPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: asrPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const calibration = await publicationCalibration(
      asrSigner,
      asrPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const casRoot = resolve(evidenceRoot, "cas");
    const evaluatorCas = await createLc4ImmutableCas(casRoot);
    const transcriptByPcm = new Map<string, string>();
    let listenerFailure: unknown = null;
    const baseEvaluator = createLc4DevelopmentPinnedListenerEvaluator({
      asr_contract: TEST_ASR_CONTRACT,
      asr_calibration: calibration,
      asr_runner_signer: asrSigner,
      retention: Object.freeze({ put: (bytes: Uint8Array, mediaType: "application/json") => evaluatorCas.put(bytes, mediaType) }),
      execute_asr: (adapterInput) => {
        const sourcePcmSha256 = sha256Hex(adapterInput.played_pcm);
        const transcript = transcriptByPcm.get(sourcePcmSha256);
        if (!transcript) throw new Error(`publication ASR has no transcript for ${sourcePcmSha256}`);
        return Object.freeze({
          result: Object.freeze({
            status: "completed" as const,
            source_request_sha256: adapterInput.source_request_sha256,
            source_played_audio_sha256: sourcePcmSha256,
            source_chunk_sequence_sha256: adapterInput.source_chunk_sequence_sha256,
            language: "en",
            transcript,
            processed_through_sample: adapterInput.played_sample_count,
            no_speech_probability_ppm: 1_000,
            spans: Object.freeze([Object.freeze({
              span_id: "span-1", text: transcript, utf8_start: 0,
              utf8_end: Buffer.byteLength(transcript, "utf8"), audio_start_sample: 0,
              audio_end_sample: adapterInput.played_sample_count, confidence_ppm: 999_000,
            })]),
          }),
          exitCode: 0, runtimeMs: 1, stdout: "", stderr: "",
        });
      },
    });
    const evaluator = Object.freeze({
      ...baseEvaluator,
      async evaluate(input: Parameters<typeof baseEvaluator.evaluate>[0]) {
        try {
          return await baseEvaluator.evaluate(input);
        } catch (error) {
          listenerFailure = error;
          throw error;
        }
      },
    });
    const criteria = lc4DevelopmentListenerCriterionBindings();
    const playbackAuthority = createLc4HeadlessListenerPlaybackAuthority({ signer: kernelSigner });
    const listenerManifest = createLc4PinnedListenerManifestSha256({
      corpus_sha256: corpus.artifact_sha256,
      evaluator,
      criteria,
      playback_authority_manifest_sha256: playbackAuthority.authority_manifest_sha256,
    });
    const credentials = Object.freeze({
      openai: "publication-openai-secret",
      gemini: "publication-gemini-secret",
      xai: "publication-xai-secret",
    });
    const credentialIdentity = lc4DevCredentialIdentitySetSha256(credentials);
    const asrContractSha256 = independentAsrContractSha256(TEST_ASR_CONTRACT);
    const asrRunnerTrust = createLc4DevAsrRunnerTrust({
      key_id: asrSigner.keyId,
      public_key_spki_base64: asrPair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      public_key_fingerprint_sha256: asrSigner.publicKeySha256,
      signature_algorithm: "Ed25519",
    });
    const rootsBinding = Object.freeze({
      control_plane_manifest_sha256: control.manifest_sha256,
      listener_evidence_manifest_sha256: listenerManifest,
      runtime_config_sha256: sha256Hex("publication-runtime-config"),
      asr_evaluator_build_sha256: evaluator.evaluator_build_sha256,
      asr_evaluator_toolchain_sha256: sha256Hex("publication-asr-toolchain"),
      asr_contract: TEST_ASR_CONTRACT,
      asr_contract_sha256: asrContractSha256,
      asr_runner_trust: asrRunnerTrust,
    });
    const dag = createLc4DevOperatorAuthorizationDag({
      prepare,
      qualification,
      credential_identity_set_sha256: credentialIdentity,
      roots: rootsBinding,
      signer: operator,
      authorization_nonce_sha256: sha256Hex("publication-operator-nonce"),
      not_before: new Date(NOW.getTime() - 60_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 59 * 60_000).toISOString(),
    });
    const preflight = createLc4DevLivePreflightArtifact({
      prepare,
      checked_at: NOW.toISOString(),
      qualification_gate_sha256: qualification.retained_artifact_sha256,
      qualification,
      xai_finite_manual_gate_d: gateD,
      credential_identity_set_sha256: credentialIdentity,
      ...rootsBinding,
      immutable_ledger_genesis_sha256: dag.immutable_ledger_genesis_sha256,
      audio_manifest_sha256: audio.manifest.manifest_sha256,
      authorization: dag.authorization,
      expected_authority_public_key_fingerprint_sha256: operator.public_key_fingerprint_sha256,
    });
    const budgetRoot = resolve(runtimeRoot, "budget");
    const lease = await reserveLc4DevRunBudget({ root: budgetRoot, binding: { prepare, preflight }, now: () => NOW });
    const budget = new Lc4DevBudgetLifecycle({ lease, binding: { prepare, preflight }, now: () => NOW });
    const callerAudio = createLc4DevCallerAudioLoader({ outputRoot: audioRoot, manifest: audio.manifest });
    const repairControllers = Object.freeze(Object.fromEntries(((["openai", "gemini", "xai"] as const)).map((provider) => [
      provider,
      createLc4DevRepairPlaybackController({
        provider,
        audio_manifest: audio.manifest,
        repair_manifest: audio.repairManifest,
        async load_repair_pcm(binding) {
          const registered = audio.repairManifest.repair_sources.find((source) => source.source_id === binding.repair_id)?.provider_renditions[provider];
          if (!registered) throw new Error("publication repair rendition is missing");
          return new Uint8Array(await readFile(resolve(audioRoot, registered.path)));
              },
            }),
    ]))) as Record<LiveStsProvider, ReturnType<typeof createLc4DevRepairPlaybackController>>;

    const repairEpisodeId = "lc4-dev-openai-hacc";
    const repairOpportunityId = "lc4-dev-op-10";
    const failedCanonical = new Set<string>();
    let repairToolAttemptEmitted = false;
    let repairToolExecutorCountBefore: number | null = null;
    let repairToolExecutorCountAfter: number | null = null;
    let clientOrdinal = 0;
    const emittedProviderCallIds = new Map<string, number>();
    productionClient.create.mockImplementation((provider: LiveStsProvider) => {
      const episode = prepare.episodes[Math.floor(clientOrdinal / 6)]!;
      clientOrdinal += 1;
      expect(provider).toBe(episode.provider);
      return new PublicationRuntimeClient({
        provider,
        sessionIdentity: String(clientOrdinal).padStart(2, "0"),
        onProviderCallId: (callId) => {
          emittedProviderCallIds.set(
            callId,
            (emittedProviderCallIds.get(callId) ?? 0) + 1,
          );
        },
        pending: (phase) => {
          const snapshot = control.snapshot(episode.episode_id);
          const currentOpportunityId = corpus.opportunities[snapshot.opportunities - 1]!.id;
          const targetRepairIsActive = episode.episode_id === repairEpisodeId
            && currentOpportunityId === repairOpportunityId
            && phase === "repair";
          if (targetRepairIsActive && !repairToolAttemptEmitted) {
            repairToolAttemptEmitted = true;
            repairToolExecutorCountBefore = gatewayExecutorInvocationCount;
            return Object.freeze([Object.freeze({
              opportunity_id: repairOpportunityId,
              semantic_intent: "complete_current_stage" as const,
              target_tool: "archive.complete_stage",
              target_arguments: Object.freeze({}),
            })]);
          }
          if (targetRepairIsActive) {
            repairToolExecutorCountAfter ??= gatewayExecutorInvocationCount;
            return Object.freeze([]);
          }
          return control.development_pending_calls(episode.episode_id);
        },
        transcript: () => {
          const opportunityIndex = control.snapshot(episode.episode_id).opportunities;
          const canonicalId = corpus.opportunities[opportunityIndex - 1]!.id;
          const planned = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.find((candidate) => (
            candidate.opportunity_id === canonicalId
              || (canonicalId === "lc4-dev-op-42" && candidate.opportunity_id.includes("committed_after_error"))
          ));
          if (!planned) return "Confirmed: authoritative evidence.";
          const failureKey = `${episode.episode_id}:${canonicalId}`;
          if (episode.episode_id === repairEpisodeId
            && canonicalId === repairOpportunityId
            && !failedCanonical.has(failureKey)) {
            failedCanonical.add(failureKey);
            return "I need you to repeat that detail.";
          }
          return planned.criteria
            .filter((criterion) => criterion.operator !== "contains_none")
            .map((criterion) => `Confirmed: ${criterion.phrases[0]}.`)
            .join(" ") || "Confirmed: authoritative evidence.";
        },
        onPcm: (pcm, transcript) => {
          const pcmSha256 = sha256Hex(pcm);
          const priorTranscript = transcriptByPcm.get(pcmSha256);
          if (priorTranscript !== undefined && priorTranscript !== transcript) {
            throw new Error("publication ASR fixture mapped one PCM artifact to multiple transcripts");
          }
          transcriptByPcm.set(pcmSha256, transcript);
        },
      });
    });

    const dependencies = await createLc4DevelopmentLiveDependencies({
      prepare,
      preflight,
      corpus,
      cas_root_dir: casRoot,
      ledger_path: resolve(evidenceRoot, "ledger.jsonl"),
      caller_audio: callerAudio,
      caller_branch: Object.freeze({ matrix: branchMatrix, authority: branchAuthority, trust: branchTrust, load: callerAudio.loadBranch }),
      authority_signer: kernelSigner,
      control: countingControl,
      repair: repairControllers,
      criteria,
      evaluator,
      playback_authority: playbackAuthority,
      playback_authority_manifest_sha256: playbackAuthority.authority_manifest_sha256,
      create_adapter: (listener, gatewayExecutor, evidence) => createLc4DevelopmentRealtimeAdapter({
        prepare, preflight, credentials,
        caller_branch_authority: Object.freeze({ matrix: branchMatrix, trust: branchTrust }),
        listener, gateway_executor: gatewayExecutor, evidence,
        budget_authority: budget,
        now: () => NOW,
      }),
      now: () => NOW,
    });
    const run = await executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: dependencies.dependencies,
    }).catch((error: unknown) => {
      if (error instanceof Error) {
        const snapshots = prepare.episodes.flatMap((episode) => {
          try { return [control.snapshot(episode.episode_id)]; } catch { return []; }
        });
        throw new Error(`${error.message}; clients=${clientOrdinal}; snapshots=${canonicalJson(snapshots.map((snapshot) => ({ episode_id: snapshot.episode_id, opportunities: snapshot.opportunities, pending_gateway_actions: snapshot.pending_gateway_actions })))}`);
      }
      throw error;
    });
    if (run.status === "failed") {
      if (listenerFailure) throw listenerFailure;
      if (gatewayExecutorFailure instanceof Error) throw gatewayExecutorFailure;
      const primaryReference = run.ledger.find((event) =>
        event.event_type === "opportunity_failed")?.evidence_references.find((candidate) =>
        candidate.kind === "failure_evidence");
      const cleanupReference = run.ledger.flatMap((event) => event.evidence_references)
        .filter((candidate) => candidate.kind === "failure_evidence")
        .at(-1);
      const reference = primaryReference ?? cleanupReference;
      if (reference) throw new Error(canonicalJson(await dependencies.evidence.resolveJson(reference)));
    }
    await dependencies.finalize();
    expect(run.status, canonicalJson(run)).toBe("completed");
    expect(run.opportunities_completed).toBe(360);
    expect(run.repair_playbacks).toBe(1);
    expect(clientOrdinal).toBe(36);
    expect(emittedProviderCallIds.size).toBeGreaterThan(0);
    expect([...emittedProviderCallIds.values()].some((count) => count > 1)).toBe(true);
    expect(repairToolAttemptEmitted).toBe(true);
    expect(repairToolExecutorCountBefore).not.toBeNull();
    expect(repairToolExecutorCountAfter).toBe(repairToolExecutorCountBefore);

    const episodeTerminalEvents = run.ledger.filter((event) =>
      event.event_type === "episode_terminal");
    expect(episodeTerminalEvents).toHaveLength(6);
    const episodeFinalizationReferences = episodeTerminalEvents.map((event) => {
      const references = event.evidence_references.filter((reference) =>
        reference.kind === "episode_finalization");
      expect(references).toHaveLength(1);
      return references[0]!;
    });
    const episodeFinalizations = await Promise.all(
      episodeFinalizationReferences.map((reference) =>
        dependencies.evidence.resolveJson(reference) as Promise<Record<string, unknown>>),
    );
    const segmentFinalizationReferences = episodeFinalizations.flatMap((finalization) => {
      const references = finalization.segment_finalizations as readonly Readonly<{
        kind: string;
        evidence_sha256: string;
      }>[];
      expect(references).toHaveLength(6);
      expect(finalization.segment_terminal_bindings).toHaveLength(6);
      return references;
    });
    expect(segmentFinalizationReferences).toHaveLength(36);
    const segmentFinalizations = await Promise.all(
      segmentFinalizationReferences.map((reference) =>
        dependencies.evidence.resolveJson(reference as never) as Promise<Record<string, unknown>>),
    );
    const connectionScopeHashes = new Set<string>();
    for (const finalization of segmentFinalizations) {
      expect(finalization.schema_version).toBe(7);
      expect(finalization.opportunity_count).toBe(10);
      expect(finalization.opportunity_root_chain).toHaveLength(10);
      const scope = finalization.provider_connection_scope as Readonly<Record<string, unknown>>;
      const attestation = scope.connection_attestation as Readonly<Record<string, unknown>>;
      expect(scope.schema_version).toBe(2);
      expect(Number(scope.opportunity_end) - Number(scope.opportunity_start)).toBe(9);
      expect(scope.connection_scope_sha256).toBe(finalization.provider_connection_scope_sha256);
      expect(attestation.attestation_sha256).toBe(finalization.provider_connection_attestation_sha256);
      expect(attestation.provider_session_identity_status).toBe(
        finalization.provider === "gemini" ? "provider_protocol_omitted" : "acknowledged",
      );
      if (finalization.provider === "gemini") {
        expect(attestation.provider_session_id_sha256).toBeNull();
      } else {
        expect(attestation.provider_session_id_sha256).toEqual(
          expect.stringMatching(/^[a-f0-9]{64}$/u),
        );
      }
      connectionScopeHashes.add(String(scope.connection_scope_sha256));
    }
    expect(connectionScopeHashes.size).toBe(36);

    const runTerminalEvents = run.ledger.filter((event) =>
      event.event_type === "run_terminal");
    expect(runTerminalEvents).toHaveLength(1);
    expect(run.ledger.at(-1)?.event_sha256).toBe(runTerminalEvents[0]!.event_sha256);
    const runAuthorityReferences = runTerminalEvents[0]!.evidence_references.filter((reference) =>
      reference.kind === "run_terminal_authority");
    expect(runAuthorityReferences).toHaveLength(1);
    const runAuthority = await dependencies.evidence.resolveJson(
      runAuthorityReferences[0]!,
    ) as Record<string, unknown>;
    expect(runAuthority.ordered_episode_finalization_sha256s).toHaveLength(6);
    expect(runAuthority.ordered_episode_authority_sha256s).toHaveLength(6);
    expect(runAuthority.ordered_segment_finalization_sha256s).toHaveLength(36);
    expect(runAuthority.ordered_segment_binding_sha256s).toHaveLength(36);

    const repairEvents = run.ledger.filter((event) =>
      event.event_type === "repair_completed");
    expect(repairEvents).toHaveLength(1);
    const repairPayload = await dependencies.evidence.resolveJson(
      repairEvents[0]!.payload_evidence,
    ) as Record<string, unknown>;
    const repairExchangeSha256 = String(repairPayload.repair_exchange_sha256);
    const repairExchangeReference = repairEvents[0]!.evidence_references.find((reference) =>
      reference.kind === "provider_exchange"
      && reference.evidence_sha256 === repairExchangeSha256);
    expect(repairExchangeReference).toBeDefined();
    const repairExchangeProjection = await dependencies.evidence.resolveJson(
      repairExchangeReference!,
    ) as Record<string, unknown>;
    const repairGatewayBatches = repairExchangeProjection.dev_gateway_conversation_tool_batches as readonly Readonly<{
      calls: readonly Readonly<{
        source_kind: string;
        disposition: string;
        pre_dispatch_rejection_code: string | null;
      }>[];
    }>[];
    const repairGatewayCalls = repairGatewayBatches.flatMap((batch) => batch.calls);
    expect(repairGatewayCalls).toEqual([expect.objectContaining({
      source_kind: "pre_dispatch_rejection",
      disposition: "pre_dispatch_rejected",
      pre_dispatch_rejection_code: "tool_calls_forbidden_during_repair",
    })]);

    const publication = await replayLc4PublicationTransportEvidence({
      prepare,
      preflight,
      run,
      cas_root_dir: casRoot,
      expected_authority_trust_root_sha256: operator.public_key_fingerprint_sha256,
    });
    expect(publication.provider_session_count).toBe(36);
    expect(publication.canonical_provider_exchange_count).toBe(360);
    expect(publication.repair_provider_exchange_count).toBe(1);
    expect(publication.total_response_generation_count).toBe(361);
    expect(publication.episodes).toHaveLength(6);
    expect(publication.episodes.find((episode) =>
      episode.episode_id === repairEpisodeId)?.repair_provider_exchange_count).toBe(1);
    expect(publication.episodes.filter((episode) =>
      episode.episode_id !== repairEpisodeId).every((episode) =>
      episode.repair_provider_exchange_count === 0)).toBe(true);
    expect(publication.episodes.every((episode) => !("entries" in episode))).toBe(true);
    expect(canonicalJson(publication)).not.toContain("signed_invocation_artifact_cas_sha256");

    const scopedFinalizationReference = segmentFinalizationReferences[0]!;
    const scopedFinalizationPath = resolve(
      casRoot,
      scopedFinalizationReference.evidence_sha256.slice(0, 2),
      scopedFinalizationReference.evidence_sha256,
    );
    const originalScopedFinalizationBytes = await readFile(scopedFinalizationPath);
    await chmod(scopedFinalizationPath, 0o600);
    const tamperedScopeFinalization = JSON.parse(
      canonicalJson(segmentFinalizations[0] as never),
    ) as Record<string, unknown>;
    const tamperedScope = tamperedScopeFinalization.provider_connection_scope as Record<string, unknown>;
    tamperedScope.execution_id_sha256 = sha256Hex("publication-scope-substitution");
    await writeFile(scopedFinalizationPath, canonicalJson(tamperedScopeFinalization as never));
    await expect(replayLc4PublicationTransportEvidence({
      prepare,
      preflight,
      run,
      cas_root_dir: casRoot,
      expected_authority_trust_root_sha256: operator.public_key_fingerprint_sha256,
    })).rejects.toThrow(/CAS artifact content does not match its address/u);
    await writeFile(scopedFinalizationPath, originalScopedFinalizationBytes);

    const tamperedSessionFinalization = JSON.parse(
      canonicalJson(segmentFinalizations[0] as never),
    ) as Record<string, unknown>;
    const tamperedSessionScope = tamperedSessionFinalization.provider_connection_scope as Record<string, unknown>;
    const tamperedAttestation = tamperedSessionScope.connection_attestation as Record<string, unknown>;
    tamperedAttestation.provider_session_id_sha256 = sha256Hex("publication-session-substitution");
    await writeFile(scopedFinalizationPath, canonicalJson(tamperedSessionFinalization as never));
    await expect(replayLc4PublicationTransportEvidence({
      prepare,
      preflight,
      run,
      cas_root_dir: casRoot,
      expected_authority_trust_root_sha256: operator.public_key_fingerprint_sha256,
    })).rejects.toThrow(/CAS artifact content does not match its address/u);
    await writeFile(scopedFinalizationPath, originalScopedFinalizationBytes);
    await chmod(scopedFinalizationPath, 0o400);

    const eventHashTamperedLedger = Object.freeze(run.ledger.map((event, index) => index === 0
      ? Object.freeze({
          ...event,
          event_sha256: sha256Hex("publication-generic-event-hash-tamper"),
        })
      : event));
    const {
      run_sha256: _originalRunSha256,
      ...eventHashTamperedRunBody
    } = Object.freeze({
      ...run,
      ledger: eventHashTamperedLedger,
    });
    expect(_originalRunSha256).toBe(run.run_sha256);
    const eventHashTamperedRun = Object.freeze({
      ...eventHashTamperedRunBody,
      run_sha256: sha256Hex(
        `harshas-amazing-call-center/lc4-dev-live-run/v3\n${canonicalJson(eventHashTamperedRunBody as never)}`,
      ),
    }) as typeof run;
    await expect(replayLc4PublicationTransportEvidence({
      prepare,
      preflight,
      run: eventHashTamperedRun,
      cas_root_dir: casRoot,
      expected_authority_trust_root_sha256: operator.public_key_fingerprint_sha256,
    })).rejects.toThrow(/ledger event/u);

    const firstCompletedIndex = run.ledger.findIndex((event) =>
      event.event_type === "opportunity_completed");
    expect(firstCompletedIndex).toBeGreaterThanOrEqual(0);
    const firstCompleted = run.ledger[firstCompletedIndex]!;
    const tamperedRun = Object.freeze({
      ...run,
      ledger: Object.freeze(run.ledger.map((event, index) => index === firstCompletedIndex
        ? Object.freeze({
            ...event,
            payload_evidence: Object.freeze({
              ...event.payload_evidence,
              evidence_sha256: sha256Hex("publication-ledger-edge-tamper"),
            }),
          })
        : event)),
    }) as typeof run;
    await expect(replayLc4PublicationTransportEvidence({
      prepare,
      preflight,
      run: tamperedRun,
      cas_root_dir: casRoot,
      expected_authority_trust_root_sha256: operator.public_key_fingerprint_sha256,
    })).rejects.toThrow();

    const listenerReference = firstCompleted.evidence_references.find((reference) =>
      reference.kind === "listener_evidence");
    expect(listenerReference).toBeDefined();
    const listenerProjection = await dependencies.evidence.resolveJson(listenerReference!);
    const listenerEvaluation = (listenerProjection as Record<string, unknown>).evaluation as Record<string, unknown>;
    const invocationCasSha256 = String(listenerEvaluation.signed_invocation_artifact_cas_sha256);
    expect(invocationCasSha256).toMatch(/^[0-9a-f]{64}$/u);
    await chmod(
      resolve(casRoot, invocationCasSha256.slice(0, 2), invocationCasSha256),
      0o600,
    );
    await writeFile(
      resolve(casRoot, invocationCasSha256.slice(0, 2), invocationCasSha256),
      Buffer.from("{}", "utf8"),
    );
    await expect(replayLc4PublicationTransportEvidence({
      prepare,
      preflight,
      run,
      cas_root_dir: casRoot,
      expected_authority_trust_root_sha256: operator.public_key_fingerprint_sha256,
    })).rejects.toThrow(/CAS artifact content does not match its address/u);
  }, 120_000);
});
