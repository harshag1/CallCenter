import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "./artifacts";
import { prepareCallerAudioFixture } from "./audio-fixture-generator";
import { loadFrozenCallerAudioForPaidTrial } from "./audio-fixtures";
import { createLc4ImmutableCas } from "./lc4-development-live-dependencies";
import {
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
} from "./lc4-development-gateway-bridge";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import {
  trialAudioDeliveryProfileHash,
  type TrialAudioDeliveryProfile,
} from "./orchestrator";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  Pcm16Audio,
  RealtimeToolCall,
  RealtimeTransportFailureDiagnostic,
  RealtimeWireObservation,
} from "../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  PROVIDER_PROVENANCE_META_KEY,
} from "../realtime/client/types";
import { assertRealtimeTransportFailureDiagnostic } from "../realtime/client/transport-diagnostics";
import {
  realtimeWireIdentitySha256,
  verifyRealtimeWireObservationChain,
} from "../realtime/client/wire-evidence";
import {
  XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR,
  realtimeToolFrontierSha256,
} from "../realtime/client/openai-compatible";
import {
  LC4_XAI_SERVER_VAD_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
  LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
  isAcceptedXaiServerVadSilenceTail,
} from "./xai-server-vad";
import {
  replayProviderToolRoundtrip,
  projectRoundtripInputAudioEvidence,
  projectRoundtripOutputAudioEvidence,
  projectRoundtripPreToolOutputQuarantineEvidence,
  roundtripInputAudioChunkListSha256,
  roundtripCausalBindingSha256,
  roundtripSanitizedUsageSha256,
  type RoundtripCausalBinding,
  type RoundtripInputAudioEvidence,
  type RoundtripOutputAudioEvidence,
  type RoundtripPreToolOutputQuarantineEvidence,
  type RoundtripReplaySummary,
  type RoundtripSanitizedUsage,
  type RoundtripUsageCounter,
} from "./provider-roundtrip-replay";
import {
  RealtimeAudioDeliveryError,
  SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
  deliverRealtimePcm16,
  packetizeRealtimePcm16,
  type RealtimeAudioDeliveryRuntime,
} from "../realtime/audio-delivery";

export const LC4_S2S_ROUNDTRIP_VERSION = "HACC-LC4-S2S-TOOL-ROUNDTRIP-v6" as const;
export const LC4_S2S_AUDIO_FIXTURE_VERSION = "HACC-LC4-S2S-SPOKEN-FIXTURE-v1" as const;
export const LC4_S2S_SOURCE_TEXT = "Please complete the current stage." as const;
export const LC4_S2S_SOURCE_TEXT_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-s2s-spoken-request/v1\n${LC4_S2S_SOURCE_TEXT}`,
);
export const LC4_S2S_VOICE = Object.freeze({
  engine: "macos-say" as const,
  name: "Samantha" as const,
  locale: "en_US" as const,
  words_per_minute: 195 as const,
});
export const LC4_S2S_VOICE_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-s2s-voice/v1\n${canonicalJson(LC4_S2S_VOICE)}`,
);
export const LC4_S2S_TOOL = LC4_DEV_SEMANTIC_GATEWAY_FUNCTION;
export const LC4_S2S_TOOL_SCHEMA_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-s2s-tool-schema/v1\n${canonicalJson(LC4_S2S_TOOL)}`,
);
export const LC4_S2S_COMPACT_CONTROL = [
  "Listen to the caller's spoken request.",
  "If the caller asks to complete the current stage, call capability_gateway exactly once with tool_name complete_current_stage and arguments {}.",
  "Do not call another tool and do not speak before the tool call.",
  "After the tool result, briefly acknowledge completion.",
].join(" ");
export const LC4_S2S_COMPACT_CONTROL_SHA256 = sha256Hex(
  LC4_S2S_COMPACT_CONTROL,
);
export const LC4_S2S_REFERENCE_LARGE_CONTROL_BYTES = 35_518 as const;
export const LC4_S2S_PACKETIZER_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-s2s-audio-delivery/v1\n${canonicalJson({
    packetizer: "packetizeRealtimePcm16",
    delivery: "deliverRealtimePcm16",
    profile: { schemaVersion: 1, chunkMs: 20, pace: "realtime" },
  })}`,
);

const execFileAsync = promisify(execFile);
const CAS_DOMAIN = "harshas-amazing-call-center/lc4-s2s-pcm-object/v1\n";
const FIXTURE_DOMAIN = "harshas-amazing-call-center/lc4-s2s-spoken-fixture-artifact/v1\n";
const ROUNDTRIP_EVIDENCE_DOMAIN = "harshas-amazing-call-center/lc4-s2s-roundtrip-evidence/v6\n";
const ROUNDTRIP_FAILURE_DOMAIN = "harshas-amazing-call-center/lc4-s2s-roundtrip-failure/v6\n";
const CONTROL_DIAGNOSTIC_DOMAIN = "harshas-amazing-call-center/lc4-s2s-control-size-diagnostic/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;
const ROUNDTRIP_USAGE_COUNTERS = new Set<RoundtripUsageCounter>([
  "inputTextTokens",
  "inputAudioTokens",
  "cachedInputTokens",
  "cachedInputTextTokens",
  "cachedInputAudioTokens",
  "outputTextTokens",
  "outputAudioTokens",
  "totalInputTokens",
  "totalOutputTokens",
  "totalTokens",
  "inputAudioMinutes",
  "outputAudioMinutes",
  "billableTextInputEvents",
]);

export type Lc4S2sPcmObject = Readonly<{
  path: string;
  sha256: string;
  cas_sha256: string;
  cas_receipt_sha256: string;
  byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  channels: 1;
  encoding: "pcm16le";
  duration_ms: number;
}>;

export type Lc4S2sAudioFixtureArtifact = Readonly<{
  schema_version: 1;
  fixture_version: typeof LC4_S2S_AUDIO_FIXTURE_VERSION;
  source_text_sha256: typeof LC4_S2S_SOURCE_TEXT_SHA256;
  voice: typeof LC4_S2S_VOICE;
  voice_sha256: typeof LC4_S2S_VOICE_SHA256;
  tool_schema_sha256: typeof LC4_S2S_TOOL_SCHEMA_SHA256;
  base_fixture_manifest_sha256: string;
  toolchain_sha256: string;
  renderer_identity_sha256: string;
  provider_renditions: Readonly<Record<LiveStsProvider, Lc4S2sPcmObject>>;
  artifact_sha256: string;
}>;

export type Lc4S2sAudioRenderer = Readonly<{
  identitySha256: string;
  render(text: typeof LC4_S2S_SOURCE_TEXT): Promise<Readonly<{
    pcm16k: Uint8Array;
    pcm24k: Uint8Array;
  }>>;
}>;

export type Lc4S2sControlSizeDiagnostic = Readonly<{
  schema_version: 1;
  diagnostic_id: "HACC-LC4-CONTROL-SIZE-DIAGNOSTIC-v1";
  qualification_gate: false;
  compact_control_bytes: number;
  compact_control_sha256: typeof LC4_S2S_COMPACT_CONTROL_SHA256;
  reference_large_control_bytes: typeof LC4_S2S_REFERENCE_LARGE_CONTROL_BYTES;
  bytes_removed: number;
  compact_fraction_ppm: number;
  diagnostic_sha256: string;
}>;

export type Lc4S2sRoundtripFailureClass =
  | "none"
  | "session_setup_failed"
  | "audio_delivery_failed"
  | "audio_delivery_contract_failed"
  | "input_audio_replay_invalid"
  | "response_trigger_failed"
  | "commit_acknowledgement_failed"
  | "manual_turn_mode_violation"
  | "response_before_explicit_trigger"
  | "server_vad_control_ack_missing"
  | "server_vad_speech_start_missing"
  | "server_vad_speech_stop_missing"
  | "server_vad_delimiter_exhausted"
  | "server_vad_auto_commit_missing"
  | "server_vad_auto_response_missing"
  | "server_vad_event_order_invalid"
  | "server_vad_response_before_speech_stop"
  | "forbidden_manual_commit_sent"
  | "forbidden_initial_response_create_sent"
  | "unexpected_idle_timeout_trigger"
  | "dynamic_control_not_wire_observed"
  | "speech_before_tool"
  | "wrong_tool"
  | "wrong_arguments"
  | "competing_tool_call"
  | "tool_result_submission_failed"
  | "tool_result_event_missing"
  | "tool_result_not_wire_observed"
  | "post_tool_continuation_missing"
  | "post_tool_output_audio_missing_or_invalid"
  | "post_tool_terminal_missing"
  | "post_tool_usage_missing"
  | "post_tool_usage_evidence_invalid"
  | "causal_replay_evidence_invalid"
  | "provider_error"
  | "timeout";

export type Lc4S2sRoundtripDeliveryReceipt = Readonly<{
  packetizer_sha256: typeof LC4_S2S_PACKETIZER_SHA256;
  delivery_profile_sha256: string;
  audio_sha256: string;
  audio_bytes: number;
  chunk_count: number;
  frame_bytes: number;
  tail_bytes: number;
  scheduled_offsets_ms: readonly number[];
}>;

