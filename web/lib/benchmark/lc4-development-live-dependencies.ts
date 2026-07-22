import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  createLc4DevReplayEvidenceStore,
  type Lc4DevReplayLedgerEvent,
  type Lc4DevReplayEvidenceStore,
} from "./lc4-development-evidence-retention";
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
import type { Lc4DevRepairPlaybackController } from "./lc4-development-repair-playback";
import type { Lc4DevGatewayExecutor } from "./lc4-development-gateway-bridge";
import {
  LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN,
  assertLc4DevCallerBranchDecision,
  lc4DevBranchedOpportunity,
  type Lc4DevCallerBranchAuthority,
  type Lc4DevCallerBranchAudioBinding,
  type Lc4DevCallerBranchMatrixArtifact,
  type Lc4DevPriorMutationReceipt,
} from "./lc4-development-caller-branch";
import type { BenchmarkKernelAttestationSigner } from "./kernel-attestation";
import type {
  Lc4ListenerPlaybackAuthority,
  Lc4PinnedListenerEvaluator,
} from "./lc4-development-headless-listener-authority";
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
const AUTHORIZATION_BINDING_DOMAIN = "harshas-amazing-call-center/lc4-dev-authorization-binding/v1\n";
const LEDGER_GENESIS_DOMAIN = "harshas-amazing-call-center/lc4-dev-ledger-genesis/v2\n";
const LEDGER_INTENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-ledger-intent/v1\n";
const LISTENER_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-pinned-listener-evidence/v1\n";
const DEPENDENCY_MANIFEST_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-dependencies/v1\n";
const CONTROL_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n";
const EPISODE_FINALIZATION_DOMAIN = "harshas-amazing-call-center/lc4-dev-episode-finalization/v1\n";

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
  | "listener_handoff_missing_evaluator_consumption_authority";

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
  Object.freeze({ code: "listener_handoff_missing_evaluator_consumption_authority", blocks: "listener_evidence", detail: "The headless listener handoff needs a signed authority proving the exact complete captured PCM byte range consumed by the pinned evaluator; it must not claim physical playback or human audibility." }),
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
  authorization_binding_sha256: string;
  authority_public_key_fingerprint_sha256: string;
}>): string {
  requireSafeId(input.execution_id, "LC4-DEV ledger execution ID");
  requireSha256(input.prepare_sha256, "LC4-DEV ledger prepare hash");
  requireSha256(input.authorization_binding_sha256, "LC4-DEV ledger authorization binding");
  requireSha256(input.authority_public_key_fingerprint_sha256, "LC4-DEV ledger authority fingerprint");
  return hash(LEDGER_GENESIS_DOMAIN, {
    schema_version: 2,
    operator_version: "HACC-LC4-DEV-OPERATOR-v1",
    ...input,
  });
}

function authorizationBindingSha256(preflight: Lc4DevLivePreflightArtifact): string {
  const { immutable_ledger_genesis_sha256: _excluded, ...body } = preflight.authorization.body;
  void _excluded;
  return hash(AUTHORIZATION_BINDING_DOMAIN, body);
}

