import { createHmac, createPublicKey, verify as verifyBytes } from "node:crypto";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertCallerAudioFixtureManifestSemantics,
  hashCallerAudioSequence,
  readFrozenFixtureFileNoFollow,
} from "./audio-fixtures";
import { createBudgetLedger, microUsdToDecimal } from "./budget";
import type { PaidBenchmarkRunInput, PaidBenchmarkRunResult } from "./benchmark-cli";
import {
  assertConditionParity,
  compileConditionSuite,
  type CompiledBenchmarkCondition,
  type CompiledConditionSuite,
} from "./condition-compiler";
import {
  cancelFilesystemBudgetBeforeOpen,
  filesystemBudgetLedgerContainsHead,
  inspectFilesystemBudgetLedger,
  markBudgetConnectionIntent,
  markBudgetSessionOpened,
  recordBudgetTerminal,
  reserveFilesystemBudget,
  settleFilesystemBudget,
  type BudgetJournalReservation,
} from "./filesystem-budget-ledger";
import { InMemoryBenchmarkGatewayKernel } from "./gateway-kernel";
import {
  createPairedAudioManifest,
  runBenchmarkTrial,
  type TrialJournalFinalization,
  type TrialJournalRecord,
  type TrialJournalSink,
  type TrialClock,
  type TrialSleep,
  type TrialSessionConfiguration,
} from "./orchestrator";
import {
  verifyProviderTransportEvidence,
  type ProviderTransportEvidence,
} from "./provider-transport-evidence";
import {
  createProviderTransportPacket,
  providerTransportEvidenceDescriptorSha256,
  serializeProviderTransportPacket,
  verifyProviderTransportPacket,
  type ProviderTransportPacket,
  type ProviderTransportPacketSubject,
} from "./provider-transport-packet-signature";
import {
  parseCanonicalBenchmarkExecutionPlan,
  parseCanonicalBenchmarkFreezeLock,
  serializeBenchmarkExecutionPlan,
  serializeBenchmarkFreezeLock,
  benchmarkFreezeLockSha256,
  verifyExecutionPlanAgainstFreeze,
} from "./execution-plan";
import {
  benchmarkKernelAttestationJson,
  benchmarkKernelAttestationPublicKeyFingerprint,
  verifyBenchmarkKernelFinalAttestation,
  type BenchmarkKernelAttestationTrust,
  type BenchmarkKernelEvidenceBinding,
} from "./kernel-attestation";
import { verifyKernelTranscript } from "./kernel-transcript";
import { assertLongHorizonExecutionAuthorization } from "./long-horizon-execution";
import type { LongHorizonPcmTurn } from "./long-horizon-scenario-suite";
import { CrashDurableRunJournal } from "./run-journal";
import {
  SCENARIO_SOURCE_REGISTRY_HASH,
  resolveScenarioSource,
  type RegisteredScenarioSource,
} from "./scenario-source-registry";
import { TRANSPORT_SMOKE_SCENARIO_ID } from "./transport-smoke-scenario";
import {
  createOpenAIRealtimeClient,
  createXaiRealtimeClient,
} from "../realtime/client/openai-compatible";
import {
  GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS,
  GeminiLiveClient,
} from "../realtime/client/gemini-live";
import type { NormalizedRealtimeClient, NormalizedRealtimeUsage } from "../realtime/client/types";
import type { RealtimeWireObservation } from "../realtime/client/types";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";
import { GEMINI_PROVIDER_TRANSCRIPTION_POLICY } from "../realtime/gemini-policy";
import { verifyPaidReleaseGate, verifyPreCanaryProofPacket } from "./pre-canary-proof";
import {
  GATE_1_PROVIDER_RESERVATION_MICRO_USD,
  parseCanonicalProviderPricingProof,
  providerHardSessionCapsSha256,
  providerPricingProofCostEnvelope,
  serializeProviderPricingProof,
} from "./provider-pricing-proof";

const SESSION_SETTINGS_DOMAIN = "harshas-amazing-call-center/benchmark-session-settings/v1\n";
const SIGNER_CHALLENGE_DOMAIN = "hacc/paid-kernel-attestation-signer-challenge/v1\n";

type PaidLifecycle = Readonly<{
  ledgerPath: string;
  reservationId: string;
  operationPrefix: string;
}>;

export type PaidRunnerDependencies = Readonly<{
  createClient?: (
    input: PaidBenchmarkRunInput,
    configuration: TrialSessionConfiguration,
    apiKey: string
  ) => NormalizedRealtimeClient | Promise<NormalizedRealtimeClient>;
  /** Test seam only; paid CLI execution uses wall-clock time. */
  now?: () => Date;
  /** Test seam only; production paid execution uses real pacing and monotonic time. */
  sleep?: TrialSleep;
  /** Test seam only; prevents host load from turning immediate fake events into timeout flakes. */
  clock?: TrialClock;
}>;

class PaidTrialJournalSink implements TrialJournalSink {
  constructor(
    private readonly journal: CrashDurableRunJournal,
    private readonly lifecycle: PaidLifecycle
  ) {}

  async beforeClientCreate(record: TrialJournalRecord): Promise<void> {
    const mutation = await markBudgetConnectionIntent({
      ledgerPath: this.lifecycle.ledgerPath,
      operationId: `${this.lifecycle.operationPrefix}:connection-intent`,
      reservationId: this.lifecycle.reservationId,
    });
    await this.journal.append("budget.connection_intent_durable", {
      budget_head_sha256: mutation.snapshot.head_sha256,
      reservation_status: "opening",
    });
    await this.append(record);
  }

  async onSessionOpened(record: TrialJournalRecord): Promise<void> {
    const mutation = await markBudgetSessionOpened({
      ledgerPath: this.lifecycle.ledgerPath,
      operationId: `${this.lifecycle.operationPrefix}:session-opened`,
      reservationId: this.lifecycle.reservationId,
    });
    await this.journal.append("budget.session_opened_durable", {
      budget_head_sha256: mutation.snapshot.head_sha256,
      reservation_status: "opened",
    });
    await this.append(record);
  }

  async append(record: TrialJournalRecord): Promise<void> {
    await this.journal.append(`runner.${record.category}.${record.event_type}`, record);
  }

  async finalize(result: TrialJournalFinalization): Promise<void> {
    // The runner's own in-memory budget is settled here, but the filesystem
    // liability is settled by executePaidBenchmarkRun after the result returns.
    // Therefore this is a WAL record, not the atomic partial->complete rename.
    await this.journal.append("runner.finalization_ready", result);
  }
}

export function benchmarkPaidSessionDescriptor(
  plan: PaidBenchmarkRunInput["plan"],
  configuration: TrialSessionConfiguration
): Record<string, unknown> {
  const common = {
    provider: plan.cell.provider,
    model: plan.cell.model,
    voice: plan.cell.voice,
    condition_hash: configuration.conditionHash,
    initial_prompt_hash: plan.prompt_hash,
    provider_tools_hash: plan.provider_tools_hash,
    tool_choice: "auto",
    input_audio: {
      encoding: configuration.inputAudioFormat.encoding,
      sample_rate_hz: configuration.inputAudioFormat.sampleRateHz,
      channels: configuration.inputAudioFormat.channels,
      turn_detection: "manual",
    },
    output_audio: {
      encoding: "pcm16",
      sample_rate_hz: 24_000,
      channels: 1,
    },
    audio_delivery_profile: configuration.audioDeliveryProfile,
    audio_delivery_profile_hash: configuration.audioDeliveryProfileHash,
    session_continuity: plan.session_continuity,
    hard_limits: plan.limits,
    provider_transcription: GEMINI_PROVIDER_TRANSCRIPTION_POLICY,
  };
  return Object.freeze(common);
}