export type Lc4S2sRoundtripExecution = Readonly<{
  schema_version: 3;
  roundtrip_version: typeof LC4_S2S_ROUNDTRIP_VERSION;
  provider: LiveStsProvider;
  model: string;
  attempted_at: string;
  completed_at: string;
  status: "passed" | "failed";
  failure_class: Lc4S2sRoundtripFailureClass;
  audio: Lc4S2sPcmObject;
  delivery: Lc4S2sRoundtripDeliveryReceipt | null;
  input_audio_evidence: RoundtripInputAudioEvidence | null;
  output_audio_evidence: RoundtripOutputAudioEvidence | null;
  pre_tool_output_quarantine: RoundtripPreToolOutputQuarantineEvidence | null;
  compact_control_sha256: typeof LC4_S2S_COMPACT_CONTROL_SHA256;
  tool_schema_sha256: typeof LC4_S2S_TOOL_SCHEMA_SHA256;
  response_generation_requested: boolean;
  provider_auto_response_observed: boolean;
  turn_boundary_mode: "manual_commit" | "provider_activity_markers" | "provider_native_server_vad";
  server_vad_setting_sha256: string | null;
  server_vad_transport_disclosure_sha256: string | null;
  transport_parity_sha256: string | null;
  tool_frontier_sha256: string;
  per_turn_session_update_observation_sha256: string | null;
  per_turn_session_ack_observation_sha256: string | null;
  server_vad_speech_start_observation_sha256: string | null;
  server_vad_speech_stop_observation_sha256: string | null;
  server_vad_auto_commit_observation_sha256: string | null;
  server_vad_auto_response_observation_sha256: string | null;
  transport_failure_diagnostic: RealtimeTransportFailureDiagnostic | null;
  manual_turn_commit_observation_sha256: string | null;
  response_trigger_observation_sha256: string | null;
  tool_call_observed: boolean;
  tool_result_submitted: boolean;
  tool_result_event_observed: boolean;
  tool_result_wire_observed: boolean;
  post_tool_continuation_requested: boolean;
  post_tool_continuation_observed: boolean;
  post_tool_terminal_observed: boolean;
  post_tool_usage_observed: boolean;
  provider_tool_call_evidence_sha256: string | null;
  tool_result_evidence_sha256: string | null;
  wire_observations: readonly RealtimeWireObservation[];
  usage: readonly NormalizedRealtimeUsage[];
  replay_summary: RoundtripReplaySummary | null;
  replay_causal_binding: RoundtripCausalBinding | null;
  sanitized_usage: readonly RoundtripSanitizedUsage[];
  public_execution_sha256: string | null;
  replay_sha256: string | null;
  operation_order: readonly string[];
  failure_evidence_sha256: string;
  evidence_sha256: string;
}>;

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

async function writeImmutable(path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o400 });
  try {
    await link(temporary, path);
    await chmod(path, 0o400);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function inspectPcm(bytes: Uint8Array, sampleRateHz: 16_000 | 24_000): Omit<Lc4S2sPcmObject, "path"> {
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) throw new Error("LC4 S2S renderer returned invalid PCM16LE");
  const durationMs = bytes.byteLength / 2 / sampleRateHz * 1_000;
  if (durationMs < 1_000 || durationMs > 2_000) throw new Error("LC4 S2S spoken request must be 1 to 2 seconds");
  const sha256 = sha256Hex(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let peak = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  if (peak < 128) throw new Error("LC4 S2S spoken request is silent");
  return freeze({
    sha256,
    cas_sha256: sha256Hex(`${CAS_DOMAIN}${sha256}`),
    cas_receipt_sha256: sha256Hex(`${CAS_DOMAIN}injected-test-receipt\n${sha256}`),
    byte_length: bytes.byteLength,
    sample_rate_hz: sampleRateHz,
    channels: 1 as const,
    encoding: "pcm16le" as const,
    duration_ms: Number(durationMs.toFixed(3)),
  });
}

export function lc4S2sControlSizeDiagnostic(): Lc4S2sControlSizeDiagnostic {
  const compactBytes = Buffer.byteLength(LC4_S2S_COMPACT_CONTROL, "utf8");
  const body = freeze({
    schema_version: 1 as const,
    diagnostic_id: "HACC-LC4-CONTROL-SIZE-DIAGNOSTIC-v1" as const,
    qualification_gate: false as const,
    compact_control_bytes: compactBytes,
    compact_control_sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
    reference_large_control_bytes: LC4_S2S_REFERENCE_LARGE_CONTROL_BYTES,
    bytes_removed: LC4_S2S_REFERENCE_LARGE_CONTROL_BYTES - compactBytes,
    compact_fraction_ppm: Math.round(compactBytes / LC4_S2S_REFERENCE_LARGE_CONTROL_BYTES * 1_000_000),
  });
  return freeze({ ...body, diagnostic_sha256: sha256Hex(`${CONTROL_DIAGNOSTIC_DOMAIN}${canonicalJson(body)}`) });
}

export async function createSystemLc4S2sAudioRenderer(input: Readonly<{
  ffmpegPath?: string;
}> = {}): Promise<Lc4S2sAudioRenderer> {
  const sayPath = "/usr/bin/say";
  const ffmpegPath = resolve(input.ffmpegPath ?? "/opt/homebrew/bin/ffmpeg");
  const [sayBytes, ffmpegBytes] = await Promise.all([readFile(sayPath), readFile(ffmpegPath)]);
  const identitySha256 = sha256Hex(`harshas-amazing-call-center/lc4-s2s-renderer/v1\n${canonicalJson({
    say_path: sayPath,
    say_sha256: sha256Hex(sayBytes),
    ffmpeg_path: ffmpegPath,
    ffmpeg_sha256: sha256Hex(ffmpegBytes),
    voice: LC4_S2S_VOICE,
  })}`);
  return freeze({
    identitySha256,
    async render(text) {
      if (text !== LC4_S2S_SOURCE_TEXT) throw new Error("LC4 S2S renderer received uncommitted source text");
      const workspace = await mkdtemp(resolve(tmpdir(), "hacc-lc4-s2s-render-"));
      const aiff = resolve(workspace, "spoken-request.aiff");
      const pcm16k = resolve(workspace, "spoken-request.16000.pcm");
      const pcm24k = resolve(workspace, "spoken-request.24000.pcm");
      await execFileAsync(sayPath, ["-v", LC4_S2S_VOICE.name, "-r", String(LC4_S2S_VOICE.words_per_minute), "-o", aiff, text]);
      for (const [rate, output] of [[16_000, pcm16k], [24_000, pcm24k]] as const) {
        await execFileAsync(ffmpegPath, [
          "-nostdin", "-loglevel", "error", "-nostats", "-y", "-i", aiff,
          "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
          "-af", `aresample=${rate}:resampler=soxr:precision=28:dither_method=none`,
          "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(rate), output,
        ], { maxBuffer: 1024 * 1024 });
      }
      return freeze({
        pcm16k: new Uint8Array(await readFile(pcm16k)),
        pcm24k: new Uint8Array(await readFile(pcm24k)),
      });
    },
  });
}

export async function materializeLc4S2sAudioFixture(input: Readonly<{
  root: string;
  renderer?: Lc4S2sAudioRenderer;
}>): Promise<Lc4S2sAudioFixtureArtifact> {
  const root = resolve(input.root);
  if (input.renderer === undefined) return materializeProductionLc4S2sAudioFixture(root);
  const renderer = input.renderer;
  if (!SHA256.test(renderer.identitySha256)) throw new Error("LC4 S2S renderer identity is invalid");
  const rendered = await renderer.render(LC4_S2S_SOURCE_TEXT);
  const objects = {
    16_000: inspectPcm(rendered.pcm16k, 16_000),
    24_000: inspectPcm(rendered.pcm24k, 24_000),
  } as const;
  const install = async (rate: 16_000 | 24_000, bytes: Uint8Array): Promise<Lc4S2sPcmObject> => {
    const object = objects[rate];
    const path = `fixtures/objects/sha256/${object.sha256.slice(0, 2)}/${object.sha256}.pcm`;
    await writeImmutable(resolve(root, path), bytes);
    return freeze({ path, ...object });
  };
  const [pcm16, pcm24] = await Promise.all([
    install(16_000, rendered.pcm16k),
    install(24_000, rendered.pcm24k),
  ]);
  const body = freeze({
    schema_version: 1 as const,
    fixture_version: LC4_S2S_AUDIO_FIXTURE_VERSION,
    source_text_sha256: LC4_S2S_SOURCE_TEXT_SHA256,
    voice: LC4_S2S_VOICE,
    voice_sha256: LC4_S2S_VOICE_SHA256,
    tool_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
    base_fixture_manifest_sha256: sha256Hex(`${FIXTURE_DOMAIN}injected-test-fixture\n${renderer.identitySha256}`),
    toolchain_sha256: renderer.identitySha256,
    renderer_identity_sha256: renderer.identitySha256,
    provider_renditions: freeze({ openai: pcm24, gemini: pcm16, xai: pcm24 }),
  });
  const artifact = freeze({ ...body, artifact_sha256: sha256Hex(`${FIXTURE_DOMAIN}${canonicalJson(body)}`) });
  await writeImmutable(resolve(root, "fixtures", "spoken-request.json"), `${canonicalJson(artifact)}\n`);
  return artifact;
}

async function materializeProductionLc4S2sAudioFixture(root: string): Promise<Lc4S2sAudioFixtureArtifact> {
  const sourceRoot = resolve(root, "fixtures", "frozen-source");
  const scenario = freeze({
    id: "lc4-qualification-v3-spoken-request",
    version: "1",
    canonical_sha256: sha256Hex(`harshas-amazing-call-center/lc4-s2s-scenario/v1\n${LC4_S2S_SOURCE_TEXT_SHA256}`),
  });
  const turns = freeze([{ id: "complete-current-stage-v1", text: LC4_S2S_SOURCE_TEXT, pause_after_ms: 0 }]);
  const manifest = await prepareCallerAudioFixture({
    phase: "fixture-preparation",
    rootDirectory: sourceRoot,
    scenario,
    turns,
    voice: LC4_S2S_VOICE.name,
    rateWpm: LC4_S2S_VOICE.words_per_minute,
    ffmpegExecutable: "/opt/homebrew/bin/ffmpeg",
  });
  const verified = await loadFrozenCallerAudioForPaidTrial({
    rootDirectory: sourceRoot,
    expectedScenario: scenario,
    expectedTurns: turns,
    expectedManifestSha256: manifest.manifest_sha256,
  });
  const cas = await createLc4ImmutableCas(resolve(root, "fixtures", "cas"));
  const createObject = async (
    rate: 16_000 | 24_000,
    rendition: "pcm16le_mono_16000" | "pcm16le_mono_24000",
  ): Promise<Lc4S2sPcmObject> => {
    const bytes = verified.readPcm(turns[0]!.id, rendition);
    const inspected = inspectPcm(bytes, rate);
    const receipt = await cas.put(bytes, "audio/pcm");
    const reloaded = await cas.get(receipt.artifact_sha256);
    if (sha256Hex(reloaded) !== inspected.sha256 || receipt.artifact_sha256 !== inspected.sha256) {
      throw new Error("LC4 S2S qualification CAS read-after-write verification failed");
    }
    return freeze({
      ...inspected,
      path: `fixtures/cas/${receipt.relative_path}`,
      cas_sha256: receipt.artifact_sha256,
      cas_receipt_sha256: receipt.receipt_sha256,
    });
  };
  const [pcm16, pcm24] = await Promise.all([
    createObject(16_000, "pcm16le_mono_16000"),
    createObject(24_000, "pcm16le_mono_24000"),
  ]);
  const toolchainSha256 = sha256Hex(`harshas-amazing-call-center/lc4-s2s-toolchain/v1\n${canonicalJson(manifest.toolchain)}`);
  const body = freeze({
    schema_version: 1 as const,
    fixture_version: LC4_S2S_AUDIO_FIXTURE_VERSION,
    source_text_sha256: LC4_S2S_SOURCE_TEXT_SHA256,
    voice: LC4_S2S_VOICE,
    voice_sha256: LC4_S2S_VOICE_SHA256,
    tool_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
    base_fixture_manifest_sha256: manifest.manifest_sha256,
    toolchain_sha256: toolchainSha256,
    renderer_identity_sha256: sha256Hex(`${FIXTURE_DOMAIN}${manifest.manifest_sha256}\n${toolchainSha256}`),
    provider_renditions: freeze({ openai: pcm24, gemini: pcm16, xai: pcm24 }),
  });
  const artifact = freeze({ ...body, artifact_sha256: sha256Hex(`${FIXTURE_DOMAIN}${canonicalJson(body)}`) });
  await writeImmutable(resolve(root, "fixtures", "spoken-request.json"), `${canonicalJson(artifact)}\n`);
  return artifact;
}

export async function loadLc4S2sPcm(input: Readonly<{
  root: string;
  artifact: Lc4S2sAudioFixtureArtifact;
  provider: LiveStsProvider;
}>): Promise<Pcm16Audio> {
  const object = input.artifact.provider_renditions[input.provider];
  const path = resolve(input.root, object.path);
  const objectRoot = resolve(input.root, "fixtures", "objects", "sha256");
  const productionCasRoot = resolve(input.root, "fixtures", "cas");
  if (!path.startsWith(`${objectRoot}/`) && !path.startsWith(`${productionCasRoot}/`)) {
    throw new Error("LC4 S2S PCM path escapes the fixture CAS");
  }
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength !== object.byte_length || sha256Hex(bytes) !== object.sha256) {
    throw new Error("LC4 S2S PCM CAS object failed integrity");
  }
  return freeze({ encoding: "pcm16" as const, sampleRateHz: object.sample_rate_hz, channels: 1 as const, data: bytes });
}

