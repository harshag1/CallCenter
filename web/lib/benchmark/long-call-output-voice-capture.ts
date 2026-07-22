import {
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  canonicalJson,
  sha256Hex,
} from "./artifacts";
import {
  LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
  LONG_CALL_ASR_SEMANTIC_SLOTS,
  createOutputVoiceCalibrationManifest,
  outputVoiceCaptureReceiptSha256,
  outputVoiceCaptureSigningBytes,
  outputVoiceChunkSequenceSha256,
  validateOutputVoiceCalibrationFixtures,
  verifyOutputVoiceCalibrationPcm,
  type FrozenOutputVoiceCalibrationFixture,
  type OutputVoiceCalibrationCaptureReceipt,
  type OutputVoiceCalibrationManifest,
  type OutputVoiceCaptureAuthority,
  type LongCallOutputVoiceRoute,
} from "./long-call-asr-calibration";
import {
  DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
  trialAudioDeliveryProfileHash,
  type TrialSessionConfiguration,
} from "./orchestrator";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  RealtimeWireObservation,
  SessionConfigurationAcknowledgement,
} from "../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  verifyRealtimeWireObservationChain,
} from "../realtime/client/wire-evidence";
import type { LiveStsProvider } from "./live-sts-development-experiment";

const CAPTURE_SESSION_DOMAIN = "hacc/output-voice-calibration-session/v1\n";
const CAPTURE_REQUEST_DOMAIN = "hacc/output-voice-calibration-request/v1\n";
const SYNTHETIC_SESSION_DOMAIN = "hacc/output-voice-calibration-provider-session/v1\n";
const MAX_OUTPUT_PCM_BYTES = 4 * 1024 * 1024;
const DEFAULT_RESPONSE_TIMEOUT_MS = 45_000;

export const OUTPUT_VOICE_CAPTURE_INSTRUCTIONS = [
  "You are a deterministic speech-output calibration instrument.",
  "Never call tools.",
  "For every response, obey the response-specific calibration instruction exactly.",
  "Speak only the requested calibration text, once, with no lead-in or commentary.",
].join(" ");

export type OutputVoiceCaptureSigner = Readonly<{
  privateKey: KeyObject;
  authority: OutputVoiceCaptureAuthority;
}>;

export type OutputVoiceCaptureToolchain = Readonly<{
  implementationSha256: string;
  sourceCommitSha256: string;
}>;

export type OutputVoiceCaptureResult = Readonly<{
  fixture: FrozenOutputVoiceCalibrationFixture;
  pcm: Uint8Array;
  sanitizedWireJsonl: string;
}>;

export type OutputVoiceCaptureBatch = Readonly<{
  manifest: OutputVoiceCalibrationManifest;
  captures: readonly OutputVoiceCaptureResult[];
}>;

export type OutputVoiceCaptureClientFactory = (
  provider: LiveStsProvider,
  configuration: TrialSessionConfiguration,
) => NormalizedRealtimeClient | Promise<NormalizedRealtimeClient>;

export type OutputVoiceCaptureOptions = Readonly<{
  createClient: OutputVoiceCaptureClientFactory;
  signer: OutputVoiceCaptureSigner;
  toolchain: OutputVoiceCaptureToolchain;
  responseTimeoutMs?: number;
}>;

type TerminalCapture = Readonly<{
  ready: Extract<NormalizedRealtimeEvent, { type: "session.ready" }>;
  completed: Extract<NormalizedRealtimeEvent, { type: "response.completed" }>;
  responseId: string;
  chunks: readonly Uint8Array[];
  chunkRecords: OutputVoiceCalibrationCaptureReceipt["wireCapture"]["outputChunks"];
  observations: readonly RealtimeWireObservation[];
}>;

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function observationHash(event: NormalizedRealtimeEvent, label: string): string {
  const attribution = event.wireObservation;
  if (!attribution || attribution.availability !== "observed") {
    throw new Error(`${label} lacks a provider wire observation`);
  }
  return attribution.observationSha256;
}

function outputVoiceReferenceText(slotId: string): string {
  const slot = LONG_CALL_ASR_SEMANTIC_SLOTS.find((candidate) => candidate.id === slotId);
  if (!slot) throw new Error(`unknown output-voice semantic slot ${slotId}`);
  // Isolated fragments are not representative of in-call speech and make
  // homophones (for example "parts"/"carts") needlessly ambiguous to an
  // independent ASR. Keep the wrapper fixed by slot kind so every provider is
  // calibrated against the same natural, non-cherry-picked sentence shape.
  if (slot.kind === "numeric_limit") return `The exact limit is ${slot.canonicalText}.`;
  const spokenIdentifier = slot.canonicalText.replace(/^([A-Z]{2,})(?=\s)/u, (prefix) => [...prefix].join(" "));
  return `The corrected identifier is ${spokenIdentifier}.`;
}