async function writeLedgerIntent(input: Readonly<{
  path: string;
  preflight: Lc4DevLivePreflightArtifact;
  authorization_binding_sha256: string;
  genesis_sha256: string;
}>): Promise<void> {
  const body = {
    schema_version: 1 as const,
    execution_id: input.preflight.execution_id,
    prepare_sha256: input.preflight.prepare_sha256,
    preflight_sha256: input.preflight.preflight_sha256,
    authorization_artifact_sha256: input.preflight.authorization_artifact_sha256,
    authorization_binding_sha256: input.authorization_binding_sha256,
    ledger_genesis_sha256: input.genesis_sha256,
    provider_open_permitted_after_intent_fsync: true as const,
  };
  const intent = freeze({ ...body, intent_sha256: hash(LEDGER_INTENT_DOMAIN, body) });
  const path = resolve(input.path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(`${canonicalJson(intent)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o400);
}

export type Lc4HashChainedLedgerWriter = Readonly<{
  genesis_sha256: string;
  path: string;
  append(event: Lc4DevImmutableLedgerEvent): Promise<void>;
  events(): readonly Lc4DevReplayLedgerEvent[];
  close(): Promise<void>;
}>;

/** Creates a new, fsync-on-every-event JSONL ledger and refuses resume/overwrite. */
export async function createLc4HashChainedLedgerWriter(input: Readonly<{
  path: string;
  genesis_sha256: string;
  evidence: Lc4DevReplayEvidenceStore;
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
  const retainedEvents: Lc4DevReplayLedgerEvent[] = [];
  let queue = Promise.resolve();

  const append = async (event: Lc4DevImmutableLedgerEvent): Promise<void> => {
    const operation = queue.then(async () => {
      if (closed) throw new Error("LC4-DEV ledger is closed");
      const { event_sha256: claimed, ...body } = event;
      if (claimed !== hash(LEDGER_EVENT_DOMAIN, body)) throw new Error("LC4-DEV ledger event hash is invalid");
      if (event.sequence !== sequence + 1 || event.previous_event_sha256 !== previous) {
        throw new Error("LC4-DEV ledger event forks, repeats, or skips the hash chain");
      }
      if (event.payload_sha256 !== event.payload_evidence.evidence_sha256) {
        throw new Error("LC4-DEV ledger payload hash is not its retained CAS address");
      }
      await input.evidence.assertResolvable(event.payload_evidence);
      for (const reference of event.evidence_references) await input.evidence.assertResolvable(reference);
      await handle.writeFile(`${canonicalJson(event)}\n`);
      await handle.sync();
      sequence = event.sequence;
      previous = event.event_sha256;
      retainedEvents.push(freeze(event) as unknown as Lc4DevReplayLedgerEvent);
    });
    queue = operation.catch(() => undefined);
    return operation;
  };

  return Object.freeze({
    genesis_sha256: input.genesis_sha256,
    path,
    append,
    events: () => Object.freeze(retainedEvents.map((entry) => freeze(entry))),
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

export type {
  Lc4ListenerPlaybackAuthority,
  Lc4PinnedListenerEvaluation,
  Lc4PinnedListenerEvaluator,
} from "./lc4-development-headless-listener-authority";

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
 * Evaluates only the complete server-captured PCM byte range through a signed,
 * pinned headless handoff. This proves evaluator consumption, not physical
 * speaker playback or that a human caller heard the output.
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
  if (input.playback_authority.mode !== "headless_evaluator_handoff"
    || input.playback_authority.authority_manifest_sha256 !== input.playback_authority_manifest_sha256) {
    throw new Error("LC4-DEV listener authority is not the pinned headless evaluator handoff");
  }
  const replayEvidence = createLc4DevReplayEvidenceStore(input.cas);

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
      const criterion = input.criteria[opportunity.index - 1];
      if (!criterion || criterion.opportunity_id !== opportunity.id) throw new Error("LC4-DEV listener criterion binding is missing");
      const handoff = await input.playback_authority.consume({
        capture,
        pcm: generatedPcm.slice(),
        criterion_plan_sha256: criterion.criterion_plan_sha256,
        evaluator: input.evaluator,
      });
      const evaluation = handoff.evaluation;
      if (!evaluation.repair_projection) throw new Error("LC4-DEV listener evaluator omitted its arm-blind repair projection");
      for (const digest of [
        evaluation.evaluator_contract_sha256,
        evaluation.evaluator_build_sha256,
        evaluation.calibration_sha256,
        evaluation.transcript_sha256,
        evaluation.semantic_result_sha256,
        evaluation.signed_invocation_receipt_sha256,
      ]) requireSha256(digest, "LC4-DEV listener evaluator receipt");
      requireSha256(handoff.authority_receipt.receipt_sha256, "LC4-DEV headless listener authority receipt");
      if (handoff.status !== "evaluator_consumed_complete_capture"
        || handoff.generated_pcm_sha256 !== capture.generated_pcm_sha256
        || handoff.generated_byte_length !== capture.generated_byte_length
        || handoff.captured_byte_start !== 0
        || handoff.captured_byte_end !== generatedPcm.byteLength
        || handoff.evaluator_consumed_byte_start !== 0
        || handoff.evaluator_consumed_byte_end !== generatedPcm.byteLength
        || handoff.captured_pcm_sha256 !== sha256Hex(generatedPcm)
        || handoff.evaluator_consumed_pcm_sha256 !== sha256Hex(generatedPcm)
        || handoff.physical_playback_status !== "not_performed_headless"
        || handoff.human_audibility_status !== "not_measured_not_claimed"
        || evaluation.source_pcm_sha256 !== sha256Hex(generatedPcm)
        || evaluation.source_pcm_byte_length !== generatedPcm.byteLength
        || evaluation.evaluator_contract_sha256 !== input.evaluator.evaluator_contract_sha256
        || evaluation.evaluator_build_sha256 !== input.evaluator.evaluator_build_sha256
        || evaluation.calibration_sha256 !== input.evaluator.calibration_sha256) {
        throw new Error("LC4-DEV evaluator result is not pinned to the exact complete captured PCM and evaluator identity");
      }
      const pcmReceipt = await input.cas.put(generatedPcm, "audio/pcm");
      const authorityReceiptCas = await input.cas.put(
        Buffer.from(canonicalJson(handoff.authority_receipt)),
        "application/json",
      );
      const body = {
        schema_version: 1 as const,
        dependency_version: LC4_DEV_LIVE_DEPENDENCY_VERSION,
        episode_id: episode.episode_id,
        opportunity_id: opportunity.id,
        provider: episode.provider,
        capture_receipt_sha256: capture.capture_receipt_sha256,
        generated_pcm_sha256: capture.generated_pcm_sha256,
        captured_pcm_sha256: handoff.captured_pcm_sha256,
        evaluator_consumed_pcm_sha256: handoff.evaluator_consumed_pcm_sha256,
        evaluator_consumed_byte_start: handoff.evaluator_consumed_byte_start,
        evaluator_consumed_byte_end: handoff.evaluator_consumed_byte_end,
        evaluator_consumed_pcm_cas_receipt_sha256: pcmReceipt.receipt_sha256,
        headless_listener_authority_receipt_sha256: handoff.authority_receipt.receipt_sha256,
        headless_listener_authority_receipt_cas_sha256: authorityReceiptCas.artifact_sha256,
        headless_listener_authority_receipt_cas_receipt_sha256: authorityReceiptCas.receipt_sha256,
        physical_playback_status: handoff.physical_playback_status,
        human_audibility_status: handoff.human_audibility_status,
        criterion_plan_sha256: criterion.criterion_plan_sha256,
        response_plan_sha256,
        wire_observation_set_sha256,
        evaluation,
        listener_manifest_sha256: input.listener_manifest_sha256,
      };
      const listenerEvidenceSha256 = hash(LISTENER_RECEIPT_DOMAIN, body);
      const listenerEvidence = await replayEvidence.retainJson({
        kind: "listener_evidence",
        body: body as unknown as JsonValue,
        domain_prefix: LISTENER_RECEIPT_DOMAIN,
        expected_evidence_sha256: listenerEvidenceSha256,
      });
      return Object.freeze({
        listener_evidence_sha256: listenerEvidenceSha256,
        repair_projection: evaluation.repair_projection,
        playback_authority_receipt_sha256: handoff.authority_receipt.receipt_sha256,
        listener_evidence: listenerEvidence,
      });
    },
  });
}

export type Lc4DevExecutableMechanismControl = Readonly<{
  kind: "gateway-flow-toolworld-crp-workers-v1";
  manifest_sha256: string;
  gateway_executor: Lc4DevGatewayExecutor;
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
  evidence: Lc4DevReplayEvidenceStore;
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
  caller_audio: Readonly<{ load(binding: Lc4DevCallerAudioBinding): Promise<Uint8Array> }>;
  caller_branch: Readonly<{
    matrix: Lc4DevCallerBranchMatrixArtifact;
    authority: Lc4DevCallerBranchAuthority;
    trust: Readonly<{ key_id: string; public_key_pem: string }>;
    load(binding: Lc4DevCallerBranchAudioBinding): Promise<Uint8Array>;
  }>;
  authority_signer: BenchmarkKernelAttestationSigner;
  control: Lc4DevExecutableMechanismControl & Readonly<{
    callerBranchPriorReceipt(episodeId: string): Lc4DevPriorMutationReceipt;
    snapshot(episodeId: string): Readonly<{
      episode_id: string;
      arm: "native" | "hacc";
      opportunities: number;
      common_state_sha256: string;
      world: unknown;
      worker: unknown;
      repair_state: unknown;
      gateway_transcript_sha256: string;
      pending_gateway_actions: number;
      pending_gateway_obligations: readonly unknown[];
    }>;
  }>;
  repair: Readonly<Record<"openai" | "gemini" | "xai", Lc4DevRepairPlaybackController>>;
  criteria: readonly Lc4DevListenerCriterionBinding[];
  evaluator: Lc4PinnedListenerEvaluator;
  playback_authority: Lc4ListenerPlaybackAuthority;
  playback_authority_manifest_sha256: string;
  create_adapter(
    listener: Lc4DevelopmentListenerSink,
    gatewayExecutor: Lc4DevGatewayExecutor,
    evidence: Lc4DevReplayEvidenceStore,
  ): Lc4DevelopmentRealtimeAdapter;
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
  const authorizationBinding = authorizationBindingSha256(input.preflight);
  const genesis = lc4DevLedgerGenesisSha256({
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    authorization_binding_sha256: authorizationBinding,
    authority_public_key_fingerprint_sha256: input.preflight.authority_trust_root_sha256,
  });
  if (genesis !== input.preflight.immutable_ledger_genesis_sha256) {
    throw new Error("LC4-DEV authorization binding or ledger genesis differs from preflight");
  }
  const cas = await createLc4ImmutableCas(input.cas_root_dir);
  const replayEvidence = createLc4DevReplayEvidenceStore(cas);
  await writeLedgerIntent({
    path: `${resolve(input.ledger_path)}.intent.json`,
    preflight: input.preflight,
    authorization_binding_sha256: authorizationBinding,
    genesis_sha256: genesis,
  });
  const ledger = await createLc4HashChainedLedgerWriter({
    path: input.ledger_path,
    genesis_sha256: genesis,
    evidence: replayEvidence,
  });
  const listener = createLc4PinnedListenerSink({
    corpus,
    listener_manifest_sha256: listenerManifest,
    criteria: input.criteria,
    evaluator: input.evaluator,
    playback_authority: input.playback_authority,
    playback_authority_manifest_sha256: input.playback_authority_manifest_sha256,
    cas,
  });
  const adapter = input.create_adapter(listener, input.control.gateway_executor, replayEvidence);
  const finalizeEpisode: Lc4DevLiveRunnerDependencies["finalization"]["finalizeEpisode"] = async ({
    episode,
    completed_opportunities,
    response_generations,
    repair_playbacks,
    ledger_head_before_terminal_sha256,
    segment_finalizations,
  }) => {
    if (completed_opportunities !== 60 || segment_finalizations.length !== 3) {
      throw new Error("LC4-DEV episode finalization requires 60 opportunities and three retained segments");
    }
    requireSha256(ledger_head_before_terminal_sha256, "LC4-DEV pre-terminal ledger head");
    for (const segment of segment_finalizations) await replayEvidence.assertResolvable(segment);
    const snapshot = freeze(input.control.snapshot(episode.episode_id));
    if (snapshot.episode_id !== episode.episode_id
      || snapshot.arm !== episode.arm
      || snapshot.opportunities !== 60
      || snapshot.pending_gateway_actions !== snapshot.pending_gateway_obligations.length) {
      throw new Error("LC4-DEV final control snapshot is incomplete or differs from the episode");
    }
    requireSha256(snapshot.common_state_sha256, "LC4-DEV final common state");
    requireSha256(snapshot.gateway_transcript_sha256, "LC4-DEV final gateway transcript");
    const body = freeze({
      schema_version: 1 as const,
      dependency_version: LC4_DEV_LIVE_DEPENDENCY_VERSION,
      execution_id: input.prepare.execution_id,
      prepare_sha256: input.prepare.prepare_sha256,
      preflight_sha256: input.preflight.preflight_sha256,
      control_plane_manifest_sha256: input.control.manifest_sha256,
      episode,
      completed_opportunities,
      response_generations,
      repair_playbacks,
      ledger_head_before_terminal_sha256,
      segment_finalizations,
      final_control_snapshot: snapshot,
      final_world: snapshot.world,
      pending_obligations: snapshot.pending_gateway_obligations,
      final_worker_state: snapshot.worker,
      final_repair_state: snapshot.repair_state,
    });
    return replayEvidence.retainJson({
      kind: "episode_finalization",
      body: body as unknown as JsonValue,
      domain_prefix: EPISODE_FINALIZATION_DOMAIN,
    });
  };
  const dependencies: Lc4DevLiveRunnerDependencies = Object.freeze({
    adapter,
    caller_audio: Object.freeze({
      load: async (binding: Lc4DevCallerAudioBinding) => {
        const pcm = await input.caller_audio.load(binding);
        if (pcm.byteLength !== binding.pcm_byte_length || sha256Hex(pcm) !== binding.pcm_sha256) {
          throw new Error("LC4-DEV caller PCM source differs from the prepare-bound audio CAS object");
        }
        return pcm;
      },
    }),
    caller_branch: Object.freeze({
      matrix: input.caller_branch.matrix,
      trust: input.caller_branch.trust,
      select: async ({ episode, canonical_opportunity }: Parameters<Lc4DevLiveRunnerDependencies["caller_branch"]["select"]>[0]) => {
        const decision = input.caller_branch.authority.decide({
          episode_id: episode.episode_id,
          provider: episode.provider,
          opportunity: canonical_opportunity,
          prior_receipt: input.control.callerBranchPriorReceipt(episode.episode_id),
        });
        assertLc4DevCallerBranchDecision({
          decision,
          matrix: input.caller_branch.matrix,
          trust: input.caller_branch.trust,
        });
        const binding = input.caller_branch.matrix.audio_bindings.find((entry) =>
          entry.provider === episode.provider && entry.prior_outcome === decision.prior_outcome
        );
        if (!binding) throw new Error("LC4-DEV caller branch decision has no pre-frozen PCM binding");
        const pcm = await input.caller_branch.load(binding);
        if (pcm.byteLength !== decision.pcm_byte_length || sha256Hex(pcm) !== decision.pcm_sha256) {
          throw new Error("LC4-DEV selected caller branch PCM differs from its signed decision");
        }
        const { decision_sha256: claimed, ...signed } = decision;
        const evidence = await replayEvidence.retainJson({
          kind: "caller_branch_decision",
          body: signed as unknown as JsonValue,
          domain_prefix: LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN,
          expected_evidence_sha256: claimed,
        });
        return Object.freeze({
          decision,
          opportunity: lc4DevBranchedOpportunity(canonical_opportunity, decision),
          pcm,
          evidence,
        });
      },
    }),
    retention: Object.freeze({
      retain: async ({ direction, pcm }: { direction: "caller_input" | "caller_repair" | "assistant_output" | "assistant_repair_output"; pcm: Uint8Array }) => {
        const receipt = await cas.put(pcm, "audio/pcm");
        const kind = direction === "caller_repair"
          ? "repair_pcm" as const
          : direction === "caller_input"
            ? "caller_pcm" as const
            : "assistant_pcm" as const;
        const evidence = await replayEvidence.retainBytes({
          kind,
          bytes: pcm,
          expected_evidence_sha256: receipt.artifact_sha256,
          media_type: "audio/pcm",
        });
        return Object.freeze({ artifact_sha256: receipt.artifact_sha256, byte_length: receipt.byte_length, evidence });
      },
    }),
    control: Object.freeze({
      next: async (request: Parameters<Lc4DevExecutableMechanismControl["next"]>[0]) => {
        const receipt = await input.control.next(request);
        const { control_receipt_sha256: claimed, ...body } = receipt;
        const evidence = await replayEvidence.retainJson({
          kind: "control_authority",
          body: body as unknown as JsonValue,
          domain_prefix: CONTROL_RECEIPT_DOMAIN,
          expected_evidence_sha256: claimed,
        });
        return Object.freeze({ receipt, evidence });
      },
    }),
    repair: input.repair,
    ledger,
    evidence: replayEvidence,
    finalization: Object.freeze({ finalizeEpisode }),
    now: input.now ?? (() => new Date()),
  });
  return Object.freeze({
    dependencies,
    cas,
    ledger,
    listener,
    evidence: replayEvidence,
    finalize: async () => ledger.close(),
  });
}