function exactToolCall(event: NormalizedRealtimeEvent): Readonly<{
  call: RealtimeToolCall;
  observationSha256: string;
}> | Lc4S2sRoundtripFailureClass | null {
  if (event.type !== "tool.calls" && event.type !== "tool.dispatch") return null;
  const calls: readonly RealtimeToolCall[] = event.type === "tool.calls"
    ? event.calls
    : event.dispatches.map((dispatch): RealtimeToolCall => ({
        callId: dispatch.callId,
        name: event.gateway,
        argumentsText: canonicalJson({
          tool_name: dispatch.request.params.name,
          arguments: dispatch.request.params.arguments,
        }),
        argumentsJson: {
          tool_name: dispatch.request.params.name,
          arguments: dispatch.request.params.arguments,
        },
        responseId: event.responseId,
        responseIdSource: "provider",
        ...(dispatch.provenance.nativeItemId === undefined
          ? {}
          : { itemId: dispatch.provenance.nativeItemId }),
        ...(dispatch.provenance.terminalEventId === undefined
          ? {}
          : { terminalEventId: dispatch.provenance.terminalEventId }),
        terminalWireType: dispatch.provenance.terminalWireType,
      }));
  if (calls.length !== 1) return "competing_tool_call";
  const call = calls[0]!;
  if (event.type === "tool.dispatch") {
    const dispatch = event.dispatches[0]!;
    const providerCallId = dispatch.request.params._meta[LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY];
    const requestProvenance = dispatch.request.params._meta[PROVIDER_PROVENANCE_META_KEY];
    if (dispatch.provenance.nativeCallId !== dispatch.callId
      || dispatch.provenance.nativeResponseId !== event.responseId
      || dispatch.provenance.provider !== event.provider
      || dispatch.provenance.terminalWireType !== event.wireType
      || dispatch.provenance.terminalEventId !== event.nativeEventId
      || providerCallId !== dispatch.callId
      || canonicalJson(requestProvenance) !== canonicalJson(dispatch.provenance)
      || dispatch.request.method !== "tools/call") return "provider_error";
  }
  if (call.name !== LC4_S2S_TOOL.name) return "wrong_tool";
  if (call.argumentsJson === null
    || typeof call.argumentsJson !== "object"
    || Array.isArray(call.argumentsJson)) return "wrong_arguments";
  const argumentsJson = call.argumentsJson as Record<string, unknown>;
  if (argumentsJson.tool_name !== "complete_current_stage"
    || argumentsJson.arguments === null
    || typeof argumentsJson.arguments !== "object"
    || Array.isArray(argumentsJson.arguments)
    || Object.keys(argumentsJson.arguments as Record<string, unknown>).length !== 0
    || Object.keys(argumentsJson).sort().join(",") !== "arguments,tool_name") return "wrong_arguments";
  if (event.wireObservation?.availability !== "observed") return "provider_error";
  return freeze({ call, observationSha256: event.wireObservation.observationSha256 });
}

function forcedToolChoice(provider: LiveStsProvider): Readonly<Record<string, unknown>> | undefined {
  if (provider === "gemini") return undefined;
  return freeze({ type: "function", name: LC4_S2S_TOOL.name });
}

function wirePcmUsage(
  observations: readonly RealtimeWireObservation[],
  scope: Readonly<{
    responseIdSha256: string;
    startedObservationSha256: string;
    terminalObservationSha256: string;
  }>,
): Readonly<{
  contributingObservationSha256s: readonly string[];
  counters: Readonly<Partial<Record<RoundtripUsageCounter, number>>>;
}> | null {
  const startIndex = observations.findIndex(({ observationSha256 }) => (
    observationSha256 === scope.startedObservationSha256
  ));
  const terminalIndex = observations.findIndex(({ observationSha256 }) => (
    observationSha256 === scope.terminalObservationSha256
  ));
  if (startIndex < 0 || terminalIndex <= startIndex) return null;
  const contributingObservationSha256s: string[] = [];
  const meter = { bytes: 0, sampleRateHz: null as number | null };
  for (const [index, observation] of observations.entries()) {
    if (index < startIndex || index >= terminalIndex
      || observation.direction !== "inbound"
      || (observation.wireType !== "response.audio.delta"
        && observation.wireType !== "response.output_audio.delta")) continue;
    if (observation.identities.responseIdSha256 !== scope.responseIdSha256) return null;
    const value = observation.projection.audio;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const audio = value as Record<string, unknown>;
    const chunks = Array.isArray(audio.chunks) ? audio.chunks : [audio];
    if ((audio.direction === "input" || audio.direction === "output")
      && audio.direction !== "output") return null;
    let observationBytes = 0;
    let observationSampleRateHz: number | null = null;
    for (const chunkValue of chunks) {
      if (chunkValue === null || typeof chunkValue !== "object" || Array.isArray(chunkValue)) {
        return null;
      }
      const chunk = chunkValue as Record<string, unknown>;
      const formatValue = chunk.format;
      if (formatValue === null || typeof formatValue !== "object" || Array.isArray(formatValue)) {
        return null;
      }
      const format = formatValue as Record<string, unknown>;
      if (chunk.validCanonicalBase64 !== true
        || typeof chunk.byteLength !== "number"
        || !Number.isSafeInteger(chunk.byteLength)
        || chunk.byteLength <= 0
        || chunk.byteLength % 2 !== 0
        || format.encoding !== "pcm16"
        || format.channels !== 1
        || typeof format.sampleRateHz !== "number"
        || !Number.isSafeInteger(format.sampleRateHz)
        || format.sampleRateHz <= 0) {
        return null;
      }
      if (observationSampleRateHz !== null && observationSampleRateHz !== format.sampleRateHz) return null;
      observationSampleRateHz = format.sampleRateHz;
      observationBytes += chunk.byteLength;
    }
    if (observationSampleRateHz === null) return null;
    if (meter.sampleRateHz !== null && meter.sampleRateHz !== observationSampleRateHz) return null;
    meter.sampleRateHz = observationSampleRateHz;
    meter.bytes += observationBytes;
    contributingObservationSha256s.push(observation.observationSha256);
  }
  if (contributingObservationSha256s.length === 0) return null;
  if (meter.sampleRateHz === null) return null;
  const counters: Partial<Record<RoundtripUsageCounter, number>> = {
    inputAudioMinutes: 0,
    outputAudioMinutes: meter.bytes / 2 / meter.sampleRateHz / 60,
  };
  return freeze({ contributingObservationSha256s, counters });
}

function providerWireUsage(
  observations: readonly RealtimeWireObservation[],
  observationSha256: string | null,
): Readonly<Partial<Record<RoundtripUsageCounter, number>>> | null {
  if (observationSha256 === null) return null;
  const observation = observations.find((candidate) => (
    candidate.observationSha256 === observationSha256
  ));
  const value = observation?.projection.usage;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const counters: Partial<Record<RoundtripUsageCounter, number>> = {};
  for (const [key, counter] of Object.entries(value as Record<string, unknown>)) {
    if (!ROUNDTRIP_USAGE_COUNTERS.has(key as RoundtripUsageCounter)
      || typeof counter !== "number"
      || !Number.isFinite(counter)
      || counter < 0) return null;
    counters[key as RoundtripUsageCounter] = counter;
  }
  return Object.keys(counters).length === 0 ? null : freeze(counters);
}