export function benchmarkPaidSessionSettingsSha256(
  plan: PaidBenchmarkRunInput["plan"],
  configuration: TrialSessionConfiguration
): string {
  return sha256Hex(`${SESSION_SETTINGS_DOMAIN}${canonicalJson(benchmarkPaidSessionDescriptor(plan, configuration))}`);
}

/** Construct the pinned real adapter without opening a socket or spending. */
export function createProviderClient(
  input: PaidBenchmarkRunInput,
  configuration: TrialSessionConfiguration,
  apiKey: string
): NormalizedRealtimeClient {
  const expectedInputRate = input.plan.cell.provider === "gemini" ? 16_000 : 24_000;
  if (
    configuration.inputAudioFormat.encoding !== "pcm16"
    || configuration.inputAudioFormat.channels !== 1
    || configuration.inputAudioFormat.sampleRateHz !== expectedInputRate
  ) {
    throw new Error("runner session input audio format is not provider-native PCM16");
  }
  if (
    configuration.audioDeliveryProfileHash !== input.plan.audio_delivery.profile_sha256
    || configuration.audioDeliveryProfile.schemaVersion !== input.plan.audio_delivery.schemaVersion
    || configuration.audioDeliveryProfile.chunkMs !== input.plan.audio_delivery.chunkMs
    || configuration.audioDeliveryProfile.pace !== input.plan.audio_delivery.pace
  ) {
    throw new Error("runner audio delivery profile differs from the paid plan");
  }
  const pin = input.freeze.provider_pins.find((candidate) =>
    candidate.provider === input.plan.cell.provider
    && candidate.model === input.plan.cell.model
    && candidate.voice === input.plan.cell.voice
  );
  if (!pin) throw new Error("frozen provider pin is missing");
  const settingsHash = benchmarkPaidSessionSettingsSha256(input.plan, configuration);
  if (settingsHash !== pin.session_settings_sha256) {
    throw new Error("provider session settings do not match the frozen settings hash");
  }

  if (input.plan.cell.provider === "gemini") {
    if (input.plan.limits.maxSessionMs > GEMINI_LIVE_MAX_AUDIO_ONLY_SESSION_MS) {
      throw new Error("Gemini paid session exceeds the provider-native audio-only duration cap");
    }
    return new GeminiLiveClient({
      apiKey,
      model: input.plan.cell.model,
      voice: input.plan.cell.voice,
      instructions: configuration.instructions,
      tools: configuration.providerTools,
      connectTimeoutMs: input.plan.limits.sessionReadyTimeoutMs,
      maximumSessionDurationMs: input.plan.limits.maxSessionMs,
    });
  }

  const sessionUpdate = input.plan.cell.provider === "openai"
    ? {
        type: "session.update",
        session: {
          type: "realtime",
          model: input.plan.cell.model,
          instructions: configuration.instructions,
          audio: {
            input: {
              transcription: null,
              turn_detection: null,
            },
            output: { voice: input.plan.cell.voice },
          },
          tools: configuration.providerTools,
          tool_choice: "auto",
        },
      }
    : {
        type: "session.update",
        session: {
          voice: input.plan.cell.voice,
          instructions: configuration.instructions,
          turn_detection: null,
          audio: {
            input: {},
            output: {},
          },
          tools: configuration.providerTools,
          tool_choice: "auto",
        },
      };

  return input.plan.cell.provider === "openai"
    ? createOpenAIRealtimeClient({
      apiKey,
      model: input.plan.cell.model,
      sessionUpdate,
      connectTimeoutMs: input.plan.limits.sessionReadyTimeoutMs,
      requireStrictSessionConfigurationParity: true,
      })
    : createXaiRealtimeClient({
        apiKey,
        model: input.plan.cell.model,
      sessionUpdate,
        connectTimeoutMs: input.plan.limits.sessionReadyTimeoutMs,
        enableResumption: false,
        requireStrictSessionConfigurationParity: true,
      });
}

function isSafeFixtureDescriptorPath(path: unknown): path is string {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > 1_024
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
  ) {
    return false;
  }
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Resolve every byte of paid caller audio while execution is still entirely
 * synchronous. A VerifiedFrozenCallerAudio is an integrity statement made by
 * the loader, but direct TypeScript callers can forge the structural type or
 * mutate readPcm after this async function reaches its first await. Recheck the
 * exact plan/manifest/registry binding here and retain only detached bytes.
 */
function snapshotFixtureCallerTurnsBeforeAwait(
  input: PaidBenchmarkRunInput,
  source: RegisteredScenarioSource
): readonly LongHorizonPcmTurn[] {
  const rendition = input.fixtureRendition;
  const sampleRateHz = rendition === "pcm16le_mono_16000" ? 16_000 : 24_000;
  if (rendition !== input.plan.fixture.rendition) {
    throw new Error("paid caller fixture rendition differs from the execution plan");
  }

  // Clone the complete manifest before invoking caller-controlled readPcm.
  // This prevents the reader itself from changing a descriptor between lookup
  // and verification.
  const expectedTurns = Object.freeze(source.scenario.caller.turns.map((turn) => Object.freeze({
    id: turn.id,
    text: turn.utterance,
    pause_after_ms: 0,
  })));
  const manifest = assertCallerAudioFixtureManifestSemantics({
    manifest: JSON.parse(canonicalJson(input.fixture.manifest)),
    expectedScenario: {
      id: source.scenarioId,
      version: source.scenarioVersion,
      canonical_sha256: source.scenarioContentHash,
    },
    expectedTurns,
    expectedManifestSha256: input.plan.fixture.manifest_sha256,
  });
  if (
    manifest.manifest_sha256 !== input.plan.fixture.manifest_sha256
    || manifest.manifest_sha256 !== input.freeze.fixture_manifest_sha256
    || manifest.caller_sequence_sha256 !== input.plan.fixture.caller_sequence_sha256
    || manifest.caller_sequence_sha256 !== input.freeze.caller_sequence_sha256
    || hashCallerAudioSequence(expectedTurns)
      !== input.plan.fixture.caller_sequence_sha256
  ) {
    throw new Error("paid caller fixture differs from the execution plan, freeze, or registered caller sequence");
  }
  if (manifest.turns.length !== source.scenario.caller.turns.length) {
    throw new Error("paid caller fixture turn count differs from the registered caller sequence");
  }

  const readPcm = input.fixture.readPcm;
  if (typeof readPcm !== "function") {
    throw new Error("paid caller fixture has no synchronous PCM reader");
  }
  const descriptorPaths = new Set<string>();
  const callerTurns = source.scenario.caller.turns.map((turn, index) => {
    const manifestTurn = manifest.turns[index];
    if (
      !manifestTurn
      || manifestTurn.ordinal !== index
      || manifestTurn.caller_turn_id !== turn.id
    ) {
      throw new Error(`paid caller fixture turn ${index} differs from the registered caller sequence`);
    }
    const descriptor = manifestTurn.renditions[rendition];
    if (
      !descriptor
      || !isSafeFixtureDescriptorPath(descriptor.path)
      || descriptorPaths.has(descriptor.path)
      || descriptor.sample_rate_hz !== sampleRateHz
      || descriptor.channels !== 1
      || descriptor.sample_format !== "s16le"
      || !Number.isSafeInteger(descriptor.byte_length)
      || descriptor.byte_length <= 0
      || descriptor.byte_length % 2 !== 0
      || !Number.isSafeInteger(descriptor.sample_count)
      || descriptor.sample_count * 2 !== descriptor.byte_length
    ) {
      throw new Error(`paid caller fixture PCM descriptor is invalid for turn ${turn.id}`);
    }
    descriptorPaths.add(descriptor.path);

    const supplied = readPcm.call(input.fixture, turn.id, rendition);
    if (!(supplied instanceof Uint8Array)) {
      throw new Error(`paid caller fixture PCM reader returned invalid bytes for ${descriptor.path}`);
    }
    const detached = Uint8Array.from(supplied);
    if (
      detached.byteLength !== descriptor.byte_length
      || sha256Hex(detached) !== descriptor.sha256
    ) {
      throw new Error(`paid caller fixture PCM bytes differ from frozen descriptor ${descriptor.path}`);
    }
    return Object.freeze({
      turnId: turn.id,
      audio: Object.freeze({
        encoding: "pcm16" as const,
        sampleRateHz,
        channels: 1 as const,
        data: detached,
      }),
    });
  });
  return Object.freeze(callerTurns);
}

