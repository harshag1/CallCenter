import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type {
  Lc4DevCallerAudioBinding,
  Lc4DevControlReceipt,
  Lc4DevImmutableLedgerEvent,
  Lc4DevLiveEpisodePlan,
  Lc4DevLivePreflightArtifact,
  Lc4DevLivePrepareArtifact,
  Lc4DevLiveRunnerDependencies,
} from "./lc4-development-live-runner";
import type {
  Lc4DevelopmentListenerSink,
  Lc4DevelopmentRealtimeAdapter,
} from "./lc4-development-realtime-contract";
import type { Lc4CapturedOutput } from "./lc4-listener-evidence";
import {
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CAS_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-cas-receipt/v1\n";
const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-ledger-event/v1\n";
const LEDGER_GENESIS_DOMAIN = "harshas-amazing-call-center/lc4-dev-ledger-genesis/v1\n";
const LISTENER_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-pinned-listener-evidence/v1\n";
const DEPENDENCY_MANIFEST_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-dependencies/v1\n";

export const LC4_DEV_LIVE_DEPENDENCY_VERSION = "lc4-dev-live-dependencies-v1" as const;

function hash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe opaque identifier`);
}

function pcmFromCapture(capture: Lc4CapturedOutput): Uint8Array {
  const output = new Uint8Array(capture.chunks.reduce((sum, chunk) => sum + chunk.pcm.byteLength, 0));
  let offset = 0;
  for (const [ordinal, chunk] of capture.chunks.entries()) {
    if (!(chunk.pcm instanceof Uint8Array)
      || chunk.receipt.ordinal !== ordinal
      || chunk.receipt.byte_length !== chunk.pcm.byteLength
      || chunk.receipt.pcm_sha256 !== sha256Hex(chunk.pcm)) {
      throw new Error("LC4-DEV listener capture contains an invalid PCM chunk receipt");
    }
    output.set(chunk.pcm, offset);
    offset += chunk.pcm.byteLength;
  }
  if (output.byteLength !== capture.generated_byte_length || sha256Hex(output) !== capture.generated_pcm_sha256) {
    throw new Error("LC4-DEV listener capture aggregate differs from captured PCM");
  }
  return output;
}

export type Lc4DevLiveReadinessGapCode =
  | "public_corpus_missing_benchmark_scenario"
  | "public_corpus_missing_agent_flow"
  | "public_corpus_missing_compiled_host_managed_condition"
  | "public_corpus_missing_toolworld_effect_contracts"
  | "public_corpus_missing_rendered_crp_pcm"
  | "public_corpus_missing_durable_worker_execution_plan"
  | "public_corpus_missing_frozen_semantic_registry"
  | "public_corpus_missing_pinned_asr_evaluator"
  | "realtime_exchange_missing_repair_playback_channel"
  | "listener_handoff_missing_playback_authority";

export type Lc4DevLiveReadinessGap = Readonly<{
  code: Lc4DevLiveReadinessGapCode;
  blocks: "hacc_control" | "native_information_parity" | "listener_evidence" | "all_provider_calls";
  detail: string;
}>;

const CURRENT_PUBLIC_CORPUS_GAPS: readonly Lc4DevLiveReadinessGap[] = Object.freeze([
  Object.freeze({ code: "public_corpus_missing_benchmark_scenario", blocks: "hacc_control", detail: "The public DEV corpus has caller opportunities but no BenchmarkScenario accepted by ToolWorld or the gateway kernel." }),
  Object.freeze({ code: "public_corpus_missing_agent_flow", blocks: "hacc_control", detail: "The public DEV corpus does not bind an AgentFlow, topic graph, steps, transitions, or action policies." }),
  Object.freeze({ code: "public_corpus_missing_compiled_host_managed_condition", blocks: "hacc_control", detail: "No compiler input or host-managed-harness CompiledBenchmarkCondition is bound to the public DEV corpus." }),
  Object.freeze({ code: "public_corpus_missing_toolworld_effect_contracts", blocks: "hacc_control", detail: "Permitted and prohibited effect prose is not an executable ToolWorld action, receipt, fault, or reconciliation contract." }),
  Object.freeze({ code: "public_corpus_missing_rendered_crp_pcm", blocks: "hacc_control", detail: "Repair source text exists, but no hash-bound rendered PCM inventory or executable CRP-1 plan is present." }),
  Object.freeze({ code: "public_corpus_missing_durable_worker_execution_plan", blocks: "hacc_control", detail: "Worker event labels lack executable payloads, generations, leases, result envelopes, and fault schedule." }),
  Object.freeze({ code: "public_corpus_missing_frozen_semantic_registry", blocks: "listener_evidence", detail: "Expected listener prose is not a frozen phrase/operator registry committed before provider output." }),
  Object.freeze({ code: "public_corpus_missing_pinned_asr_evaluator", blocks: "listener_evidence", detail: "No evaluator executable, weights, decoding contract, calibration, or signing identity is bound to the public DEV corpus." }),
  Object.freeze({ code: "realtime_exchange_missing_repair_playback_channel", blocks: "all_provider_calls", detail: "The exchange contract has no arm-blind channel for playing bounded repair PCM inside the same canonical opportunity without extending the horizon." }),
  Object.freeze({ code: "listener_handoff_missing_playback_authority", blocks: "listener_evidence", detail: "The listener handoff contains generated PCM but no independently verified byte range proving what the caller actually heard." }),
]);

/**
 * Reports what must be supplied before the public DEV corpus can drive paid
 * calls. This intentionally describes the current checked-in contracts rather
 * than inferring executable mechanisms from prose fields.
 */
export function auditLc4PublicDevLiveReadiness(
  corpus: Lc4PublicDevelopmentCorpus = createLc4PublicDevelopmentCorpus(),
): Readonly<{ ready: false; provider_calls_safe: false; gaps: readonly Lc4DevLiveReadinessGap[]; audit_sha256: string }> {
  assertLc4PublicDevelopmentCorpus(corpus);
  const body = {
    schema_version: 1 as const,
    dependency_version: LC4_DEV_LIVE_DEPENDENCY_VERSION,
    corpus_sha256: corpus.artifact_sha256,
    ready: false as const,
    provider_calls_safe: false as const,
    gaps: CURRENT_PUBLIC_CORPUS_GAPS,
  };
  return freeze({ ...body, audit_sha256: hash(DEPENDENCY_MANIFEST_DOMAIN, body) });
}

export type Lc4ImmutableCasReceipt = Readonly<{
  schema_version: 1;
  algorithm: "sha256";
  artifact_sha256: string;
  byte_length: number;
  relative_path: string;
  media_type: "audio/pcm" | "application/json" | "application/octet-stream";
  receipt_sha256: string;
}>;

export type Lc4ImmutableCas = Readonly<{
  root_dir: string;
  put(bytes: Uint8Array, mediaType?: Lc4ImmutableCasReceipt["media_type"]): Promise<Lc4ImmutableCasReceipt>;
  get(artifactSha256: string): Promise<Uint8Array>;
}>;

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("LC4-DEV CAS root must be a real directory, not a symlink");
  }
}

/** Immutable, content-addressed evidence storage. Existing bytes are verified, never overwritten. */
export async function createLc4ImmutableCas(rootDir: string): Promise<Lc4ImmutableCas> {
  const root = resolve(rootDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectoryNotSymlink(root);

  async function get(artifactSha256: string): Promise<Uint8Array> {
    requireSha256(artifactSha256, "LC4-DEV CAS artifact hash");
    const bytes = new Uint8Array(await readFile(join(root, artifactSha256.slice(0, 2), artifactSha256)));
    if (sha256Hex(bytes) !== artifactSha256) throw new Error("LC4-DEV CAS artifact content does not match its address");
    return bytes;
  }

  return Object.freeze({
    root_dir: root,
    get,
    put: async (inputBytes, mediaType = "application/octet-stream") => {
      if (!(inputBytes instanceof Uint8Array) || inputBytes.byteLength === 0) {
        throw new Error("LC4-DEV CAS refuses empty or non-byte artifacts");
      }
      const bytes = Uint8Array.from(inputBytes);
      const artifactSha256 = sha256Hex(bytes);
      const relativePath = join(artifactSha256.slice(0, 2), artifactSha256);
      const directory = join(root, artifactSha256.slice(0, 2));
      const path = join(root, relativePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await assertDirectoryNotSymlink(directory);
      let handle;
      try {
        handle = await open(path, "wx", 0o400);
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const existing = await get(artifactSha256);
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
          throw new Error("LC4-DEV CAS address collision or corrupt pre-existing artifact");
        }
      } finally {
        await handle?.close();
      }
      await chmod(path, 0o400);
      const body = {
        schema_version: 1 as const,
        algorithm: "sha256" as const,
        artifact_sha256: artifactSha256,
        byte_length: bytes.byteLength,
        relative_path: relativePath,
        media_type: mediaType,
      };
      return freeze({ ...body, receipt_sha256: hash(CAS_RECEIPT_DOMAIN, body) });
    },
  });
}

export function lc4DevLedgerGenesisSha256(input: Readonly<{
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
}>): string {
  requireSafeId(input.execution_id, "LC4-DEV ledger execution ID");
  requireSha256(input.prepare_sha256, "LC4-DEV ledger prepare hash");
  requireSha256(input.preflight_sha256, "LC4-DEV ledger preflight hash");
  return hash(LEDGER_GENESIS_DOMAIN, {
    schema_version: 1,
    dependency_version: LC4_DEV_LIVE_DEPENDENCY_VERSION,
    ...input,
  });
}

export type Lc4HashChainedLedgerWriter = Readonly<{
  genesis_sha256: string;
  path: string;
  append(event: Lc4DevImmutableLedgerEvent): Promise<void>;
  close(): Promise<void>;
}>;

/** Creates a new, fsync-on-every-event JSONL ledger and refuses resume/overwrite. */
export async function createLc4HashChainedLedgerWriter(input: Readonly<{
  path: string;
  genesis_sha256: string;
}>): Promise<Lc4HashChainedLedgerWriter> {
  requireSha256(input.genesis_sha256, "LC4-DEV ledger genesis");
  const path = resolve(input.path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await access(path, constants.F_OK);
    throw new Error("LC4-DEV ledger path already exists; resume and overwrite are forbidden");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(path, "wx", 0o600);
  let sequence = 0;
  let previous: string | null = null;
  let closed = false;
  let queue = Promise.resolve();

  const append = async (event: Lc4DevImmutableLedgerEvent): Promise<void> => {
    const operation = queue.then(async () => {
      if (closed) throw new Error("LC4-DEV ledger is closed");
      const { event_sha256: claimed, ...body } = event;
      if (claimed !== hash(LEDGER_EVENT_DOMAIN, body)) throw new Error("LC4-DEV ledger event hash is invalid");
      if (event.sequence !== sequence + 1 || event.previous_event_sha256 !== previous) {
        throw new Error("LC4-DEV ledger event forks, repeats, or skips the hash chain");
      }
      await handle.writeFile(`${canonicalJson(event)}\n`);
      await handle.sync();
      sequence = event.sequence;
      previous = event.event_sha256;
    });
    queue = operation.catch(() => undefined);
    return operation;
  };

  return Object.freeze({
    genesis_sha256: input.genesis_sha256,
    path,
    append,
    close: async () => {
      await queue;
      if (closed) return;
      closed = true;
      await handle.sync();
      await handle.close();
      await chmod(path, 0o400);
    },
  });
}

export type Lc4PinnedListenerEvaluation = Readonly<{
  source_pcm_sha256: string;
  source_pcm_byte_length: number;
  evaluator_contract_sha256: string;
  evaluator_build_sha256: string;
  calibration_sha256: string;
  transcript_sha256: string;
  semantic_result_sha256: string;
  signed_invocation_receipt_sha256: string;
}>;

export type Lc4PinnedListenerEvaluator = Readonly<{
  evaluator_contract_sha256: string;
  evaluator_build_sha256: string;
  calibration_sha256: string;
  evaluate(input: Readonly<{
    run_id: string;
    opportunity_id: string;
    provider: "openai" | "gemini" | "xai";
    sample_rate_hz: number;
    pcm: Uint8Array;
    criterion_plan_sha256: string;
  }>): Promise<Lc4PinnedListenerEvaluation>;
}>;

export type Lc4ListenerPlaybackAuthority = Readonly<{
  verify(input: Readonly<{
    capture: Lc4CapturedOutput;
    pcm: Uint8Array;
  }>): Promise<Readonly<{
    status: "completed";
    played_byte_start: 0;
    played_byte_end: number;
    played_pcm_sha256: string;
    authority_receipt_sha256: string;
  }>>;
}>;

export type Lc4DevListenerCriterionBinding = Readonly<{
  opportunity_id: string;
  criterion_plan_sha256: string;
}>;

export function createLc4PinnedListenerManifestSha256(input: Readonly<{
  corpus_sha256: string;
  evaluator: Pick<Lc4PinnedListenerEvaluator, "evaluator_contract_sha256" | "evaluator_build_sha256" | "calibration_sha256">;
  criteria: readonly Lc4DevListenerCriterionBinding[];
  playback_authority_manifest_sha256: string;
}>): string {
  return hash(LISTENER_RECEIPT_DOMAIN, {
    schema_version: 1,
    corpus_sha256: input.corpus_sha256,
    evaluator: {
      evaluator_contract_sha256: input.evaluator.evaluator_contract_sha256,
      evaluator_build_sha256: input.evaluator.evaluator_build_sha256,
      calibration_sha256: input.evaluator.calibration_sha256,
    },
    criteria: input.criteria,
    playback_authority_manifest_sha256: input.playback_authority_manifest_sha256,
  });
}

/**
 * Evaluates only externally verified caller-heard PCM. Generated-but-unplayed
 * output and evaluator results that are not pinned to the exact bytes fail.
 */
export function createLc4PinnedListenerSink(input: Readonly<{
  corpus: Lc4PublicDevelopmentCorpus;
  listener_manifest_sha256: string;
  criteria: readonly Lc4DevListenerCriterionBinding[];
  evaluator: Lc4PinnedListenerEvaluator;
  playback_authority: Lc4ListenerPlaybackAuthority;
  playback_authority_manifest_sha256: string;
  cas: Lc4ImmutableCas;
}>): Lc4DevelopmentListenerSink {
  assertLc4PublicDevelopmentCorpus(input.corpus);
  for (const digest of [
    input.listener_manifest_sha256,
    input.evaluator.evaluator_contract_sha256,
    input.evaluator.evaluator_build_sha256,
    input.evaluator.calibration_sha256,
    input.playback_authority_manifest_sha256,
  ]) requireSha256(digest, "LC4-DEV listener dependency hash");
  if (input.criteria.length !== input.corpus.opportunities.length
    || new Set(input.criteria.map((item) => item.opportunity_id)).size !== input.criteria.length) {
    throw new Error("LC4-DEV listener criteria must bind every opportunity exactly once");
  }
  input.criteria.forEach((binding, index) => {
    if (binding.opportunity_id !== input.corpus.opportunities[index]?.id) {
      throw new Error("LC4-DEV listener criteria order differs from the public corpus");
    }
    requireSha256(binding.criterion_plan_sha256, "LC4-DEV listener criterion plan");
  });
  const expectedManifest = createLc4PinnedListenerManifestSha256({
    corpus_sha256: input.corpus.artifact_sha256,
    evaluator: input.evaluator,
    criteria: input.criteria,
    playback_authority_manifest_sha256: input.playback_authority_manifest_sha256,
  });
  if (expectedManifest !== input.listener_manifest_sha256) {
    throw new Error("LC4-DEV listener manifest is not bound to its corpus, criteria, evaluator, and playback authority");
  }

  return Object.freeze({
    accept: async ({ episode, opportunity, capture, response_plan_sha256, wire_observation_set_sha256 }) => {
      if (capture.run_id !== episode.episode_id
        || capture.opportunity_id !== opportunity.id
        || capture.provider !== episode.provider) {
        throw new Error("LC4-DEV listener capture identity differs from its episode or opportunity");
      }
      requireSha256(wire_observation_set_sha256, "LC4-DEV listener wire observation set");
      if (episode.arm === "hacc") requireSha256(response_plan_sha256 ?? "", "LC4-DEV HACC response plan");
      if (episode.arm === "native" && response_plan_sha256 !== null) {
        throw new Error("LC4-DEV native listener evidence cannot bind a HACC response plan");
      }
      const generatedPcm = pcmFromCapture(capture);
      const playback = await input.playback_authority.verify({ capture, pcm: generatedPcm.slice() });
      requireSha256(playback.authority_receipt_sha256, "LC4-DEV playback authority receipt");
      if (playback.status !== "completed"
        || playback.played_byte_start !== 0
        || playback.played_byte_end !== generatedPcm.byteLength
        || playback.played_pcm_sha256 !== sha256Hex(generatedPcm)) {
        throw new Error("LC4-DEV listener evidence requires independently verified full captured-PCM playback");
      }
      const criterion = input.criteria[opportunity.index - 1];
      if (!criterion || criterion.opportunity_id !== opportunity.id) throw new Error("LC4-DEV listener criterion binding is missing");
      const evaluation = await input.evaluator.evaluate({
        run_id: episode.episode_id,
        opportunity_id: opportunity.id,
        provider: episode.provider,
        sample_rate_hz: capture.format.sample_rate_hz,
        pcm: generatedPcm.slice(),
        criterion_plan_sha256: criterion.criterion_plan_sha256,
      });
      for (const digest of [
        evaluation.evaluator_contract_sha256,
        evaluation.evaluator_build_sha256,
        evaluation.calibration_sha256,
        evaluation.transcript_sha256,
        evaluation.semantic_result_sha256,
        evaluation.signed_invocation_receipt_sha256,
      ]) requireSha256(digest, "LC4-DEV listener evaluator receipt");
      if (evaluation.source_pcm_sha256 !== sha256Hex(generatedPcm)
        || evaluation.source_pcm_byte_length !== generatedPcm.byteLength
        || evaluation.evaluator_contract_sha256 !== input.evaluator.evaluator_contract_sha256
        || evaluation.evaluator_build_sha256 !== input.evaluator.evaluator_build_sha256
        || evaluation.calibration_sha256 !== input.evaluator.calibration_sha256) {
        throw new Error("LC4-DEV evaluator result is not pinned to the exact played PCM and evaluator identity");
      }
      const pcmReceipt = await input.cas.put(generatedPcm, "audio/pcm");
      const body = {
        schema_version: 1 as const,
        dependency_version: LC4_DEV_LIVE_DEPENDENCY_VERSION,
        episode_id: episode.episode_id,
        opportunity_id: opportunity.id,
        provider: episode.provider,
        capture_receipt_sha256: capture.capture_receipt_sha256,
        played_pcm_sha256: playback.played_pcm_sha256,
        played_pcm_cas_receipt_sha256: pcmReceipt.receipt_sha256,
        playback_authority_receipt_sha256: playback.authority_receipt_sha256,
        criterion_plan_sha256: criterion.criterion_plan_sha256,
        response_plan_sha256,
        wire_observation_set_sha256,
        evaluation,
        listener_manifest_sha256: input.listener_manifest_sha256,
      };
      const listenerEvidenceSha256 = hash(LISTENER_RECEIPT_DOMAIN, body);
      await input.cas.put(Buffer.from(canonicalJson({ ...body, listener_evidence_sha256: listenerEvidenceSha256 })), "application/json");
      return Object.freeze({ listener_evidence_sha256: listenerEvidenceSha256 });
    },
  });
}

export type Lc4DevExecutableMechanismControl = Readonly<{
  kind: "gateway-flow-toolworld-crp-workers-v1";
  manifest_sha256: string;
  next(input: Readonly<{
    episode: Lc4DevLiveEpisodePlan;
    opportunity: Lc4PublicDevOpportunity;
    previous_exchange_sha256: string | null;
  }>): Promise<Lc4DevControlReceipt>;
}>;

export type Lc4DevLiveDependencyBundle = Readonly<{
  dependencies: Lc4DevLiveRunnerDependencies;
  cas: Lc4ImmutableCas;
  ledger: Lc4HashChainedLedgerWriter;
  listener: Lc4DevelopmentListenerSink;
  finalize(): Promise<void>;
}>;

/**
 * CLI-consumable dependency factory. It only accepts an executable mechanism
 * controller and a listener whose roots were signed into preflight. Merely
 * passing the current prose-only public corpus is intentionally impossible.
 */
export async function createLc4DevelopmentLiveDependencies(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  corpus?: Lc4PublicDevelopmentCorpus;
  cas_root_dir: string;
  ledger_path: string;
  control: Lc4DevExecutableMechanismControl;
  criteria: readonly Lc4DevListenerCriterionBinding[];
  evaluator: Lc4PinnedListenerEvaluator;
  playback_authority: Lc4ListenerPlaybackAuthority;
  playback_authority_manifest_sha256: string;
  create_adapter(listener: Lc4DevelopmentListenerSink): Lc4DevelopmentRealtimeAdapter;
  now?: () => Date;
}>): Promise<Lc4DevLiveDependencyBundle> {
  const corpus = input.corpus ?? createLc4PublicDevelopmentCorpus();
  assertLc4PublicDevelopmentCorpus(corpus);
  if (corpus.artifact_sha256 !== input.prepare.corpus_sha256) throw new Error("LC4-DEV dependency corpus differs from prepare");
  if (input.control.kind !== "gateway-flow-toolworld-crp-workers-v1"
    || input.control.manifest_sha256 !== input.preflight.control_plane_manifest_sha256) {
    throw new Error("LC4-DEV executable gateway/Flow/ToolWorld/CRP/worker control is absent or differs from preflight");
  }
  const listenerManifest = createLc4PinnedListenerManifestSha256({
    corpus_sha256: corpus.artifact_sha256,
    evaluator: input.evaluator,
    criteria: input.criteria,
    playback_authority_manifest_sha256: input.playback_authority_manifest_sha256,
  });
  if (listenerManifest !== input.preflight.listener_evidence_manifest_sha256) {
    throw new Error("LC4-DEV pinned listener dependencies differ from preflight");
  }
  const genesis = lc4DevLedgerGenesisSha256({
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    preflight_sha256: input.preflight.preflight_sha256,
  });
  if (genesis !== input.preflight.immutable_ledger_genesis_sha256) {
    throw new Error("LC4-DEV ledger genesis differs from preflight");
  }
  const cas = await createLc4ImmutableCas(input.cas_root_dir);
  const ledger = await createLc4HashChainedLedgerWriter({ path: input.ledger_path, genesis_sha256: genesis });
  const listener = createLc4PinnedListenerSink({
    corpus,
    listener_manifest_sha256: listenerManifest,
    criteria: input.criteria,
    evaluator: input.evaluator,
    playback_authority: input.playback_authority,
    playback_authority_manifest_sha256: input.playback_authority_manifest_sha256,
    cas,
  });
  const adapter = input.create_adapter(listener);
  const dependencies: Lc4DevLiveRunnerDependencies = Object.freeze({
    adapter,
    caller_audio: Object.freeze({
      load: async (binding: Lc4DevCallerAudioBinding) => {
        const pcm = await cas.get(binding.pcm_sha256);
        if (pcm.byteLength !== binding.pcm_byte_length) throw new Error("LC4-DEV caller PCM CAS byte length differs from prepare");
        return pcm;
      },
    }),
    retention: Object.freeze({
      retain: async ({ pcm }: { pcm: Uint8Array }) => {
        const receipt = await cas.put(pcm, "audio/pcm");
        return Object.freeze({ artifact_sha256: receipt.artifact_sha256, byte_length: receipt.byte_length });
      },
    }),
    control: input.control,
    ledger,
    now: input.now ?? (() => new Date()),
  });
  return Object.freeze({
    dependencies,
    cas,
    ledger,
    listener,
    finalize: async () => ledger.close(),
  });
}