/** Duplicate slot rows are rejected by the manifest; retain one deterministic row per semantic ID. */
export function outputVoiceCaptureSlotIds(): readonly string[] {
  return Object.freeze([...new Set(LONG_CALL_ASR_SEMANTIC_SLOTS.map((slot) => slot.id))]);
}

export function outputVoiceCaptureUnitId(route: LongCallOutputVoiceRoute, slotId: string): string {
  return `output-voice-${route.provider}-${slotId}`;
}

export function outputVoiceCaptureFixturePath(route: LongCallOutputVoiceRoute, slotId: string): string {
  return `output-voice-calibration/${route.provider}/${slotId}.pcm`;
}

export function outputVoiceCaptureWirePath(route: LongCallOutputVoiceRoute, slotId: string): string {
  return `output-voice-calibration/${route.provider}/${slotId}.wire.jsonl`;
}

export function createOutputVoiceCaptureSessionConfiguration(
  route: LongCallOutputVoiceRoute,
): TrialSessionConfiguration {
  const inputSampleRateHz = route.provider === "gemini" ? 16_000 : 24_000;
  const contract = Object.freeze({
    schemaVersion: 1,
    purpose: "output_voice_asr_calibration",
    provider: route.provider,
    model: route.model,
    voice: route.voice,
    instructions: OUTPUT_VOICE_CAPTURE_INSTRUCTIONS,
    tools: Object.freeze([]),
    inputAudio: Object.freeze({ encoding: "pcm16", sampleRateHz: inputSampleRateHz, channels: 1 }),
    outputAudio: Object.freeze({ encoding: "pcm16", sampleRateHz: 24_000, channels: 1 }),
  });
  const conditionHash = sha256Hex(`${CAPTURE_SESSION_DOMAIN}${canonicalJson(contract)}`);
  return Object.freeze({
    provider: route.provider,
    model: route.model,
    conditionId: "raw-full",
    instructions: OUTPUT_VOICE_CAPTURE_INSTRUCTIONS,
    initialPrompt: OUTPUT_VOICE_CAPTURE_INSTRUCTIONS,
    renderedCapabilitySnapshot: "",
    providerTools: Object.freeze([]),
    conditionHash,
    inputAudioFormat: Object.freeze({ encoding: "pcm16", sampleRateHz: inputSampleRateHz, channels: 1 }),
    audioDeliveryProfile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
  });
}

/**
 * One second of exact PCM silence opens a real audio activity without adding a
 * second TTS system to output-voice calibration. The requested phrase crosses
 * each adapter's pre-generation response-preparation boundary.
 */
export function createOutputVoiceCaptureTrigger(sampleRateHz: number): Pcm16Audio {
  if (sampleRateHz !== 16_000 && sampleRateHz !== 24_000) {
    throw new Error("output-voice calibration trigger sample rate is unsupported");
  }
  return Object.freeze({
    encoding: "pcm16" as const,
    sampleRateHz,
    channels: 1 as const,
    data: new Uint8Array(sampleRateHz * 2),
  });
}