type TrustedPaidSource = Readonly<{
  source: RegisteredScenarioSource;
  suite: CompiledConditionSuite;
  condition: CompiledBenchmarkCondition;
}>;

type PaidAttestationContext = Readonly<{
  evidenceBinding: BenchmarkKernelEvidenceBinding;
  trust: BenchmarkKernelAttestationTrust;
}>;

async function verifyPaidReleaseBeforeSpend(
  input: PaidBenchmarkRunInput,
  now: Date,
): Promise<void> {
  const release = verifyPaidReleaseGate(input.preCanaryPacket, {
    provider: input.plan.cell.provider,
    model: input.plan.cell.model,
    evidenceClass: input.plan.mode as "canary" | "pilot" | "confirmatory",
    sourceCommit: input.freeze.source_commit,
    sourceTree: input.freeze.source_tree,
    freezeLockSha256: benchmarkFreezeLockSha256(input.freeze),
    ledgerId: input.plan.ledger_id,
    now,
  });
  if (!release.valid || !release.value) {
    throw new Error(`paid release gate is invalid: ${release.errors.join(",")}`);
  }
  const proof = input.providerPricingProof;
  const selectedProof = release.value.providerPricingProof;
  if (!proof) {
    throw new Error("paid execution inputs differ from the plan-bound Gate 0 pricing proof");
  }
  if (
    canonicalJson(input.plan.cost_envelope)
    !== canonicalJson(providerPricingProofCostEnvelope(
      proof,
      input.plan.cost_envelope.runner_config_sha256,
    ))
  ) {
    throw new Error("paid cost envelope is not the exact Gate 0 pricing proof decomposition");
  }
  if (
    canonicalJson(proof) !== canonicalJson(selectedProof)
    || input.preCanaryPacket.packet_sha256
      !== input.plan.release_gate.pre_canary_packet_sha256
    || proof.proof_sha256
      !== input.plan.release_gate.provider_pricing_proof_sha256
    || providerHardSessionCapsSha256(proof.caps)
      !== input.plan.release_gate.provider_hard_session_caps_sha256
    || proof.derived.pricing_snapshot_sha256
      !== input.plan.release_gate.pricing_snapshot_sha256
    || proof.derived.formula_sha256
      !== input.plan.release_gate.pricing_formula_sha256
    || proof.derived.reservation_micro_usd
      !== input.plan.release_gate.reservation_micro_usd
    || proof.derived.conservative_liability_micro_usd
      !== input.plan.release_gate.conservative_liability_micro_usd
    || proof.derived.reservation_micro_usd
      !== GATE_1_PROVIDER_RESERVATION_MICRO_USD
    || input.plan.maximum_micro_usd
      !== GATE_1_PROVIDER_RESERVATION_MICRO_USD
    || input.plan.cost_envelope.pricing_snapshot_sha256
      !== proof.derived.pricing_snapshot_sha256
    || input.plan.cost_envelope.formula_sha256
      !== proof.derived.formula_sha256
    || input.plan.cost_envelope.provider_hard_session_caps_sha256
      !== proof.derived.hard_session_caps_sha256
    || proof.caps.max_session_ms !== input.plan.limits.maxSessionMs
    || proof.caps.max_input_audio_bytes !== input.plan.limits.maxInputAudioBytes
    || proof.caps.max_output_audio_bytes !== input.plan.limits.maxOutputAudioBytes
    || proof.caps.max_tool_calls !== input.plan.limits.maxToolCalls
  ) {
    throw new Error("paid execution inputs differ from the plan-bound Gate 0 pricing proof");
  }
  const gate0LedgerHead = input.preCanaryPacket.budget.ledger_head_sha256;
  const currentLedger = await inspectFilesystemBudgetLedger({
    ledgerPath: input.ledgerPath,
  });
  if (
    !gate0LedgerHead
    || currentLedger.ledger_id !== input.plan.ledger_id
    || !await filesystemBudgetLedgerContainsHead({
      ledgerPath: input.ledgerPath,
      ancestorHeadSha256: gate0LedgerHead,
    })
  ) {
    throw new Error("current budget ledger does not descend from the exact Gate 0 paused-zero head");
  }
}

/**
 * Re-establish the complete signer/trust identity at the runner boundary.
 * The CLI validates this before loading provider credentials, but the runner
 * is exported and therefore must independently fail closed before reservation
 * or any network-capable client can be constructed.
 */
function verifyPaidAttestationBeforeSpend(
  input: PaidBenchmarkRunInput,
  now: Date
): PaidAttestationContext {
  // Re-serialize first so a caller cannot pass a structurally typed plan whose
  // body no longer matches its plan_sha256.
  serializeBenchmarkExecutionPlan(input.plan);
  verifyExecutionPlanAgainstFreeze({ plan: input.plan, freeze: input.freeze, now });

  const pin = input.plan.kernel_attestation;
  const signer = input.kernelAttestationSigner;
  const publicKeyFingerprint = benchmarkKernelAttestationPublicKeyFingerprint(pin.public_key_pem);
  if (
    pin.algorithm !== "ed25519"
    || signer.algorithm !== pin.algorithm
    || signer.keyId !== pin.key_id
    || signer.publicKeySha256 !== pin.public_key_fingerprint_sha256
    || publicKeyFingerprint !== pin.public_key_fingerprint_sha256
  ) {
    throw new Error("paid kernel attestation signer differs from the freeze- and plan-pinned trust root");
  }
  const challenge = `${SIGNER_CHALLENGE_DOMAIN}${canonicalJson({
    plan_sha256: input.plan.plan_sha256,
    freeze_lock_sha256: input.plan.freeze_lock_sha256,
    run_id: input.plan.cell.run_id,
    pair_id: input.plan.cell.pair_id,
  })}`;
  let signature: string;
  try {
    signature = signer.sign(challenge);
    const decoded = Buffer.from(signature, "base64");
    if (
      decoded.byteLength !== 64
      || decoded.toString("base64") !== signature
      || !verifyBytes(null, Buffer.from(challenge, "utf8"), createPublicKey(pin.public_key_pem), decoded)
    ) {
      throw new Error("invalid signer challenge");
    }
  } catch {
    throw new Error("paid kernel attestation signer cannot prove possession of the pinned private key");
  }

  const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
    pairId: input.plan.cell.pair_id,
    leaseSubjectId: input.plan.cell.pair_id,
    provider: input.plan.cell.provider,
    model: input.plan.cell.model,
    planSha256: input.plan.plan_sha256,
    freezeLockSha256: input.plan.freeze_lock_sha256,
    kernelBuildSha256: input.freeze.gateway_sha256,
  });
  if (
    evidenceBinding.pairId !== input.plan.cell.pair_id
    || evidenceBinding.leaseSubjectId !== input.plan.cell.pair_id
    || evidenceBinding.provider !== input.plan.cell.provider
    || evidenceBinding.model !== input.plan.cell.model
  ) {
    throw new Error("paid kernel attestation evidence identity differs from the execution cell");
  }
  return Object.freeze({
    evidenceBinding,
    trust: Object.freeze({
      keyId: pin.key_id,
      publicKeySha256: pin.public_key_fingerprint_sha256,
      publicKeyPem: pin.public_key_pem,
    }),
  });
}