export async function executeLc4S2sToolRoundtrip(input: Readonly<{
  provider: LiveStsProvider;
  model: string;
  client: NormalizedRealtimeClient;
  audio: Pcm16Audio;
  audioObject: Lc4S2sPcmObject;
  profile: TrialAudioDeliveryProfile;
  runtime?: RealtimeAudioDeliveryRuntime;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}>): Promise<Lc4S2sRoundtripExecution> {
  const now = input.now ?? (() => new Date());
  const attemptedAt = now().toISOString();
  const timeoutMs = input.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 90_000) throw new Error("LC4 S2S roundtrip timeout must be 1000..90000ms");
  if (input.client.provider !== input.provider) throw new Error("LC4 S2S roundtrip provider mismatch");
  if (sha256Hex(input.audio.data) !== input.audioObject.sha256
    || input.audio.data.byteLength !== input.audioObject.byte_length
    || input.audio.sampleRateHz !== input.audioObject.sample_rate_hz) throw new Error("LC4 S2S roundtrip audio differs from its preregistered CAS object");
  const wire: RealtimeWireObservation[] = [];
  const usage: NormalizedRealtimeUsage[] = [];
  const operations: string[] = [];
  let failure: Lc4S2sRoundtripFailureClass = "none";
  let delivery: Lc4S2sRoundtripDeliveryReceipt | null = null;
  let inputAudioEvidence: RoundtripInputAudioEvidence | null = null;
  let outputAudioEvidence: RoundtripOutputAudioEvidence | null = null;
  let preToolOutputQuarantine: RoundtripPreToolOutputQuarantineEvidence | null = null;
  let responseRequested = false;
  let providerAutoResponseObserved = false;
  let transportFailureDiagnostic: RealtimeTransportFailureDiagnostic | null = null;
  let toolCall: RealtimeToolCall | null = null;
  let toolCallObservationSha256: string | null = null;
  let toolCallEvidenceSha256: string | null = null;
  let toolResultSubmitted = false;
  let toolResultEventObserved = false;
  let toolResultWireObservationSha256: string | null = null;
  let continuationRequested = false;
  let continuationObserved = false;
  let terminalObserved = false;
  let postToolUsageObserved = false;
  let continuationRequestObservationSha256: string | null = null;
  let continuationStartObservationSha256: string | null = null;
  let continuationResponseId: string | null = null;
  let terminalObservationSha256: string | null = null;
  let terminalResponseId: string | null = null;
  let usageObservationSha256: string | null = null;
  let usageResponseId: string | null = null;
  let retainedUsage: NormalizedRealtimeUsage | null = null;
  let triggerObservationSha256: string | null = null;
  let commitObservationSha256: string | null = null;
  let controlObservationSha256: string | null = null;
  let controlAckObservationSha256: string | null = null;
  let speechStartObservationSha256: string | null = null;
  let speechStopObservationSha256: string | null = null;
  let autoResponseObservationSha256: string | null = null;
  let rootResponseId: string | null = null;
  let rootResponseStartedObservationSha256: string | null = null;
  let rootResponseTerminalObservationSha256: string | null = null;
  let toolSubmissionQueued = false;
  const toolFrontierSha256 = realtimeToolFrontierSha256([LC4_S2S_TOOL]);
  const transportParitySha256 = input.provider === "xai"
    ? input.client.serverVadTransportParitySha256 ?? null
    : null;
  let finish!: () => void;
  const done = new Promise<void>((resolvePromise) => { finish = resolvePromise; });
  const expectedTrigger = input.provider === "gemini"
    ? "realtimeInput.activityEnd"
    : input.provider === "xai"
      ? "input_audio_buffer.speech_stopped"
      : "response.create";

  const unsubscribeWire = input.client.onWireObservation?.((observation) => {
    wire.push(observation);
    const dynamicControl = observation.projection.dynamicControl;
    if (dynamicControl !== null && typeof dynamicControl === "object" && !Array.isArray(dynamicControl)) {
      const record = dynamicControl as Record<string, unknown>;
      if (record.sha256 === LC4_S2S_COMPACT_CONTROL_SHA256
        && record.byteLength === Buffer.byteLength(LC4_S2S_COMPACT_CONTROL, "utf8")
        && record.authority === "advisory_only_gateway_and_speech_gate_enforced") {
        controlObservationSha256 ??= observation.observationSha256;
      }
    }
    if (triggerObservationSha256 === null
      && observation.direction === (input.provider === "xai" ? "inbound" : "outbound")
      && observation.wireType === expectedTrigger) {
      triggerObservationSha256 = observation.observationSha256;
    }
    if (input.provider === "xai" && observation.direction === "inbound") {
      if (observation.wireType === "input_audio_buffer.speech_started") {
        speechStartObservationSha256 ??= observation.observationSha256;
      } else if (observation.wireType === "input_audio_buffer.speech_stopped") {
        speechStopObservationSha256 ??= observation.observationSha256;
      } else if (observation.wireType === "response.created") {
        autoResponseObservationSha256 ??= observation.observationSha256;
      }
    }
    if (commitObservationSha256 === null
      && observation.direction === "inbound"
      && observation.wireType === "input_audio_buffer.committed") {
      commitObservationSha256 = observation.observationSha256;
    }
    if (toolResultSubmitted && toolCall !== null && toolResultWireObservationSha256 === null
      && observation.direction === "outbound"
      && observation.identities.callIdSha256 === realtimeWireIdentitySha256("call", toolCall.callId)
      && (observation.wireType === "conversation.item.create" || observation.wireType === "toolResponse")) {
      toolResultWireObservationSha256 = observation.observationSha256;
      operations.push("matching_tool_result_wire_observed");
    }
    if (toolResultWireObservationSha256 !== null
      && continuationRequestObservationSha256 === null
      && observation.direction === "outbound"
      && observation.wireType === "response.create") {
      continuationRequestObservationSha256 = observation.observationSha256;
    }
  });
  const maybeFinish = () => {
    if (toolResultWireObservationSha256
      && toolResultEventObserved
      && (input.provider === "gemini" || continuationRequested)
      && continuationObserved
      && terminalObserved
      && postToolUsageObserved) finish();
  };
  const scheduleToolResultSubmission = () => {
    if (toolSubmissionQueued || failure !== "none" || toolCall === null) return;
    if (input.provider === "xai" && rootResponseTerminalObservationSha256 === null) return;
    toolSubmissionQueued = true;
    queueMicrotask(() => {
      if (failure !== "none" || toolCall === null) return;
      try {
        toolResultSubmitted = true;
        input.client.submitToolResults([{
          callId: toolCall.callId,
          output: { ok: true, qualification_stage: "completed" },
        }], false);
        operations.push("matching_tool_result_submitted");
        if (input.provider !== "gemini") {
          input.client.createResponse({ tool_choice: "none" });
          operations.push("post_tool_continuation_requested");
        }
      } catch {
        failure = "tool_result_submission_failed";
        finish();
      }
    });
  };
  const unsubscribeEvent = input.client.onEvent((event) => {
    if ((event.type === "error" || event.type === "connection.closed")
      && event.transportDiagnostic !== undefined
      && transportFailureDiagnostic === null) {
      assertRealtimeTransportFailureDiagnostic(event.transportDiagnostic);
      transportFailureDiagnostic = freeze({ ...event.transportDiagnostic });
    }
    if (failure !== "none") return;
    if (input.provider === "xai" && event.type === "response.started" && toolCall === null) {
      if (speechStopObservationSha256 === null
        || commitObservationSha256 === null
        || event.causalBinding?.trigger !== "server_vad_speech_stopped"
        || event.causalBinding.triggerObservationSha256 !== speechStopObservationSha256) {
        failure = "server_vad_response_before_speech_stop";
        finish();
        return;
      }
      providerAutoResponseObserved = true;
      rootResponseId = event.responseId;
      rootResponseStartedObservationSha256 = event.wireObservation?.availability === "observed"
        ? event.wireObservation.observationSha256
        : autoResponseObservationSha256;
      operations.push("provider_auto_response_observed");
    }
    if (event.type === "output.audio" || event.type === "output.transcript") {
      if (input.provider === "xai" && event.responseId === rootResponseId) {
        if (rootResponseTerminalObservationSha256 !== null) {
          failure = "provider_error";
          finish();
          return;
        }
        if (!operations.includes("pre_tool_output_quarantined")) {
          operations.push("pre_tool_output_quarantined");
        }
        return;
      }
      if (toolCall === null) {
        failure = "speech_before_tool";
        finish();
        return;
      }
      if (toolResultWireObservationSha256 !== null) {
        continuationObserved = true;
        operations.push("post_tool_continuation_observed");
      }
    }
    if (event.type === "input.speech_activity" && input.provider === "xai") {
      operations.push(event.phase === "started" ? "server_vad_speech_started" : "server_vad_speech_stopped");
    }
    if (event.type === "input.audio_committed" && input.provider === "xai") {
      operations.push("server_vad_auto_commit_observed");
    }
    if (event.type === "turn.interrupted" && input.provider === "xai") {
      failure = "server_vad_event_order_invalid";
      finish();
      return;
    }
    if (event.type === "tool.results.submitted") {
      if (toolCall === null || event.callIds.length !== 1 || event.callIds[0] !== toolCall.callId) {
        failure = "tool_result_submission_failed";
        finish();
        return;
      }
      toolResultEventObserved = true;
      operations.push("matching_tool_result_event_observed");
    }
    if (event.type === "tool.continuation.requested") {
      continuationRequested = true;
      operations.push("post_tool_continuation_request_observed");
    }
    if (event.type === "response.started" && toolResultWireObservationSha256 !== null) {
      if (input.provider === "xai" && event.responseId === rootResponseId) {
        failure = "provider_error";
        finish();
        return;
      }
      continuationObserved = true;
      continuationResponseId ??= event.responseId;
      if (event.wireObservation?.availability === "observed") {
        continuationStartObservationSha256 ??= event.wireObservation.observationSha256;
      }
      operations.push("post_tool_continuation_observed");
    }
    if (event.type === "usage") {
      usage.push(event.usage);
      const candidateUsageResponseId = event.responseId ?? continuationResponseId;
      if (toolResultWireObservationSha256 !== null
        && continuationResponseId !== null
        && candidateUsageResponseId === continuationResponseId) {
        postToolUsageObserved = true;
        retainedUsage = event.usage;
        usageResponseId = candidateUsageResponseId;
        if (event.wireObservation?.availability === "observed") {
          usageObservationSha256 = event.wireObservation.observationSha256;
        }
        operations.push("post_tool_usage_observed");
      }
    }
    const candidate = exactToolCall(event);
    if (typeof candidate === "string") {
      failure = candidate;
      finish();
      return;
    }
    if (candidate !== null) {
      if (toolCall !== null) {
        failure = "competing_tool_call";
        finish();
        return;
      }
      toolCall = candidate.call;
      toolCallObservationSha256 = candidate.observationSha256;
      operations.push("exact_tool_call_observed");
      const callObservation = wire.find((item) => item.observationSha256 === candidate.observationSha256);
      const controlIndex = wire.findIndex((item) => item.observationSha256 === controlObservationSha256);
      const triggerIndex = wire.findIndex((item) => item.observationSha256 === triggerObservationSha256);
      const callIndex = wire.findIndex((item) => item.observationSha256 === candidate.observationSha256);
      const providerCausalityValid = input.provider === "gemini"
        ? candidate.call.responseIdSource === "client_local"
          && candidate.call.causalBinding?.providerCallId === candidate.call.callId
          && candidate.call.causalBinding.triggerObservationSha256 === triggerObservationSha256
          && candidate.call.causalBinding.trigger === "audio_activity_end"
        : input.provider === "xai"
          ? candidate.call.responseIdSource === "provider"
            && speechStopObservationSha256 !== null
            && rootResponseId !== null
            && candidate.call.responseId === rootResponseId
          : candidate.call.responseIdSource === "provider";
      if (controlIndex < 0) {
        failure = "dynamic_control_not_wire_observed";
        finish();
        return;
      }
      if (triggerIndex < controlIndex
        || (input.provider === "openai" && controlIndex !== triggerIndex)
        || callIndex <= triggerIndex || !callObservation
        || callObservation.direction !== "inbound"
        || callObservation.identities.callIdSha256 !== realtimeWireIdentitySha256("call", candidate.call.callId)
        || !providerCausalityValid
        || !verifyRealtimeWireObservationChain(wire).valid) {
        failure = "provider_error";
        finish();
        return;
      }
      toolCallEvidenceSha256 = sha256Hex(canonicalJson({
        provider: input.provider,
        model: input.model,
        call_id_sha256: realtimeWireIdentitySha256("call", candidate.call.callId),
        tool_name: candidate.call.name,
        arguments_sha256: sha256Hex(canonicalJson(candidate.call.argumentsJson)),
        dynamic_control_observation_sha256: controlObservationSha256,
        trigger_observation_sha256: triggerObservationSha256,
        call_observation_sha256: candidate.observationSha256,
        causal_binding: input.provider === "gemini"
          ? "activity_end_then_native_tool_call_id"
          : input.provider === "xai"
            ? "server_vad_speech_stop_then_native_response_and_call_ids"
            : "response_create_then_native_response_and_call_ids",
      }));
      scheduleToolResultSubmission();
    }
    if (event.type === "response.completed") {
      if (input.provider === "xai" && event.responseId === rootResponseId
        && toolResultWireObservationSha256 === null) {
        if (event.status !== "completed"
          || event.wireObservation?.availability !== "observed") {
          failure = "provider_error";
          finish();
          return;
        }
        rootResponseTerminalObservationSha256 = event.wireObservation.observationSha256;
        operations.push("pre_tool_root_terminal_observed");
        if (toolCall === null) {
          queueMicrotask(() => {
            if (failure !== "none" || toolCall !== null) return;
            failure = "wrong_tool";
            finish();
          });
        } else {
          scheduleToolResultSubmission();
        }
        return;
      }
      if (toolCall === null) {
        // A provider adapter may derive a terminal call and completion from one
        // wire frame. Give every normalized sibling from that frame one turn to
        // reach this listener before classifying a genuinely call-free response.
        queueMicrotask(() => {
          if (failure !== "none" || toolCall !== null) return;
          failure = "wrong_tool";
          finish();
        });
        return;
      }
      if (toolResultWireObservationSha256 !== null && event.status === "completed") {
        if (input.provider === "xai" && event.responseId === rootResponseId) {
          failure = "provider_error";
          finish();
          return;
        }
        terminalObserved = true;
        terminalResponseId = event.responseId;
        if (event.wireObservation?.availability === "observed") {
          terminalObservationSha256 = event.wireObservation.observationSha256;
        }
        operations.push("post_tool_terminal_observed");
      }
    }
    if (event.type === "error") {
      failure = event.code === "unexpected_manual_turn_detection_event"
        ? "manual_turn_mode_violation"
        : "provider_error";
      finish();
      return;
    }
    maybeFinish();
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await input.client.connect();
    if (input.client.state !== "ready") throw new Error("client not ready");
    operations.push("session_ready");
    if (input.provider === "xai") {
      if (typeof input.client.prepareServerVadTurn !== "function" || !transportParitySha256) {
        failure = "server_vad_control_ack_missing";
        throw new Error("xAI server-VAD preparation barrier is unavailable");
      }
      let acknowledgement;
      try {
        acknowledgement = await input.client.prepareServerVadTurn({
          additionalInstructions: LC4_S2S_COMPACT_CONTROL,
          contextSha256: LC4_S2S_COMPACT_CONTROL_SHA256,
          contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
          tools: [LC4_S2S_TOOL],
          toolFrontierSha256,
          transportParitySha256,
        }, 5_000);
      } catch {
        failure = "server_vad_control_ack_missing";
        throw new Error("xAI server-VAD session.updated acknowledgement failed");
      }
      controlAckObservationSha256 = acknowledgement.inboundObservation?.availability === "observed"
        ? acknowledgement.inboundObservation.observationSha256
        : null;
      if (acknowledgement.outboundObservation?.availability !== "observed"
        || !controlAckObservationSha256) {
        failure = "server_vad_control_ack_missing";
        throw new Error("xAI server-VAD preparation lacks wire-observed acknowledgement");
      }
      controlObservationSha256 = acknowledgement.outboundObservation.observationSha256;
      operations.push("server_vad_control_updated", "server_vad_control_acknowledged");
    }
    const receipt = await deliverRealtimePcm16({
      client: input.client,
      audio: input.audio,
      profile: input.profile,
      runtime: input.runtime ?? SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
      signal: input.signal ?? new AbortController().signal,
    });
    const plan = packetizeRealtimePcm16(input.audio, input.profile);
    if (receipt.total_byte_length !== input.audioObject.byte_length
      || receipt.chunk_count !== plan.frames.length
      || receipt.chunks.some((chunk, index) => chunk.scheduled_offset_ms !== index * 20)) {
      failure = "audio_delivery_contract_failed";
      throw new Error("delivery contract failed");
    }
    delivery = freeze({
      packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
      delivery_profile_sha256: trialAudioDeliveryProfileHash(input.profile),
      audio_sha256: input.audioObject.sha256,
      audio_bytes: receipt.total_byte_length,
      chunk_count: receipt.chunk_count,
      frame_bytes: receipt.frame_byte_length,
      tail_bytes: receipt.tail_byte_length,
      scheduled_offsets_ms: freeze(receipt.chunks.map((chunk) => chunk.scheduled_offset_ms)),
    });
    operations.push("preregistered_pcm_paced_20ms");
    let transportSuffixPlan: ReturnType<typeof packetizeRealtimePcm16> | null = null;
    let transportSuffixCompletion: "full_plan_delivered" | "provider_native_speech_stop" | null = null;
    if (input.provider === "xai") {
      if (input.audio.sampleRateHz !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.sample_rate_hz
        || input.profile.chunkMs !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms) {
        failure = "audio_delivery_contract_failed";
        throw new Error("xAI server-VAD silence-tail profile does not match the frozen transport policy");
      }
      const suffixAudio = freeze({
        encoding: "pcm16" as const,
        sampleRateHz: LC4_XAI_SERVER_VAD_SILENCE_TAIL.sample_rate_hz,
        channels: 1 as const,
        data: new Uint8Array(LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length),
      });
      if (sha256Hex(suffixAudio.data) !== LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256) {
        failure = "audio_delivery_contract_failed";
        throw new Error("xAI server-VAD silence-tail PCM failed its frozen hash");
      }
      const fullTransportSuffixPlan = packetizeRealtimePcm16(suffixAudio, input.profile);
      try {
        const suffixReceipt = await deliverRealtimePcm16({
          client: input.client,
          audio: suffixAudio,
          profile: input.profile,
          runtime: input.runtime ?? SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
          signal: input.signal ?? new AbortController().signal,
        });
        if (suffixReceipt.total_byte_length !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length
          || suffixReceipt.chunk_count !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count
          || suffixReceipt.chunk_count !== fullTransportSuffixPlan.frames.length
          || suffixReceipt.frame_byte_length !== plan.frame_byte_length
          || suffixReceipt.tail_byte_length !== plan.frame_byte_length
          || suffixReceipt.chunks.some((chunk, index) => chunk.scheduled_offset_ms !== index * 20)) {
          failure = "audio_delivery_contract_failed";
          throw new Error("xAI server-VAD silence-tail delivery contract failed");
        }
        transportSuffixPlan = fullTransportSuffixPlan;
        if (speechStopObservationSha256 === null && failure === "none") {
          failure = "server_vad_delimiter_exhausted";
          throw new Error("xAI server-VAD delimiter exhausted without provider-native speech stop");
        }
        transportSuffixCompletion = speechStopObservationSha256 === null
          ? "full_plan_delivered"
          : "provider_native_speech_stop";
      } catch (error) {
        const appendedChunks = error instanceof RealtimeAudioDeliveryError
          ? error.chunks_appended
          : 0;
        const appendedBytes = error instanceof RealtimeAudioDeliveryError
          ? error.bytes_appended
          : 0;
        const expectedBytes = appendedChunks * fullTransportSuffixPlan.frame_byte_length;
        const stopIndex = wire.findIndex(({ observationSha256 }) => (
          observationSha256 === speechStopObservationSha256
        ));
        const lastAppendIndex = wire.findLastIndex((observation) => (
          observation.direction === "outbound"
          && observation.wireType === "input_audio_buffer.append"
        ));
        const providerStoppedCompletePrefix = error instanceof RealtimeAudioDeliveryError
          && error.code === "append_failed"
          && error.cause instanceof Error
          && error.cause.message === XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR
          && failure === "none"
          && speechStopObservationSha256 !== null
          && appendedChunks >= LC4_XAI_SERVER_VAD_SILENCE_TAIL.minimum_accepted_chunk_count
          && appendedChunks < fullTransportSuffixPlan.frames.length
          && appendedBytes === expectedBytes
          && stopIndex > lastAppendIndex;
        if (!providerStoppedCompletePrefix) throw error;
        const frames = freeze(fullTransportSuffixPlan.frames.slice(0, appendedChunks));
        transportSuffixPlan = freeze({
          frame_byte_length: fullTransportSuffixPlan.frame_byte_length,
          frames,
          total_byte_length: appendedBytes,
          tail_byte_length: fullTransportSuffixPlan.frame_byte_length,
        });
        transportSuffixCompletion = "provider_native_speech_stop";
      }
      operations.push("server_vad_silence_tail_accepted_at_native_stop");
    }
    inputAudioEvidence = projectRoundtripInputAudioEvidence(wire, {
      chunk_sha256s: freeze(plan.frames.map((frame) => sha256Hex(frame.data))),
      chunk_list_sha256: roundtripInputAudioChunkListSha256(
        plan.frames.map((frame) => sha256Hex(frame.data)),
      ),
      audio_sha256: input.audioObject.sha256,
      delivery_profile_sha256: delivery.delivery_profile_sha256,
      packetizer_sha256: delivery.packetizer_sha256,
      audio_bytes: delivery.audio_bytes,
      chunk_count: delivery.chunk_count,
      frame_bytes: delivery.frame_bytes,
      tail_bytes: delivery.tail_bytes,
      sample_rate_hz: input.audio.sampleRateHz,
      ...(transportSuffixPlan === null ? {} : {
        transport_suffix: {
          purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
          completion: transportSuffixCompletion!,
          policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
          pcm_sha256: sha256Hex(new Uint8Array(transportSuffixPlan.total_byte_length)),
          audio_bytes: transportSuffixPlan.total_byte_length,
          duration_ms: transportSuffixPlan.total_byte_length
            / 2 / LC4_XAI_SERVER_VAD_SILENCE_TAIL.sample_rate_hz * 1_000,
          chunk_sha256s: freeze(transportSuffixPlan.frames.map((frame) => sha256Hex(frame.data))),
          chunk_list_sha256: roundtripInputAudioChunkListSha256(
            transportSuffixPlan.frames.map((frame) => sha256Hex(frame.data)),
          ),
          chunk_count: transportSuffixPlan.frames.length,
          frame_bytes: transportSuffixPlan.frame_byte_length,
          tail_bytes: transportSuffixPlan.tail_byte_length,
        },
      }),
    });
    if (inputAudioEvidence === null) {
      failure = "input_audio_replay_invalid";
      throw new Error("wire-observed input audio differs from preregistered delivery");
    }
    if (input.provider !== "xai") {
      input.client.prepareResponse({
        additionalInstructions: LC4_S2S_COMPACT_CONTROL,
        contextSha256: LC4_S2S_COMPACT_CONTROL_SHA256,
        contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      });
      operations.push("compact_semantic_control_prepared");
      if (input.provider === "gemini") responseRequested = true;
      input.client.commitInputAudio();
      operations.push("caller_audio_committed");
    }
    if (input.provider === "openai") {
      if (typeof input.client.waitForInputAudioCommit !== "function") {
        failure = "commit_acknowledgement_failed";
        throw new Error("provider commit acknowledgement barrier is unavailable");
      }
      try {
        await input.client.waitForInputAudioCommit(5_000);
      } catch {
        failure = "commit_acknowledgement_failed";
        throw new Error("provider did not acknowledge the explicit manual-turn commit");
      }
      operations.push("caller_audio_commit_acknowledged");
      responseRequested = true;
      const toolChoice = forcedToolChoice(input.provider);
      input.client.createResponse(toolChoice === undefined ? undefined : { tool_choice: toolChoice });
    }
    if (input.provider !== "xai") operations.push("response_generation_requested");
    await Promise.race([
      done,
      new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, timeoutMs); }),
    ]);
    if (failure === "none" && input.provider === "xai") {
      failure = speechStartObservationSha256 === null
        ? "server_vad_speech_start_missing"
        : speechStopObservationSha256 === null
          ? "server_vad_speech_stop_missing"
          : commitObservationSha256 === null
            ? "server_vad_auto_commit_missing"
            : autoResponseObservationSha256 === null
              ? "server_vad_auto_response_missing"
              : "none";
    }
    if (failure === "none" && !(toolResultWireObservationSha256
      && toolResultEventObserved
      && (input.provider === "gemini" || continuationRequested)
      && continuationObserved
      && terminalObserved
      && postToolUsageObserved)) {
      failure = toolCall === null ? "timeout"
        : !toolResultSubmitted ? "tool_result_submission_failed"
          : !toolResultWireObservationSha256 ? "tool_result_not_wire_observed"
            : !toolResultEventObserved ? "tool_result_event_missing"
              : input.provider !== "gemini" && !continuationRequested ? "post_tool_continuation_missing"
            : !continuationObserved ? "post_tool_continuation_missing"
              : !terminalObserved ? "post_tool_terminal_missing"
                : "post_tool_usage_missing";
    }
  } catch (error) {
    if (failure === "none") failure = error instanceof RealtimeAudioDeliveryError
      ? "audio_delivery_failed"
      : operations.includes("session_ready") ? "response_trigger_failed" : "session_setup_failed";
  } finally {
    if (timer) clearTimeout(timer);
    // xAI emits its final client-measured usage synchronously while closing.
    // Keep listeners attached until that meter is captured.
    input.client.close(1000, "LC4 S2S qualification complete");
    unsubscribeEvent();
    unsubscribeWire?.();
  }

  if (input.provider === "xai"
    && rootResponseId !== null
    && rootResponseStartedObservationSha256 !== null
    && rootResponseTerminalObservationSha256 !== null) {
    preToolOutputQuarantine = projectRoundtripPreToolOutputQuarantineEvidence({
      provider: input.provider,
      wire,
      response_started_observation_sha256: rootResponseStartedObservationSha256,
      terminal_observation_sha256: rootResponseTerminalObservationSha256,
      response_id_sha256: realtimeWireIdentitySha256("response", rootResponseId),
    });
  }
  if (continuationStartObservationSha256 !== null
    && terminalObservationSha256 !== null
    && continuationResponseId !== null) {
    outputAudioEvidence = projectRoundtripOutputAudioEvidence({
      provider: input.provider,
      wire,
      continuation_start_observation_sha256: continuationStartObservationSha256,
      terminal_observation_sha256: terminalObservationSha256,
      continuation_response_id_sha256: realtimeWireIdentitySha256(
        "response",
        continuationResponseId,
      ),
    });
  }
  if (failure === "none" && inputAudioEvidence === null) {
    failure = "input_audio_replay_invalid";
  }
  if (failure === "none" && outputAudioEvidence === null) {
    failure = "post_tool_output_audio_missing_or_invalid";
  }
  if (failure === "none" && input.provider === "xai"
    && preToolOutputQuarantine === null) {
    failure = "causal_replay_evidence_invalid";
  }

  const protocolPassed = failure === "none"
    && inputAudioEvidence !== null
    && outputAudioEvidence !== null
    && (input.provider !== "xai" || preToolOutputQuarantine !== null)
    && toolCall !== null
    && toolResultSubmitted
    && toolResultWireObservationSha256 !== null
    && continuationObserved
    && terminalObserved
    && postToolUsageObserved;
  const retainedToolCall = toolCall as RealtimeToolCall | null;
  if (input.provider === "gemini" && toolResultWireObservationSha256 !== null) {
    continuationRequestObservationSha256 ??= toolResultWireObservationSha256;
  }
  const retainedUsageSnapshot = retainedUsage as NormalizedRealtimeUsage | null;
  const usageCounters = retainedUsageSnapshot === null ? null : Object.freeze(Object.fromEntries(
    Object.entries(retainedUsageSnapshot)
      .filter(([key, value]) => key !== "raw" && key !== "meteringSource"
        && typeof value === "number" && Number.isFinite(value) && value >= 0),
  ) as Partial<Record<RoundtripUsageCounter, number>>);
  const meteringSource = retainedUsageSnapshot?.meteringSource;
  const measuredWirePcm = meteringSource === "client_measured"
    && continuationResponseId !== null
    && continuationStartObservationSha256 !== null
    && terminalObservationSha256 !== null
    ? wirePcmUsage(wire, {
        responseIdSha256: realtimeWireIdentitySha256("response", continuationResponseId),
        startedObservationSha256: continuationStartObservationSha256,
        terminalObservationSha256,
      })
    : null;
  const providerUsageCounters = meteringSource === "provider_reported" || meteringSource === "mixed"
    ? providerWireUsage(wire, usageObservationSha256)
    : null;
  const measuredUsageCounters = usageCounters === null ? null : freeze(Object.fromEntries(
    Object.entries(usageCounters).filter(([key]) => (
      key === "inputAudioMinutes" || key === "outputAudioMinutes"
    )),
  ) as Partial<Record<RoundtripUsageCounter, number>>);
  const providerReportedUsageReady = (meteringSource === "provider_reported" || meteringSource === "mixed")
    && usageObservationSha256 !== null
    && providerUsageCounters !== null
    && (meteringSource === "mixed"
      || (usageCounters !== null && canonicalJson(usageCounters) === canonicalJson(providerUsageCounters)));
  const clientMeasuredUsageReady = input.provider === "xai"
    && meteringSource === "client_measured"
    && measuredWirePcm !== null
    && measuredUsageCounters !== null
    && Object.keys(measuredUsageCounters).length > 0
    && canonicalJson(measuredUsageCounters) === canonicalJson(measuredWirePcm.counters);
  const sanitizedUsage = retainedUsageSnapshot === null
    || usageResponseId === null
    || terminalObservationSha256 === null
    || (!providerReportedUsageReady && !clientMeasuredUsageReady)
    ? [] as const
    : [freeze({
        schema_version: 1 as const,
        source: providerReportedUsageReady
          ? "provider_reported" as const
          : "client_measured_wire_pcm" as const,
        response_id_sha256: realtimeWireIdentitySha256("response", usageResponseId),
        terminal_observation_sha256: terminalObservationSha256,
        provider_usage_observation_sha256: providerReportedUsageReady
          ? usageObservationSha256
          : null,
        contributing_wire_observation_sha256s: providerReportedUsageReady
          ? freeze([usageObservationSha256!])
          : measuredWirePcm!.contributingObservationSha256s,
        counters: providerReportedUsageReady ? providerUsageCounters! : measuredUsageCounters!,
      })] as const;
  const usageBindingObservationSha256 = sanitizedUsage[0]?.source === "client_measured_wire_pcm"
    ? terminalObservationSha256
    : usageObservationSha256;
  const callResponseIdSha256 = retainedToolCall === null
    ? null
    : realtimeWireIdentitySha256("response", retainedToolCall.responseId);
  const continuationResponseIdSha256 = continuationResponseId === null
    ? null
    : realtimeWireIdentitySha256("response", continuationResponseId);
  const callIdSha256 = retainedToolCall === null
    ? null
    : realtimeWireIdentitySha256("call", retainedToolCall.callId);
  const completeCausalEvidence = retainedToolCall !== null
    && callResponseIdSha256 !== null
    && continuationResponseIdSha256 !== null
    && callIdSha256 !== null
    && triggerObservationSha256 !== null
    && toolCallEvidenceSha256 !== null
    && toolResultWireObservationSha256 !== null
    && continuationRequestObservationSha256 !== null
    && continuationStartObservationSha256 !== null
    && terminalObservationSha256 !== null
    && terminalResponseId !== null
    && usageBindingObservationSha256 !== null
    && usageResponseId !== null
    && sanitizedUsage.length === 1;
  const replayCausalBindingBody = completeCausalEvidence ? freeze({
    schema_version: 1 as const,
    provider: input.provider,
    response_id_source: input.provider === "gemini" ? "client_local" as const : "provider" as const,
    connection_epoch: 1 as const,
    input_turn: retainedToolCall!.causalBinding?.inputTurn ?? 1,
    trigger_observation_sha256: triggerObservationSha256!,
    initial_response_id_sha256: callResponseIdSha256!,
    call_id_sha256: callIdSha256!,
    call_response_id_sha256: callResponseIdSha256!,
    call_observation_sha256: toolCallObservationSha256 ?? "",
    result_observation_sha256: toolResultWireObservationSha256!,
    continuation_request_observation_sha256: continuationRequestObservationSha256!,
    continuation_response_id_sha256: continuationResponseIdSha256!,
    continuation_start_observation_sha256: continuationStartObservationSha256!,
    terminal_observation_sha256: terminalObservationSha256!,
    usage_observation_sha256: usageBindingObservationSha256!,
    usage_response_id_sha256: realtimeWireIdentitySha256("response", usageResponseId!),
  }) : null;
  const replayCausalBinding = replayCausalBindingBody === null
    || !SHA256.test(replayCausalBindingBody.call_observation_sha256)
    ? null
    : freeze({
        ...replayCausalBindingBody,
        evidence_sha256: roundtripCausalBindingSha256(replayCausalBindingBody),
      });
  const replaySummary = replayCausalBinding === null || sanitizedUsage.length !== 1
    || inputAudioEvidence === null || outputAudioEvidence === null
    ? null
    : freeze({
        schema_version: 1 as const,
        provider: input.provider,
        model: input.model,
        connection_epoch: 1 as const,
        call: freeze({
          observation_sha256: replayCausalBinding.call_observation_sha256,
          call_id_sha256: replayCausalBinding.call_id_sha256,
          response_id_sha256: replayCausalBinding.call_response_id_sha256,
        }),
        result: freeze({
          observation_sha256: replayCausalBinding.result_observation_sha256,
          call_id_sha256: replayCausalBinding.call_id_sha256,
        }),
        continuation: freeze({
          request_observation_sha256: replayCausalBinding.continuation_request_observation_sha256,
          origin_response_id_sha256: replayCausalBinding.initial_response_id_sha256,
          started_observation_sha256: replayCausalBinding.continuation_start_observation_sha256,
          response_id_sha256: replayCausalBinding.continuation_response_id_sha256,
        }),
        terminal: freeze({
          observation_sha256: replayCausalBinding.terminal_observation_sha256,
          response_id_sha256: realtimeWireIdentitySha256("response", terminalResponseId!),
          status: "completed" as const,
        }),
        usage: freeze({
          evidence_sha256: roundtripSanitizedUsageSha256(sanitizedUsage[0]!),
          response_id_sha256: replayCausalBinding.usage_response_id_sha256,
        }),
        input_audio: inputAudioEvidence,
        output_audio: outputAudioEvidence,
        ...(preToolOutputQuarantine === null ? {} : {
          pre_tool_output_quarantine: preToolOutputQuarantine,
        }),
      });
  const replay = replaySummary === null ? null : replayProviderToolRoundtrip({
    expected: { provider: input.provider, model: input.model },
    summary: replaySummary,
    wire_observations: wire,
    sanitized_usage: sanitizedUsage,
    causal_binding: replayCausalBinding,
  });
  const sanitizedUsageReady = sanitizedUsage.length === 1;
  const causalReplayReady = replayCausalBinding !== null
    && replaySummary !== null
    && replay?.valid === true
    && replay.public_execution_sha256 !== null
    && replay.replay_sha256 !== null;
  const closedLoopEvidenceReady = delivery !== null
    && inputAudioEvidence !== null
    && outputAudioEvidence !== null
    && (input.provider === "xai"
      ? providerAutoResponseObserved && !responseRequested
      : responseRequested && !providerAutoResponseObserved)
    && retainedToolCall !== null
    && toolResultSubmitted
    && toolResultEventObserved
    && toolResultWireObservationSha256 !== null
    && (input.provider === "gemini" || continuationRequested)
    && continuationObserved
    && terminalObserved
    && postToolUsageObserved
    && toolCallEvidenceSha256 !== null
    && toolResultWireObservationSha256 !== null
    && sanitizedUsageReady
    && causalReplayReady;
  const passed = protocolPassed && closedLoopEvidenceReady;
  if (protocolPassed && !sanitizedUsageReady) {
    failure = "post_tool_usage_evidence_invalid";
  } else if (protocolPassed && !causalReplayReady) {
    failure = "causal_replay_evidence_invalid";
  } else if (!passed && failure === "none") {
    failure = "provider_error";
  }
  const failureBody = freeze({
    provider: input.provider,
    model: input.model,
    failure_class: failure,
    operation_order: operations,
    wire_count: wire.length,
    terminal_wire_sha256: wire.at(-1)?.observationSha256 ?? null,
    transport_failure_diagnostic: transportFailureDiagnostic,
  });
  const body = freeze({
    schema_version: 3 as const,
    roundtrip_version: LC4_S2S_ROUNDTRIP_VERSION,
    provider: input.provider,
    model: input.model,
    attempted_at: attemptedAt,
    completed_at: now().toISOString(),
    status: passed ? "passed" as const : "failed" as const,
    failure_class: failure,
    audio: input.audioObject,
    delivery,
    input_audio_evidence: inputAudioEvidence,
    output_audio_evidence: outputAudioEvidence,
    pre_tool_output_quarantine: preToolOutputQuarantine,
    compact_control_sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
    tool_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
    response_generation_requested: responseRequested,
    provider_auto_response_observed: providerAutoResponseObserved,
    turn_boundary_mode: input.provider === "xai"
      ? "provider_native_server_vad" as const
      : input.provider === "gemini"
        ? "provider_activity_markers" as const
        : "manual_commit" as const,
    server_vad_setting_sha256: input.provider === "xai" ? LC4_XAI_SERVER_VAD_SHA256 : null,
    server_vad_transport_disclosure_sha256: input.provider === "xai"
      ? LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256
      : null,
    transport_parity_sha256: transportParitySha256,
    tool_frontier_sha256: toolFrontierSha256,
    per_turn_session_update_observation_sha256: input.provider === "xai" ? controlObservationSha256 : null,
    per_turn_session_ack_observation_sha256: input.provider === "xai" ? controlAckObservationSha256 : null,
    server_vad_speech_start_observation_sha256: input.provider === "xai" ? speechStartObservationSha256 : null,
    server_vad_speech_stop_observation_sha256: input.provider === "xai" ? speechStopObservationSha256 : null,
    server_vad_auto_commit_observation_sha256: input.provider === "xai" ? commitObservationSha256 : null,
    server_vad_auto_response_observation_sha256: input.provider === "xai" ? autoResponseObservationSha256 : null,
    transport_failure_diagnostic: transportFailureDiagnostic,
    manual_turn_commit_observation_sha256: input.provider === "xai" ? null : commitObservationSha256,
    response_trigger_observation_sha256: triggerObservationSha256,
    tool_call_observed: retainedToolCall !== null,
    tool_result_submitted: toolResultSubmitted,
    tool_result_event_observed: toolResultEventObserved,
    tool_result_wire_observed: toolResultWireObservationSha256 !== null,
    post_tool_continuation_requested: input.provider === "gemini" || continuationRequested,
    post_tool_continuation_observed: continuationObserved,
    post_tool_terminal_observed: terminalObserved,
    post_tool_usage_observed: postToolUsageObserved,
    provider_tool_call_evidence_sha256: toolCallEvidenceSha256,
    tool_result_evidence_sha256: toolResultWireObservationSha256 === null || retainedToolCall === null ? null : sha256Hex(canonicalJson({
      call_id_sha256: realtimeWireIdentitySha256("call", retainedToolCall.callId),
      result_observation_sha256: toolResultWireObservationSha256,
      output_sha256: sha256Hex(canonicalJson({ ok: true, qualification_stage: "completed" })),
    })),
    wire_observations: freeze([...wire]),
    usage: freeze([...usage]),
    replay_summary: replaySummary,
    replay_causal_binding: replayCausalBinding,
    sanitized_usage: freeze([...sanitizedUsage]),
    public_execution_sha256: replay?.valid === true ? replay.public_execution_sha256 : null,
    replay_sha256: replay?.valid === true ? replay.replay_sha256 : null,
    operation_order: freeze([...operations]),
    failure_evidence_sha256: sha256Hex(`${ROUNDTRIP_FAILURE_DOMAIN}${canonicalJson(failureBody)}`),
  });
  return freeze({ ...body, evidence_sha256: sha256Hex(`${ROUNDTRIP_EVIDENCE_DOMAIN}${canonicalJson(body)}`) });
}