function responsePreparation(referenceText: string) {
  const additionalInstructions = [
    "This is an isolated voice calibration response.",
    `Speak exactly this text once and nothing else: ${referenceText}`,
    "Do not call any tool.",
  ].join("\n");
  return Object.freeze({
    additionalInstructions,
    contextSha256: sha256Hex(additionalInstructions),
    contextAuthority: "advisory_only_gateway_and_speech_gate_enforced" as const,
  });
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function assertProviderAcknowledgement(
  route: LongCallOutputVoiceRoute,
  configuration: SessionConfigurationAcknowledgement | undefined,
): Readonly<{ acknowledgedModel: string | null; acknowledgedVoice: string | null }> {
  if (!configuration) throw new Error(`${route.provider} did not retain its session acknowledgement`);
  if (route.provider === "openai") {
    if (!configuration.strictParityVerified
      || configuration.fields.model.status !== "verified"
      || configuration.fields.voice.status !== "verified") {
      throw new Error("OpenAI did not exactly acknowledge the pinned output-voice model and voice");
    }
    return Object.freeze({ acknowledgedModel: route.model, acknowledgedVoice: route.voice });
  }
  if (route.provider === "gemini") {
    return Object.freeze({ acknowledgedModel: null, acknowledgedVoice: null });
  }
  return Object.freeze({
    acknowledgedModel: configuration.fields.model.status === "verified" ? route.model : null,
    acknowledgedVoice: configuration.fields.voice.status === "verified" ? route.voice : null,
  });
}

function providerAcknowledgementKind(provider: LiveStsProvider) {
  if (provider === "openai") return "exact_configuration_echo" as const;
  if (provider === "gemini") return "request_bound_setup_complete" as const;
  return "request_bound_partial_echo" as const;
}

async function captureTerminal(input: Readonly<{
  client: NormalizedRealtimeClient;
  route: LongCallOutputVoiceRoute;
  referenceText: string;
  timeoutMs: number;
}>): Promise<TerminalCapture> {
  const observations: RealtimeWireObservation[] = [];
  const chunksByResponse = new Map<string, Uint8Array[]>();
  let ready: Extract<NormalizedRealtimeEvent, { type: "session.ready" }> | null = null;
  let completed: Extract<NormalizedRealtimeEvent, { type: "response.completed" }> | null = null;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;

  const signal = () => wake?.();
  const unsubscribeWire = input.client.onWireObservation?.((observation) => {
    observations.push(observation);
  });
  if (!unsubscribeWire) throw new Error(`${input.route.provider} adapter lacks sanitized wire observations`);
  const unsubscribeEvent = input.client.onEvent((event) => {
    if (event.type === "session.ready") ready = event;
    if (event.type === "output.audio") {
      if (event.format.encoding !== "pcm16" || event.format.sampleRateHz !== 24_000 || event.format.channels !== 1) {
        failure = new Error(`${input.route.provider} returned an unexpected output audio format`);
      } else if (event.audio.byteLength < 2 || event.audio.byteLength % 2 !== 0) {
        failure = new Error(`${input.route.provider} returned an invalid PCM chunk`);
      } else {
        const prior = chunksByResponse.get(event.responseId) ?? [];
        const total = prior.reduce((sum, chunk) => sum + chunk.byteLength, 0) + event.audio.byteLength;
        if (total > MAX_OUTPUT_PCM_BYTES) {
          failure = new Error(`${input.route.provider} exceeded the output-voice calibration audio limit`);
        } else {
          prior.push(new Uint8Array(event.audio));
          chunksByResponse.set(event.responseId, prior);
        }
      }
    } else if (event.type === "tool.calls" || event.type === "tool.dispatch") {
      failure = new Error(`${input.route.provider} attempted a tool call during voice calibration`);
    } else if (event.type === "response.completed") {
      if (completed && completed.responseId !== event.responseId) {
        failure = new Error(`${input.route.provider} produced multiple calibration responses`);
      } else {
        completed = event;
      }
    } else if (event.type === "error" && event.fatal) {
      failure = new Error(`${input.route.provider} reported a fatal realtime failure`);
    } else if (event.type === "connection.closed" && !completed) {
      failure = new Error(`${input.route.provider} closed before completing voice calibration`);
    }
    signal();
  });

  try {
    await input.client.connect();
    if (failure) throw failure;
    if (!ready) throw new Error(`${input.route.provider} connected without a session-ready receipt`);
    const trigger = createOutputVoiceCaptureTrigger(
      input.route.provider === "gemini" ? 16_000 : 24_000,
    );
    input.client.appendInputAudio(trigger);
    input.client.prepareResponse(responsePreparation(input.referenceText));
    input.client.commitInputAudio();
    input.client.createResponse();

    const deadline = Date.now() + input.timeoutMs;
    while (!completed && !failure) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${input.route.provider} output-voice calibration timed out`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, Math.min(remaining, 250));
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    }
    if (failure) throw failure;
    // Listener callbacks mutate this binding outside TypeScript's synchronous
    // control-flow graph; snapshot it after the wake loop.
    const terminalEvent = completed as Extract<NormalizedRealtimeEvent, { type: "response.completed" }> | null;
    if (!terminalEvent || terminalEvent.status !== "completed") {
      throw new Error(`${input.route.provider} did not complete the output-voice calibration response`);
    }
    const chunks = chunksByResponse.get(terminalEvent.responseId) ?? [];
    if (chunks.length === 0) throw new Error(`${input.route.provider} completed without output PCM`);
    if ([...chunksByResponse.keys()].some((responseId) => responseId !== terminalEvent.responseId)) {
      throw new Error(`${input.route.provider} emitted PCM for more than one response`);
    }
    const chain = verifyRealtimeWireObservationChain(observations);
    if (!chain.valid) throw new Error(`${input.route.provider} sanitized wire observation chain is invalid`);
    observationHash(ready, `${input.route.provider} session acknowledgement`);
    observationHash(terminalEvent, `${input.route.provider} response terminal`);
    let byteOffset = 0;
    const chunkRecords = Object.freeze(chunks.map((chunk, index) => {
      const record = Object.freeze({
        ordinal: index + 1,
        byteOffset,
        byteLength: chunk.byteLength,
        sha256: sha256Hex(chunk),
      });
      byteOffset += chunk.byteLength;
      return record;
    }));
    return Object.freeze({
      ready,
      completed: terminalEvent,
      responseId: terminalEvent.responseId,
      chunks: Object.freeze(chunks.map((chunk) => new Uint8Array(chunk))),
      chunkRecords,
      observations: Object.freeze([...observations]),
    });
  } finally {
    wake = null;
    unsubscribeEvent();
    unsubscribeWire();
    input.client.close(1000, "output voice calibration complete");
  }
}

function sanitizedWireJsonl(observations: readonly RealtimeWireObservation[]): string {
  return observations.map((observation) => canonicalJson(observation)).join("\n") + "\n";
}

function signCaptureReceipt(
  unsigned: Omit<OutputVoiceCalibrationCaptureReceipt, "signature" | "receiptSha256">,
  signer: OutputVoiceCaptureSigner,
): OutputVoiceCalibrationCaptureReceipt {
  const signatureBase64 = sign(null, outputVoiceCaptureSigningBytes(unsigned), signer.privateKey).toString("base64");
  const signature = Object.freeze({
    algorithm: "ed25519" as const,
    keyId: signer.authority.keyId,
    publicKeyPem: signer.authority.publicKeyPem,
    publicKeySha256: signer.authority.publicKeySha256,
    signatureBase64,
  });
  const receiptWithoutHash = Object.freeze({ ...unsigned, signature });
  return Object.freeze({
    ...receiptWithoutHash,
    receiptSha256: outputVoiceCaptureReceiptSha256(receiptWithoutHash),
  });
}

function sessionIdSha256(terminal: TerminalCapture): string {
  if (terminal.ready.sessionId) return realtimeWireIdentitySha256("session", terminal.ready.sessionId);
  const acknowledgementSha256 = observationHash(terminal.ready, "session acknowledgement");
  const observation = terminal.observations.find((candidate) => candidate.observationSha256 === acknowledgementSha256);
  return observation?.identities.sessionIdSha256
    ?? sha256Hex(`${SYNTHETIC_SESSION_DOMAIN}${terminal.ready.provider}\n${acknowledgementSha256}`);
}

async function captureOne(input: Readonly<{
  route: LongCallOutputVoiceRoute;
  slotId: string;
  createClient: OutputVoiceCaptureClientFactory;
  signer: OutputVoiceCaptureSigner;
  toolchain: OutputVoiceCaptureToolchain;
  responseTimeoutMs: number;
}>): Promise<OutputVoiceCaptureResult> {
  const referenceText = outputVoiceReferenceText(input.slotId);
  const referenceTextSha256 = sha256Hex(referenceText);
  const configuration = createOutputVoiceCaptureSessionConfiguration(input.route);
  const preparation = responsePreparation(referenceText);
  const trigger = createOutputVoiceCaptureTrigger(configuration.inputAudioFormat.sampleRateHz);
  const requestBodySha256 = sha256Hex(`${CAPTURE_REQUEST_DOMAIN}${canonicalJson({
    schemaVersion: 1,
    provider: input.route.provider,
    model: input.route.model,
    voice: input.route.voice,
    responsePreparation: preparation,
    trigger: {
      encoding: trigger.encoding,
      sampleRateHz: trigger.sampleRateHz,
      channels: trigger.channels,
      byteLength: trigger.data.byteLength,
      sha256: sha256Hex(trigger.data),
    },
  })}`);
  const client = await input.createClient(input.route.provider, configuration);
  if (client.provider !== input.route.provider) {
    throw new Error("output-voice capture client provider differs from its pinned route");
  }
  const terminal = await captureTerminal({
    client,
    route: input.route,
    referenceText,
    timeoutMs: input.responseTimeoutMs,
  });
  const acknowledgement = assertProviderAcknowledgement(
    input.route,
    terminal.ready.configuration ?? client.sessionConfigurationAcknowledgement ?? undefined,
  );
  const pcm = concatBytes(terminal.chunks);
  const pcmSha256 = sha256Hex(pcm);
  const wireJsonl = sanitizedWireJsonl(terminal.observations);
  const calibrationUnitId = outputVoiceCaptureUnitId(input.route, input.slotId);
  const terminalObservation = terminal.observations.find(
    (candidate) => candidate.observationSha256 === observationHash(terminal.completed, "response terminal"),
  );
  const unsignedReceipt = Object.freeze({
    schemaVersion: 1 as const,
    receiptType: "hacc_output_voice_calibration_capture" as const,
    captureId: calibrationUnitId,
    provider: input.route.provider,
    model: input.route.model,
    voice: input.route.voice,
    referenceTextSha256,
    pcmSha256,
    sampleRateHz: 24_000 as const,
    channels: 1 as const,
    encoding: "pcm16" as const,
    request: Object.freeze({
      sessionConfigurationSha256: configuration.conditionHash,
      requestBodySha256,
    }),
    providerReceipt: Object.freeze({
      receiptClass: "credential_neutral_provider_wire_receipt" as const,
      sessionIdSha256: sessionIdSha256(terminal),
      requestIdSha256: terminalObservation?.identities.responseIdSha256
        ?? realtimeWireIdentitySha256("response", terminal.responseId),
      acknowledgementKind: providerAcknowledgementKind(input.route.provider),
      acknowledgementEventSha256: observationHash(terminal.ready, "session acknowledgement"),
      acknowledgedModel: acknowledgement.acknowledgedModel,
      acknowledgedVoice: acknowledgement.acknowledgedVoice,
      terminalEventSha256: observationHash(terminal.completed, "response terminal"),
      credentialFieldsRetained: Object.freeze([] as const),
    }),
    wireCapture: Object.freeze({
      sanitizedEventLogSha256: sha256Hex(wireJsonl),
      outputChunks: terminal.chunkRecords,
      outputChunkSequenceSha256: outputVoiceChunkSequenceSha256(terminal.chunkRecords),
    }),
    captureToolchain: input.toolchain,
  });
  const receipt = signCaptureReceipt(unsignedReceipt, input.signer);
  const slot = LONG_CALL_ASR_SEMANTIC_SLOTS.find((candidate) => candidate.id === input.slotId)!;
  const fixture = Object.freeze({
    calibrationUnitId,
    provider: input.route.provider,
    model: input.route.model,
    voice: input.route.voice,
    family: slot.family,
    slotId: input.slotId,
    referenceText,
    referenceTextSha256,
    sampleRateHz: 24_000 as const,
    path: outputVoiceCaptureFixturePath(input.route, input.slotId),
    sha256: pcmSha256,
    byteLength: pcm.byteLength,
    captureReceipt: receipt,
  }) satisfies FrozenOutputVoiceCalibrationFixture;
  verifyOutputVoiceCalibrationPcm({
    fixture,
    pcm,
    expectedCaptureAuthoritySha256: input.signer.authority.publicKeySha256,
  });
  return Object.freeze({ fixture, pcm, sanitizedWireJsonl: wireJsonl });
}

/**
 * Captures all 18 pinned provider/voice/semantic-slot units in stable order.
 * Callers must treat any rejection as a failed transaction and publish none of
 * the returned or staged material.
 */
export async function captureOutputVoiceCalibration(
  options: OutputVoiceCaptureOptions,
): Promise<OutputVoiceCaptureBatch> {
  assertSha256(options.signer.authority.publicKeySha256, "capture authority fingerprint");
  assertSha256(options.toolchain.implementationSha256, "capture implementation hash");
  assertSha256(options.toolchain.sourceCommitSha256, "capture source commit hash");
  if (options.signer.privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("output-voice capture private key must use Ed25519");
  }
  const publicKey = createPublicKey(options.signer.privateKey).export({ format: "pem", type: "spki" }).toString();
  if (publicKey !== options.signer.authority.publicKeyPem
    || sha256Hex(createPublicKey(publicKey).export({ format: "der", type: "spki" }))
      !== options.signer.authority.publicKeySha256) {
    throw new Error("output-voice capture private key differs from its preregistered authority");
  }
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1_000 || responseTimeoutMs > 120_000) {
    throw new Error("output-voice response timeout must be between 1 and 120 seconds");
  }
  const captures: OutputVoiceCaptureResult[] = [];
  for (const route of LONG_CALL_ASR_OUTPUT_VOICE_ROUTES) {
    for (const slotId of outputVoiceCaptureSlotIds()) {
      captures.push(await captureOne({
        route,
        slotId,
        createClient: options.createClient,
        signer: options.signer,
        toolchain: options.toolchain,
        responseTimeoutMs,
      }));
    }
  }
  const manifest = createOutputVoiceCalibrationManifest(captures.map((capture) => capture.fixture));
  validateOutputVoiceCalibrationFixtures({
    fixtures: manifest.fixtures,
    manifestSha256: manifest.manifestSha256,
  });
  return Object.freeze({ manifest, captures: Object.freeze(captures) });
}