/**
 * Rebuild the scientific input from the closed registry before reading a
 * credential, touching the budget journal, or constructing a provider client.
 * Callers cannot smuggle a different flow/instruction/tool compiler input into
 * the paid boundary while preserving only the public scenario identity.
 */
function verifyPaidSourceBeforeSpend(input: PaidBenchmarkRunInput): TrustedPaidSource {
  const source = resolveScenarioSource(input.scenario);
  if (
    input.plan.scenario.id !== source.scenarioId
    || input.plan.scenario.version !== source.scenarioVersion
    || input.plan.scenario.canonical_sha256 !== source.scenarioContentHash
    || input.plan.scenario.registry_key !== source.registryKey
    || input.plan.scenario.registry_entry_sha256 !== source.registryEntryHash
    || input.plan.scenario.registry_catalog_sha256 !== SCENARIO_SOURCE_REGISTRY_HASH
    || input.freeze.scenario_source_registry_sha256 !== SCENARIO_SOURCE_REGISTRY_HASH
  ) {
    throw new Error("paid scenario source does not match the closed source registry");
  }

  const suite = compileConditionSuite(source.compilerInput);
  assertConditionParity(suite);
  if (
    input.suiteFlowHash !== suite.flowHash
    || input.suiteScenarioHash !== suite.scenarioHash
    || input.suiteSourceHash !== suite.sourceHash
  ) {
    throw new Error("paid compiler suite binding differs from the registered source");
  }
  const condition = suite.conditions[input.plan.cell.condition];
  if (
    input.plan.condition_hash !== condition.conditionHash
    || input.plan.prompt_hash !== condition.initialPromptHash
    || input.plan.provider_tools_hash !== condition.providerToolsHash
    || canonicalJson(input.condition) !== canonicalJson(condition)
  ) {
    throw new Error("paid condition differs from the registry-derived compiler output");
  }
  return Object.freeze({ source, suite, condition });
}

async function preserveFinalLiability(input: Readonly<{
  lifecycle: PaidLifecycle;
  maximumUsd: string;
}>): Promise<string> {
  const current = await inspectFilesystemBudgetLedger({ ledgerPath: input.lifecycle.ledgerPath });
  const reservation = current.reservations.find((candidate) => candidate.reservation_id === input.lifecycle.reservationId);
  if (!reservation) throw new Error("paid reservation disappeared from the filesystem ledger");
  if (reservation.status === "reserved") {
    const cancelled = await cancelFilesystemBudgetBeforeOpen({
      ledgerPath: input.lifecycle.ledgerPath,
      operationId: `${input.lifecycle.operationPrefix}:cancel-before-open`,
      reservationId: input.lifecycle.reservationId,
    });
    return cancelled.snapshot.head_sha256;
  }
  if (reservation.status === "opening" || reservation.status === "opened") {
    await recordBudgetTerminal({
      ledgerPath: input.lifecycle.ledgerPath,
      operationId: `${input.lifecycle.operationPrefix}:terminal-failed`,
      reservationId: input.lifecycle.reservationId,
      outcome: "failed",
    });
  }
  const afterTerminal = await inspectFilesystemBudgetLedger({ ledgerPath: input.lifecycle.ledgerPath });
  const afterReservation = afterTerminal.reservations.find((candidate) => candidate.reservation_id === input.lifecycle.reservationId);
  if (afterReservation?.status === "terminal_unsettled") {
    const settled = await settleFilesystemBudget({
      ledgerPath: input.lifecycle.ledgerPath,
      operationId: `${input.lifecycle.operationPrefix}:settle-failed`,
      reservationId: input.lifecycle.reservationId,
      estimatedUsd: input.maximumUsd,
    });
    return settled.snapshot.head_sha256;
  }
  return afterTerminal.head_sha256;
}

function reservationStatus(
  reservations: readonly BudgetJournalReservation[],
  reservationId: string
): BudgetJournalReservation["status"] | "missing" {
  return reservations.find((reservation) => reservation.reservation_id === reservationId)?.status ?? "missing";
}

function verifyHumanConfirmationBeforeSpend(input: PaidBenchmarkRunInput): void {
  const exactMaximum = microUsdToDecimal(input.plan.maximum_micro_usd);
  if (
    !input.humanConfirmation
    || input.humanConfirmation.plan_sha256 !== input.plan.plan_sha256
  ) {
    throw new Error("paid executor requires the exact human-confirmed plan SHA-256");
  }
  if (
    input.plan.maximum_micro_usd !== GATE_1_PROVIDER_RESERVATION_MICRO_USD
    || input.humanConfirmation.maximum_usd !== exactMaximum
    || input.humanConfirmation.maximum_usd !== "5"
  ) {
    throw new Error("paid executor requires the exact human-confirmed $5 maximum");
  }
}

function verifyCredentialAuthorityBeforeSpend(input: PaidBenchmarkRunInput): void {
  const hasResolvedEnvironment = input.environment !== undefined;
  const hasLazyResolver = input.resolveCredentialEnvironment !== undefined;
  if (hasResolvedEnvironment === hasLazyResolver) {
    throw new Error("paid executor requires exactly one credential environment authority");
  }
  if (
    hasLazyResolver
    && typeof input.resolveCredentialEnvironment !== "function"
  ) {
    throw new Error("paid executor credential environment resolver is invalid");
  }
}

/**
 * Paid execution boundary. Every network-capable client is constructed only
 * inside the orchestrator after: atomic filesystem reservation, partial WAL,
 * frozen input audio persistence, and durable connection intent.
 */