export function assertLc4S2sRoundtripExecution(execution: Lc4S2sRoundtripExecution): void {
  const { evidence_sha256, ...body } = execution;
  if (sha256Hex(`${ROUNDTRIP_EVIDENCE_DOMAIN}${canonicalJson(body)}`) !== evidence_sha256) throw new Error("LC4 S2S roundtrip evidence hash mismatch");
  if (execution.roundtrip_version !== LC4_S2S_ROUNDTRIP_VERSION
    || execution.tool_schema_sha256 !== LC4_S2S_TOOL_SCHEMA_SHA256
    || execution.compact_control_sha256 !== LC4_S2S_COMPACT_CONTROL_SHA256
    || !verifyRealtimeWireObservationChain(execution.wire_observations).valid) throw new Error("LC4 S2S roundtrip evidence contract is invalid");
  const expectedTurnBoundaryMode = execution.provider === "xai"
    ? "provider_native_server_vad"
    : execution.provider === "gemini"
      ? "provider_activity_markers"
      : "manual_commit";
  if (execution.turn_boundary_mode !== expectedTurnBoundaryMode) {
    throw new Error("LC4 S2S roundtrip turn-boundary mode differs from its provider transport");
  }
  if (execution.transport_failure_diagnostic !== null) {
    assertRealtimeTransportFailureDiagnostic(execution.transport_failure_diagnostic);
  }
  if (execution.status === "passed" && execution.transport_failure_diagnostic !== null) {
    throw new Error("passing LC4 S2S roundtrip cannot retain a transport failure diagnostic");
  }
  if (execution.status === "passed" && (
    execution.failure_class !== "none"
    || execution.delivery === null
    || execution.input_audio_evidence === null
    || execution.output_audio_evidence === null
    || (execution.provider === "xai"
      ? execution.pre_tool_output_quarantine === null
      : execution.pre_tool_output_quarantine !== null)
    || (execution.provider === "xai"
      ? !execution.provider_auto_response_observed || execution.response_generation_requested
      : !execution.response_generation_requested || execution.provider_auto_response_observed)
    || !execution.tool_call_observed
    || !execution.tool_result_submitted
    || !execution.tool_result_event_observed
    || !execution.tool_result_wire_observed
    || !execution.post_tool_continuation_requested
    || !execution.post_tool_continuation_observed
    || !execution.post_tool_terminal_observed
    || !execution.post_tool_usage_observed
    || execution.provider_tool_call_evidence_sha256 === null
    || execution.tool_result_evidence_sha256 === null
    || execution.replay_summary === null
    || execution.replay_causal_binding === null
    || execution.sanitized_usage.length === 0
    || execution.public_execution_sha256 === null
    || execution.replay_sha256 === null
  )) throw new Error("passing LC4 S2S roundtrip lacks closed-loop evidence");
  if (execution.status === "passed") {
    const delivery = execution.delivery!;
    const inputAudio = execution.input_audio_evidence!;
    if (canonicalJson(execution.replay_summary!.input_audio) !== canonicalJson(inputAudio)
      || canonicalJson(execution.replay_summary!.output_audio)
        !== canonicalJson(execution.output_audio_evidence)
      || inputAudio.audio_sha256 !== execution.audio.sha256
      || inputAudio.audio_bytes !== delivery.audio_bytes
      || inputAudio.chunk_count !== delivery.chunk_count
      || inputAudio.frame_bytes !== delivery.frame_bytes
      || inputAudio.tail_bytes !== delivery.tail_bytes
      || inputAudio.packetizer_sha256 !== delivery.packetizer_sha256
      || inputAudio.delivery_profile_sha256 !== delivery.delivery_profile_sha256
      || inputAudio.sample_rate_hz !== execution.audio.sample_rate_hz) {
      throw new Error("passing LC4 S2S roundtrip input/output audio binding is invalid");
    }
    const suffix = inputAudio.transport_suffix;
    if (execution.provider === "xai") {
      const callerLastObservation = execution.wire_observations.findIndex((observation) => (
        observation.observationSha256 === inputAudio.observation_sha256s.at(-1)
      ));
      const suffixFirstObservation = execution.wire_observations.findIndex((observation) => (
        observation.observationSha256 === suffix?.observation_sha256s[0]
      ));
      if (suffix === undefined
        || suffix.purpose !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose
        || suffix.completion !== "provider_native_speech_stop"
        || suffix.policy_sha256 !== LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256
        || !isAcceptedXaiServerVadSilenceTail(suffix)
        || suffix.chunk_sha256s.length !== suffix.chunk_count
        || suffix.observation_sha256s.length !== suffix.chunk_count
        || callerLastObservation < 0
        || suffixFirstObservation <= callerLastObservation) {
        throw new Error("passing xAI LC4 S2S roundtrip lacks the frozen server-VAD silence tail");
      }
      const quarantine = execution.pre_tool_output_quarantine!;
      const projectedQuarantine = projectRoundtripPreToolOutputQuarantineEvidence({
        provider: execution.provider,
        wire: execution.wire_observations,
        response_started_observation_sha256: quarantine.response_started_observation_sha256,
        terminal_observation_sha256: quarantine.terminal_observation_sha256,
        response_id_sha256: quarantine.response_id_sha256,
      });
      if (quarantine.disposition !== "suppressed_never_caller_playable"
        || quarantine.released_audio_bytes !== 0
        || projectedQuarantine === null
        || canonicalJson(projectedQuarantine) !== canonicalJson(quarantine)
        || execution.replay_summary!.pre_tool_output_quarantine === undefined
        || canonicalJson(execution.replay_summary!.pre_tool_output_quarantine)
          !== canonicalJson(quarantine)) {
        throw new Error("passing xAI LC4 S2S roundtrip lacks exact pre-tool quarantine evidence");
      }
    } else if (suffix !== undefined) {
      throw new Error("non-xAI LC4 S2S roundtrip cannot contain a server-VAD silence tail");
    }
    const replay = replayProviderToolRoundtrip({
      expected: { provider: execution.provider, model: execution.model },
      summary: execution.replay_summary!,
      wire_observations: execution.wire_observations,
      sanitized_usage: execution.sanitized_usage,
      causal_binding: execution.replay_causal_binding,
    });
    if (!replay.valid
      || replay.public_execution_sha256 !== execution.public_execution_sha256
      || replay.replay_sha256 !== execution.replay_sha256) {
      throw new Error("passing LC4 S2S roundtrip replay evidence failed integrity");
    }
  }
  if (execution.status === "passed" && execution.provider === "xai") {
    const index = (hash: string | null) => execution.wire_observations
      .findIndex((observation) => observation.observationSha256 === hash);
    const control = index(execution.per_turn_session_update_observation_sha256);
    const ack = index(execution.per_turn_session_ack_observation_sha256);
    const firstAudio = execution.wire_observations.findIndex((observation) => (
      observation.direction === "outbound" && observation.wireType === "input_audio_buffer.append"
    ));
    const speechStart = index(execution.server_vad_speech_start_observation_sha256);
    const speechStop = index(execution.server_vad_speech_stop_observation_sha256);
    const silenceTailLast = index(execution.input_audio_evidence?.transport_suffix
      ?.observation_sha256s.at(-1) ?? null);
    const commit = index(execution.server_vad_auto_commit_observation_sha256);
    const rootResponse = index(execution.server_vad_auto_response_observation_sha256);
    const toolResult = index(execution.tool_result_evidence_sha256 === null
      ? null
      : execution.wire_observations.find((observation) => (
          observation.direction === "outbound"
          && observation.wireType === "conversation.item.create"
          && observation.identities.callIdSha256 !== undefined
        ))?.observationSha256 ?? null);
    const responseCreates = execution.wire_observations
      .map((observation, position) => ({ observation, position }))
      .filter(({ observation }) => observation.direction === "outbound" && observation.wireType === "response.create");
    const forbiddenCommit = execution.wire_observations.some((observation) => (
      observation.direction === "outbound" && observation.wireType === "input_audio_buffer.commit"
    ));
    if (execution.turn_boundary_mode !== "provider_native_server_vad"
      || execution.server_vad_setting_sha256 !== LC4_XAI_SERVER_VAD_SHA256
      || execution.server_vad_transport_disclosure_sha256 !== LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256
      || !execution.transport_parity_sha256
      || execution.tool_frontier_sha256 !== realtimeToolFrontierSha256([LC4_S2S_TOOL])
      || [control, ack, firstAudio, speechStart, silenceTailLast, speechStop, commit, rootResponse, toolResult].some((value) => value < 0)
      || !(control < ack && ack < firstAudio && firstAudio < speechStart && speechStart <= silenceTailLast
        && silenceTailLast < speechStop
        && speechStop < commit && commit < rootResponse && rootResponse < toolResult)
      || forbiddenCommit
      || responseCreates.length !== 1
      || responseCreates[0]!.position <= toolResult) {
      throw new Error("passing xAI LC4 S2S roundtrip lacks ordered provider-native server-VAD evidence");
    }
  }
  if (execution.status === "failed" && execution.failure_class === "none") throw new Error("failed LC4 S2S roundtrip lacks a failure class");
}