export async function executePaidBenchmarkRun(
  untrustedInput: PaidBenchmarkRunInput,
  dependencies: PaidRunnerDependencies = {}
): Promise<PaidBenchmarkRunResult> {
  // Snapshot every caller-controlled authority object synchronously before the
  // first await. Zod/canonical parsers create detached validated object graphs,
  // so a direct caller cannot mutate nested plan/proof/freeze fields after
  // confirmation but before reservation.
  const packetVerification = verifyPreCanaryProofPacket(
    JSON.parse(canonicalJson(untrustedInput.preCanaryPacket)),
  );
  if (!packetVerification.valid || !packetVerification.packet) {
    throw new Error("paid executor requires a canonical verified Gate 0 packet");
  }
  const input: PaidBenchmarkRunInput = Object.freeze({
    ...untrustedInput,
    plan: parseCanonicalBenchmarkExecutionPlan(
      serializeBenchmarkExecutionPlan(untrustedInput.plan),
    ),
    freeze: parseCanonicalBenchmarkFreezeLock(
      serializeBenchmarkFreezeLock(untrustedInput.freeze),
    ),
    providerPricingProof: parseCanonicalProviderPricingProof(
      serializeProviderPricingProof(untrustedInput.providerPricingProof),
    ),
    preCanaryPacket: packetVerification.packet,
    humanConfirmation: Object.freeze({ ...untrustedInput.humanConfirmation }),
  });
  verifyHumanConfirmationBeforeSpend(input);
  verifyCredentialAuthorityBeforeSpend(input);
  const trusted = verifyPaidSourceBeforeSpend(input);
  const callerTurns = snapshotFixtureCallerTurnsBeforeAwait(input, trusted.source);
  const now = (dependencies.now ?? (() => new Date()))();
  await verifyPaidReleaseBeforeSpend(input, now);
  const attestation = verifyPaidAttestationBeforeSpend(input, now);
  const trustedInput: PaidBenchmarkRunInput = Object.freeze({
    ...input,
    scenario: trusted.source.scenario,
    condition: trusted.condition,
    scenarioSource: trusted.source,
    suiteFlowHash: trusted.suite.flowHash,
    suiteScenarioHash: trusted.suite.scenarioHash,
    suiteSourceHash: trusted.suite.sourceHash,
  });
  assertLongHorizonExecutionAuthorization(input.plan.long_horizon_authorization, {
    scenario: trusted.source.scenario,
    callerPcm: callerTurns,
    mode: input.plan.mode as "canary" | "pilot" | "confirmatory",
    maxSessionMs: input.plan.limits.maxSessionMs,
    preregistrationSha256: input.freeze.preregistration_sha256,
    conditionSuiteSha256: trusted.suite.suiteHash,
    runnerConfigSha256: input.plan.cost_envelope.runner_config_sha256,
  });
  const pairedAudio = createPairedAudioManifest({
    pairId: input.plan.cell.pair_id,
    scenario: trusted.source.scenario,
    callerTurns,
    audioDeliveryProfile: {
      schemaVersion: input.plan.audio_delivery.schemaVersion,
      chunkMs: input.plan.audio_delivery.chunkMs,
      pace: input.plan.audio_delivery.pace,
    },
  });
  if (
    pairedAudio.pair_id !== attestation.evidenceBinding.pairId
    || pairedAudio.pair_id !== attestation.evidenceBinding.leaseSubjectId
    || pairedAudio.scenario_id !== input.plan.scenario.id
    || pairedAudio.scenario_version !== input.plan.scenario.version
  ) {
    throw new Error("paid kernel evidence identity differs from the frozen paired-audio manifest");
  }
  const operationPrefix = `paid:${input.plan.plan_sha256}:${input.plan.cell.run_id}`;
  const lifecycle: PaidLifecycle = Object.freeze({
    ledgerPath: input.ledgerPath,
    reservationId: input.plan.cell.reservation_id,
    operationPrefix,
  });
  const maximumUsd = microUsdToDecimal(input.plan.maximum_micro_usd);
  const credentialName = input.plan.cell.provider === "openai"
    ? "OPENAI_API_KEY"
    : input.plan.cell.provider === "xai"
      ? "XAI_API_KEY"
      : "GEMINI_API_KEY";
  const requiredAncestorHeadSha256 = input.preCanaryPacket.budget.ledger_head_sha256;
  if (!requiredAncestorHeadSha256) {
    throw new Error("Gate 0 packet does not contain a budget-ledger head");
  }

  const reserved = await reserveFilesystemBudget({
    ledgerPath: input.ledgerPath,
    operationId: `${operationPrefix}:reserve`,
    reservationId: input.plan.cell.reservation_id,
    runId: input.plan.cell.run_id,
    provider: input.plan.cell.provider,
    model: input.plan.cell.model,
    condition: input.plan.cell.condition,
    expiresAt: input.plan.reservation_expires_at,
    costEnvelope: input.plan.cost_envelope,
    expectedLedgerId: input.plan.ledger_id,
    requiredAncestorHeadSha256,
    requiredCurrentHeadSha256: input.plan.reservation_authority.ledger_open_head_sha256,
    planConsumption: {
      consumptionId: input.plan.reservation_authority.consumption_id,
      planSha256: input.plan.plan_sha256,
      maximumMicroUsd: input.plan.maximum_micro_usd,
    },
  });
  let journal: CrashDurableRunJournal | null = null;
  let credentialBoundaryReady = false;
  try {
    journal = await CrashDurableRunJournal.create({
      outputRoot: input.outputRoot,
      planSha256: input.plan.plan_sha256,
      runId: input.plan.cell.run_id,
      canonicalPlan: serializeBenchmarkExecutionPlan(input.plan),
    });
    await journal.append("budget.reservation_durable", {
      ledger_id: reserved.snapshot.ledger_id,
      budget_head_sha256: reserved.snapshot.head_sha256,
      reservation_id: input.plan.cell.reservation_id,
      maximum_micro_usd: input.plan.maximum_micro_usd,
      reservation_status: reservationStatus(reserved.snapshot.reservations, input.plan.cell.reservation_id),
    });
    // Credential discovery happens only after both the one-shot reservation
    // and its private crash-durable partial exist. Resolver/require failures
    // therefore retain pessimistic reserved liability plus the inspectable
    // partial without making any provider client reachable.
    const environment = input.resolveCredentialEnvironment
      ? await input.resolveCredentialEnvironment()
      : input.environment!;
    let apiKey: string;
    try {
      apiKey = environment.require(credentialName);
    } catch {
      throw new Error(`required ${credentialName} credential is unavailable`);
    }
    await journal.registerKnownSecrets([apiKey]);
    credentialBoundaryReady = true;

    for (const turn of callerTurns) {
      const audio = turn.audio as { data: Uint8Array };
      await journal.writeBlob(`frozen-input/${turn.turnId}.pcm`, audio.data);
    }
    await journal.append("fixture.frozen_bytes_loaded", {
      manifest_sha256: input.plan.fixture.manifest_sha256,
      caller_sequence_sha256: input.plan.fixture.caller_sequence_sha256,
      rendition: input.plan.fixture.rendition,
      turns: callerTurns.length,
    });

    const sink = new PaidTrialJournalSink(journal, lifecycle);
    const gatewayKernel = new InMemoryBenchmarkGatewayKernel({
      flow: trusted.source.flow,
      expectedFlowHash: trusted.suite.flowHash,
      expectedScenarioHash: trusted.suite.scenarioHash,
      expectedConditionHash: trusted.condition.conditionHash,
      grantBindingHash: trusted.suite.sourceHash,
      leaseSubjectId: input.plan.cell.pair_id,
      evidenceBinding: attestation.evidenceBinding,
      signer: input.kernelAttestationSigner,
      capabilitySecret: createHmac("sha256", apiKey)
        .update("harshas-amazing-call-center/private-pair-capability-secret/v1\n")
        .update(input.plan.cell.pair_id)
        .update("\n")
        .update(trusted.suite.sourceHash)
        .digest("hex"),
      leaseTtlSeconds: Math.ceil(input.plan.limits.maxSessionMs / 1_000) + 60,
    });
    const result = await runBenchmarkTrial({
      runId: input.plan.cell.run_id,
      provider: input.plan.cell.provider,
      model: input.plan.cell.model,
      scenario: trusted.source.scenario,
      createClient: (configuration) => (dependencies.createClient ?? createProviderClient)(trustedInput, configuration, apiKey),
      condition: trusted.condition,
      gatewayKernel,
      kernelAttestationExpectation: attestation,
      journal: sink,
      journalSecretValues: [apiKey],
      audioDeliveryProfile: {
        schemaVersion: input.plan.audio_delivery.schemaVersion,
        chunkMs: input.plan.audio_delivery.chunkMs,
        pace: input.plan.audio_delivery.pace,
      },
      callerTurns,
      pairedAudio,
      pairInvariantsHash: input.plan.pair_invariants_sha256,
      studyPlanHash: input.plan.study_plan_sha256,
      limits: input.plan.limits,
      providerHardCaps: input.providerPricingProof.caps,
      ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
      ...(dependencies.clock ? { clock: dependencies.clock } : {}),
      budget: {
        // The filesystem ledger above is authoritative. This isolated ledger
        // satisfies the deterministic runner artifact schema without allowing
        // stale-snapshot admission or releasing external exposure.
        ledger: createBudgetLedger(),
        reservationId: `runner-${sha256Hex(input.plan.cell.reservation_id).slice(0, 32)}`,
        maximumUsd,
        persistLedger: async (ledger) => {
          await journal!.append("runner.in_memory_budget_snapshot", ledger);
        },
        // Missing/ambiguous provider usage must never lower the authoritative
        // filesystem liability; settlement remains at the pessimistic maximum.
        estimateCost: () => ({ estimatedUsd: maximumUsd }),
      },
    });

    if (
      result.runId !== input.plan.cell.run_id
      || result.pairId !== input.plan.cell.pair_id
      || result.provider !== input.plan.cell.provider
      || result.model !== input.plan.cell.model
      || result.condition !== input.plan.cell.condition
    ) {
      throw new Error("paid trial result identity differs from the frozen execution cell");
    }
    if (
      input.plan.mode === "canary"
      && (
        input.plan.scenario.id !== TRANSPORT_SMOKE_SCENARIO_ID
        || result.status !== "completed"
        || !result.providerEvidence.gate1_transport_smoke.eligible
        || result.providerEvidence.gate1_transport_smoke.errors.length !== 0
        || !result.providerReceiptLinkage
      )
    ) {
      throw new Error(
        "Gate 1 canary evidence is ineligible; preserve the partial and pessimistic liability",
      );
    }
    const transcript = gatewayKernel.encodedTranscript();
    const transcriptReference = gatewayKernel.transcriptReference();
    const attestationExpectation = Object.freeze({
      runId: input.plan.cell.run_id,
      condition: trusted.condition,
      scenario: trusted.source.scenario,
      world: result.world,
      transcriptReference,
      evidenceBinding: attestation.evidenceBinding,
      trust: attestation.trust,
    });
    const attestationVerification = verifyBenchmarkKernelFinalAttestation(
      result.kernelAttestation,
      attestationExpectation
    );
    if (!attestationVerification.valid || !attestationVerification.signature_verified) {
      throw new Error(`paid trial returned an invalid final kernel attestation: ${attestationVerification.errors.join("; ")}`);
    }
    const transcriptVerification = verifyKernelTranscript({
      transcript,
      finalAttestation: result.kernelAttestation,
      attestationExpectation,
    });
    if (
      !transcriptVerification.valid
      || transcriptVerification.authenticity !== "signed_attestation_verified"
      || canonicalJson(transcriptVerification.reference) !== canonicalJson(transcriptReference)
    ) {
      throw new Error(`paid trial returned an invalid kernel transcript: ${transcriptVerification.errors.join("; ")}`);
    }
    const attestationFile = result.artifacts.files.find((file) => file.path === "kernel-attestation.json");
    if (
      !attestationFile
      || typeof attestationFile.content !== "string"
      || attestationFile.content !== benchmarkKernelAttestationJson(result.kernelAttestation)
    ) {
      throw new Error("paid trial artifact bundle does not contain the verified final kernel attestation");
    }
    const transcriptFile = result.artifacts.files.find((file) => file.path === "kernel-transcript.jsonl");
    if (
      !transcriptFile
      || typeof transcriptFile.content !== "string"
      || transcriptFile.content !== transcript
    ) {
      throw new Error("paid trial artifact bundle does not contain the verified exact kernel transcript");
    }
    const providerEvidenceFile = result.artifacts.files.find(
      (file) => file.path === "provider-transport-evidence.json",
    );
    const providerWireObservationsFile = result.artifacts.files.find(
      (file) => file.path === "provider-wire-observations.jsonl",
    );
    const providerUsageFile = result.artifacts.files.find((file) => file.path === "usage.json");
    const providerReceiptLinkageFile = result.artifacts.files.find(
      (file) => file.path === "provider-read-only-receipt-linkage.json",
    );
    if (
      !providerEvidenceFile
      || typeof providerEvidenceFile.content !== "string"
      || !providerWireObservationsFile
      || typeof providerWireObservationsFile.content !== "string"
      || !providerUsageFile
      || typeof providerUsageFile.content !== "string"
    ) {
      throw new Error("paid trial artifact bundle omitted provider transport evidence");
    }
    let providerTransportPacket: ProviderTransportPacket | null = null;
    let providerTransportPacketSubject: ProviderTransportPacketSubject | null = null;
    if (
      result.providerEvidence.gate1_transport_smoke.eligible
      && result.providerEvidence.wire.chain_head_sha256
      && result.providerReceiptLinkage
    ) {
      if (
        !providerReceiptLinkageFile
        || typeof providerReceiptLinkageFile.content !== "string"
      ) {
        throw new Error("eligible transport smoke omitted its read-only receipt linkage artifact");
      }
      const subject: ProviderTransportPacketSubject = Object.freeze({
        plan_sha256: input.plan.plan_sha256,
        freeze_lock_sha256: input.plan.freeze_lock_sha256,
        provider: input.plan.cell.provider,
        model: input.plan.cell.model,
        run_id: input.plan.cell.run_id,
        pair_id: input.plan.cell.pair_id,
        provider_evidence_descriptor: providerEvidenceFile.descriptor,
        provider_evidence_descriptor_sha256: providerTransportEvidenceDescriptorSha256(
          providerEvidenceFile.descriptor,
        ),
        wire_chain_head_sha256: result.providerEvidence.wire.chain_head_sha256,
        usage_observations_sha256: result.providerEvidence.usage.observations_sha256,
        input_audio_manifest_sha256: sha256Hex(canonicalJson(result.providerEvidence.audio.input)),
        output_audio_manifest_sha256: sha256Hex(canonicalJson(result.providerEvidence.audio.output)),
        // The trial manifest includes the provider evidence, exact PCM files,
        // signed kernel proof/transcript, and read-only receipt linkage. The
        // detached packet signs that complete pre-signature bundle, avoiding a
        // self-referential manifest.
        artifact_manifest_sha256: result.artifacts.manifest.manifest_hash,
        read_only_receipt_linkage_sha256: result.providerReceiptLinkage.linkage_sha256,
        kernel_attestation_hash: result.kernelAttestation.attestation_hash,
        kernel_transcript_sha256: result.kernelAttestation.transcript_reference.transcript_sha256,
      });
      providerTransportPacket = createProviderTransportPacket({
        subject,
        signer: input.kernelAttestationSigner,
        planPinnedTrust: {
          keyId: input.plan.kernel_attestation.key_id,
          publicKeySha256: input.plan.kernel_attestation.public_key_fingerprint_sha256,
          publicKeyPem: input.plan.kernel_attestation.public_key_pem,
        },
      });
      providerTransportPacketSubject = subject;
    }
    await journal.append("kernel.attestation_verified_before_settlement", {
      attestation_hash: result.kernelAttestation.attestation_hash,
      signing_key_id: result.kernelAttestation.bindings.signing_key_id,
      signing_public_key_sha256: result.kernelAttestation.bindings.signing_public_key_sha256,
      signature_verified: true,
      transcript_entry_count: transcriptReference.transcript_entry_count,
      transcript_sha256: transcriptReference.transcript_sha256,
      plan_sha256: input.plan.plan_sha256,
      freeze_lock_sha256: input.plan.freeze_lock_sha256,
      kernel_build_sha256: input.freeze.gateway_sha256,
    });

    await recordBudgetTerminal({
      ledgerPath: input.ledgerPath,
      operationId: `${operationPrefix}:terminal-${result.status === "completed" ? "completed" : "failed"}`,
      reservationId: input.plan.cell.reservation_id,
      outcome: result.status === "completed" ? "completed" : "failed",
    });
    const settled = await settleFilesystemBudget({
      ledgerPath: input.ledgerPath,
      operationId: `${operationPrefix}:settle`,
      reservationId: input.plan.cell.reservation_id,
      estimatedUsd: maximumUsd,
    });
    await journal.append("budget.filesystem_settled", {
      budget_head_sha256: settled.snapshot.head_sha256,
      reservation_status: reservationStatus(settled.snapshot.reservations, input.plan.cell.reservation_id),
      conservative_settled_micro_usd: settled.snapshot.conservative_settled_micro_usd,
    });
    const persistedArtifactDescriptors: Array<Readonly<{
      path: string;
      byte_length: number;
      sha256: string;
    }>> = [];
    for (const file of result.artifacts.files) {
      const bytes = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
      persistedArtifactDescriptors.push(await journal.writeBlob(`final/${file.path}`, bytes));
    }
    const trialManifestDescriptor = await journal.writeBlob(
      "final/manifest.json",
      Buffer.from(result.artifacts.manifestJson, "utf8")
    );
    persistedArtifactDescriptors.push(trialManifestDescriptor);
    const providerTransportPacketDescriptor = providerTransportPacket
      ? await journal.writeBlob(
          "final/provider-transport-packet.json",
          Buffer.from(serializeProviderTransportPacket(providerTransportPacket), "utf8"),
        )
      : null;
    if (providerTransportPacketDescriptor) {
      persistedArtifactDescriptors.push(providerTransportPacketDescriptor);
    }
    const transcriptDescriptor = persistedArtifactDescriptors.find(
      (descriptor) => descriptor.path === "final/kernel-transcript.jsonl"
    );
    const providerEvidenceDescriptor = persistedArtifactDescriptors.find(
      (descriptor) => descriptor.path === "final/provider-transport-evidence.json",
    );
    const providerWireObservationsDescriptor = persistedArtifactDescriptors.find(
      (descriptor) => descriptor.path === "final/provider-wire-observations.jsonl",
    );
    if (!transcriptDescriptor) {
      throw new Error("persisted paid artifact set omitted the verified kernel transcript");
    }
    if (!providerEvidenceDescriptor || !providerWireObservationsDescriptor) {
      throw new Error("persisted paid artifact set omitted provider transport evidence");
    }
    // Re-open the exact no-follow file descriptor after fsync, then repeat the
    // independent trust verification. Atomic `.complete` publication must not
    // rely only on the in-memory object that was intended to be persisted.
    const persistedAttestationBytes = await readFrozenFixtureFileNoFollow(
      journal.paths.partial,
      "final/kernel-attestation.json",
      2 * 1024 * 1024
    );
    const persistedAttestationText = new TextDecoder("utf-8", { fatal: true }).decode(persistedAttestationBytes);
    if (persistedAttestationText !== benchmarkKernelAttestationJson(result.kernelAttestation)) {
      throw new Error("persisted paid kernel attestation differs from the verified in-memory proof");
    }
    let persistedAttestation: unknown;
    try {
      persistedAttestation = JSON.parse(persistedAttestationText);
    } catch {
      throw new Error("persisted paid kernel attestation is not valid JSON");
    }
    const persistedVerification = verifyBenchmarkKernelFinalAttestation(
      persistedAttestation,
      attestationExpectation
    );
    if (!persistedVerification.valid || !persistedVerification.signature_verified) {
      throw new Error(`persisted paid kernel attestation failed verification: ${persistedVerification.errors.join("; ")}`);
    }
    await journal.append("kernel.persisted_attestation_verified", {
      attestation_hash: result.kernelAttestation.attestation_hash,
      artifact_sha256: sha256Hex(persistedAttestationBytes),
      signature_verified: true,
    });
    const persistedTranscriptBytes = await readFrozenFixtureFileNoFollow(
      journal.paths.partial,
      "final/kernel-transcript.jsonl",
      32 * 1024 * 1024
    );
    const persistedTranscript = new TextDecoder("utf-8", { fatal: true }).decode(persistedTranscriptBytes);
    if (persistedTranscript !== transcript) {
      throw new Error("persisted paid kernel transcript differs from the verified in-memory replay artifact");
    }
    const persistedTranscriptVerification = verifyKernelTranscript({
      transcript: persistedTranscript,
      finalAttestation: result.kernelAttestation,
      attestationExpectation,
    });
    if (
      !persistedTranscriptVerification.valid
      || persistedTranscriptVerification.authenticity !== "signed_attestation_verified"
      || canonicalJson(persistedTranscriptVerification.reference) !== canonicalJson(transcriptReference)
    ) {
      throw new Error(`persisted paid kernel transcript failed replay verification: ${persistedTranscriptVerification.errors.join("; ")}`);
    }
    await journal.append("kernel.persisted_transcript_verified", {
      transcript_sha256: transcriptReference.transcript_sha256,
      transcript_head_sha256: transcriptReference.transcript_head_sha256,
      transcript_entry_count: transcriptReference.transcript_entry_count,
      artifact_sha256: sha256Hex(persistedTranscriptBytes),
      signed_attestation_verified: true,
    });
    const persistedProviderEvidenceBytes = await readFrozenFixtureFileNoFollow(
      journal.paths.partial,
      "final/provider-transport-evidence.json",
      4 * 1024 * 1024,
    );
    const persistedProviderEvidenceText = new TextDecoder("utf-8", { fatal: true })
      .decode(persistedProviderEvidenceBytes);
    if (persistedProviderEvidenceText !== providerEvidenceFile.content) {
      throw new Error("persisted provider transport evidence differs from the in-memory artifact");
    }
    let persistedProviderEvidence: unknown;
    try {
      persistedProviderEvidence = JSON.parse(persistedProviderEvidenceText);
    } catch {
      throw new Error("persisted provider transport evidence is not valid JSON");
    }
    if (
      !persistedProviderEvidence
      || typeof persistedProviderEvidence !== "object"
      || Array.isArray(persistedProviderEvidence)
      || (persistedProviderEvidence as Record<string, unknown>).schema_version !== 1
      || (persistedProviderEvidence as Record<string, unknown>).provider !== input.plan.cell.provider
      || canonicalJson(persistedProviderEvidence) !== canonicalJson(result.providerEvidence)
    ) {
      throw new Error("persisted provider transport evidence failed identity verification");
    }
    const persistedWireObservationBytes = await readFrozenFixtureFileNoFollow(
      journal.paths.partial,
      "final/provider-wire-observations.jsonl",
      32 * 1024 * 1024,
    );
    const persistedWireObservationText = new TextDecoder("utf-8", { fatal: true })
      .decode(persistedWireObservationBytes);
    if (persistedWireObservationText !== providerWireObservationsFile.content) {
      throw new Error("persisted provider wire observations differ from the in-memory artifact");
    }
    let persistedWireObservations: RealtimeWireObservation[];
    try {
      persistedWireObservations = persistedWireObservationText.trim()
        ? persistedWireObservationText.trim().split("\n").map(
          (line) => JSON.parse(line) as RealtimeWireObservation,
        )
        : [];
    } catch {
      throw new Error("persisted provider wire observations are not valid JSONL");
    }
    const persistedWireVerification = verifyRealtimeWireObservationChain(persistedWireObservations);
    if (
      persistedWireVerification.valid !== result.providerEvidence.wire.chain_valid
      || persistedWireVerification.eventCount !== result.providerEvidence.wire.observation_count
      || persistedWireVerification.chainHead !== result.providerEvidence.wire.chain_head_sha256
    ) {
      throw new Error("persisted provider wire observation replay differs from provider evidence");
    }
    const persistedUsageBytes = await readFrozenFixtureFileNoFollow(
      journal.paths.partial,
      "final/usage.json",
      8 * 1024 * 1024,
    );
    const persistedUsageText = new TextDecoder("utf-8", { fatal: true }).decode(persistedUsageBytes);
    if (persistedUsageText !== providerUsageFile.content) {
      throw new Error("persisted provider usage differs from the in-memory artifact");
    }
    let persistedUsage: NormalizedRealtimeUsage[];
    try {
      const parsed = JSON.parse(persistedUsageText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("usage root");
      const events = (parsed as { events?: unknown }).events;
      if (!Array.isArray(events)) throw new Error("usage events");
      persistedUsage = events.map((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("usage event");
        const usage = (event as { usage?: unknown }).usage;
        if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("usage payload");
        return usage as NormalizedRealtimeUsage;
      });
    } catch {
      throw new Error("persisted provider usage is not a valid usage artifact");
    }
    const providerEvidenceVerification = verifyProviderTransportEvidence({
      evidence: persistedProviderEvidence as ProviderTransportEvidence,
      wireObservations: persistedWireObservations,
      usage: persistedUsage,
      provider: input.plan.cell.provider,
      model: input.plan.cell.model,
    });
    if (!providerEvidenceVerification.valid) {
      throw new Error(
        `persisted provider transport evidence failed replay: ${providerEvidenceVerification.errors.join("; ")}`,
      );
    }
    if (providerTransportPacket && providerTransportPacketSubject && providerTransportPacketDescriptor) {
      const persistedPacketBytes = await readFrozenFixtureFileNoFollow(
        journal.paths.partial,
        "final/provider-transport-packet.json",
        2 * 1024 * 1024,
      );
      if (
        persistedPacketBytes.byteLength !== providerTransportPacketDescriptor.byte_length
        || sha256Hex(persistedPacketBytes) !== providerTransportPacketDescriptor.sha256
      ) {
        throw new Error("persisted provider transport packet differs from its durable descriptor");
      }
      let persistedPacket: unknown;
      try {
        persistedPacket = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(persistedPacketBytes));
      } catch {
        throw new Error("persisted provider transport packet is not valid JSON");
      }
      const packetVerification = verifyProviderTransportPacket({
        packet: persistedPacket,
        expectedSubject: providerTransportPacketSubject,
        planPinnedTrust: {
          keyId: input.plan.kernel_attestation.key_id,
          publicKeySha256: input.plan.kernel_attestation.public_key_fingerprint_sha256,
          publicKeyPem: input.plan.kernel_attestation.public_key_pem,
        },
      });
      if (!packetVerification.valid || !packetVerification.signature_verified) {
        throw new Error(
          `persisted provider transport packet signature failed: ${packetVerification.errors.join("; ")}`,
        );
      }
      await journal.append("provider.persisted_plan_pinned_packet_verified", {
        packet_sha256: providerTransportPacket.packet_sha256,
        packet_artifact_sha256: providerTransportPacketDescriptor.sha256,
        signing_key_id: providerTransportPacket.signature.key_id,
        signature_verified: true,
        provider_receipt_linkage_sha256: result.providerReceiptLinkage?.linkage_sha256 ?? null,
      });
    }
    await journal.append("provider.persisted_transport_evidence_verified", {
      provider: input.plan.cell.provider,
      evidence_sha256: providerEvidenceDescriptor.sha256,
      wire_observations_sha256: providerWireObservationsDescriptor.sha256,
      wire_chain_valid: persistedWireVerification.valid,
      wire_chain_head_sha256: persistedWireVerification.chainHead,
      gate1_transport_smoke_eligible: result.providerEvidence.gate1_transport_smoke.eligible,
      claim_boundary: result.providerEvidence.gate1_transport_smoke.claim_boundary,
    });
    const runnerManifest = `${canonicalJson({
      schema_version: 1,
      manifest_type: "paid_benchmark_completion",
      run_id: input.plan.cell.run_id,
      trial_manifest: trialManifestDescriptor,
      kernel_attestation: {
        path: "final/kernel-attestation.json",
        attestation_hash: result.kernelAttestation.attestation_hash,
      },
      kernel_transcript: {
        ...transcriptDescriptor,
        reference: transcriptReference,
      },
      provider_transport_evidence: {
        ...providerEvidenceDescriptor,
        wire_observations: providerWireObservationsDescriptor,
        wire_chain_head_sha256: result.providerEvidence.wire.chain_head_sha256,
        gate1_transport_smoke_eligible: result.providerEvidence.gate1_transport_smoke.eligible,
        claim_boundary: result.providerEvidence.gate1_transport_smoke.claim_boundary,
      },
      provider_transport_packet: providerTransportPacket && providerTransportPacketDescriptor
        ? {
            ...providerTransportPacketDescriptor,
            packet_sha256: providerTransportPacket.packet_sha256,
            signing_key_id: providerTransportPacket.signature.key_id,
            signature_verified_before_finalize: true,
            provider_receipt_linkage_path: result.providerReceiptLinkage
              ? "final/provider-read-only-receipt-linkage.json"
              : null,
            provider_receipt_linkage_sha256: result.providerReceiptLinkage?.linkage_sha256 ?? null,
          }
        : null,
      artifacts: persistedArtifactDescriptors
        .slice()
        .sort((left, right) => left.path.localeCompare(right.path)),
    })}\n`;
    const runnerManifestDescriptor = await journal.writeBlob(
      "final/runner-manifest.json",
      Buffer.from(runnerManifest, "utf8")
    );
    const complete = await journal.finalize({
      status: result.status,
      manifestSha256: runnerManifestDescriptor.sha256,
      budgetHeadSha256: settled.snapshot.head_sha256,
    });
    return Object.freeze({
      runId: result.runId,
      status: result.status,
      artifactPath: complete,
      budgetHeadSha256: settled.snapshot.head_sha256,
    });
  } catch {
    // Before credential authority is successfully registered, no provider
    // client can have been constructed. Keep the reservation active and
    // pessimistic for explicit operator recovery instead of silently releasing
    // the consumed one-shot authority. Later failures use the ordinary
    // terminal/cancel/settle lifecycle.
    const head = credentialBoundaryReady
      ? await preserveFinalLiability({ lifecycle, maximumUsd }).catch(() => reserved.snapshot.head_sha256)
      : reserved.snapshot.head_sha256;
    if (journal) {
      await journal.preservePartial("paid-run-failed", {
        budget_head_sha256: head,
        reservation_id: input.plan.cell.reservation_id,
      }).catch(() => undefined);
    }
    // Provider errors, paths, URLs, and secrets stay in the private partial.
    // The CLI receives a fixed message with no provider-controlled content.
    throw new Error("paid benchmark execution failed; durable partial and budget liability were preserved");
  }
}
