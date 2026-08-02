import { createReadStream } from "node:fs";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  independentAsrContractSha256,
  type IndependentAsrContract,
} from "./audible-evidence";
import { createBenchmarkKernelAttestationSigner } from "./kernel-attestation";
import {
  createLc4DevCallerBranchAudioAccessor,
  createLc4DevCallerAudioLoader,
  type Lc4DevAudioManifest,
  type Lc4DevRepairAudioBinding,
  type Lc4DevRepairAudioManifest,
} from "./lc4-development-audio-materializer";
import {
  createLc4DevCallerBranchAuthority,
  createLc4DevCallerBranchMatrixArtifact,
} from "./lc4-development-caller-branch";
import {
  prepareLc4DevelopmentSemanticCalibrationFromArtifact,
  type Lc4DevelopmentSemanticCalibrationArtifact,
} from "./lc4-development-asr-calibration-artifact";
import { createLc4DevMunicipalControlPlane } from "./lc4-development-control-plane";
import {
  inspectLc4DevResponseControlSizes,
  type Lc4DevResponseControlPreflightReport,
} from "./lc4-development-response-control-preflight";
import {
  createLc4HeadlessListenerAuthorityManifestSha256,
  createLc4HeadlessListenerPlaybackAuthority,
} from "./lc4-development-headless-listener-authority";
import {
  createLc4ImmutableCas,
  createLc4DevelopmentLiveDependencies,
  createLc4PinnedListenerManifestSha256,
} from "./lc4-development-live-dependencies";
import {
  createLc4DevAsrRunnerTrust,
  type Lc4DevAsrRunnerTrust,
} from "./lc4-development-live-runner";
import {
  type Lc4DevOperatorRuntime,
  type Lc4DevOperatorSigner,
} from "./lc4-development-operator-cli";
import {
  createLc4DevelopmentPinnedListenerEvaluator,
  lc4DevelopmentListenerCriterionBindings,
} from "./lc4-development-listener-semantics";
import { createLc4DevRepairPlaybackController } from "./lc4-development-repair-playback";
import { createLc4DevelopmentRealtimeAdapter } from "./lc4-production-provider-adapter";
import {
  LC4_DEV_FFMPEG_SHA256,
  LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256,
  LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256,
  createLc4DevelopmentLargeV3WhisperRuntime,
} from "./lc4-development-whisper-runtime";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const RUNTIME_CONFIG_DOMAIN = "harshas-amazing-call-center/lc4-dev-default-runtime/v3\n";
const ASR_TOOLCHAIN_DOMAIN = "harshas-amazing-call-center/lc4-dev-asr-evaluator-toolchain/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;

export type Lc4DevDefaultRuntimeConfig = Readonly<{
  audio_root: string;
  semantic_calibration_root: string;
  asr_runner_private_key_source: string;
  whisper_cli_path: string;
  whisper_model_path: string;
  ffmpeg_path: string;
}>;

export type Lc4DevDefaultRuntimeComposition = Readonly<{
  schema_version: 3;
  runtime_kind: "lc4-dev-default-operator-runtime";
  audio_manifest_sha256: string;
  repair_manifest_sha256: string;
  calibration_artifact_sha256: string;
  calibration_sha256: string;
  asr_contract: IndependentAsrContract;
  asr_contract_sha256: string;
  whisper_config_sha256: string;
  asr_evaluator_build_sha256: string;
  asr_evaluator_toolchain_sha256: string;
  asr_runner_trust: Lc4DevAsrRunnerTrust;
  criterion_binding_set_sha256: string;
  caller_binding_count: 180;
  repair_binding_count: 72;
  runtime_config_sha256: string;
}>;

/** Pure, portable root constructor used by both tests and the live factory. */
export function createLc4DevelopmentDefaultRuntimeComposition(
  input: Omit<Lc4DevDefaultRuntimeComposition, "schema_version" | "runtime_kind" | "runtime_config_sha256">,
): Lc4DevDefaultRuntimeComposition {
  for (const [label, digest] of Object.entries({
    audio_manifest_sha256: input.audio_manifest_sha256,
    repair_manifest_sha256: input.repair_manifest_sha256,
    calibration_artifact_sha256: input.calibration_artifact_sha256,
    calibration_sha256: input.calibration_sha256,
    asr_contract_sha256: input.asr_contract_sha256,
    whisper_config_sha256: input.whisper_config_sha256,
    asr_evaluator_build_sha256: input.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: input.asr_evaluator_toolchain_sha256,
    criterion_binding_set_sha256: input.criterion_binding_set_sha256,
  })) {
    if (!SHA256.test(digest)) throw new Error(`LC4-DEV runtime composition ${label} must be one lowercase SHA-256`);
  }
  createLc4DevAsrRunnerTrust(input.asr_runner_trust);
  if (independentAsrContractSha256(input.asr_contract)
      !== input.asr_contract_sha256) {
    throw new Error("LC4-DEV runtime composition ASR contract hash mismatch");
  }
  if (input.caller_binding_count !== 180 || input.repair_binding_count !== 72) {
    throw new Error("LC4-DEV runtime composition requires exactly 180 caller and 72 repair bindings");
  }
  const body = Object.freeze({
    schema_version: 3 as const,
    runtime_kind: "lc4-dev-default-operator-runtime" as const,
    ...input,
  });
  return Object.freeze({
    ...body,
    runtime_config_sha256: sha256Hex(`${RUNTIME_CONFIG_DOMAIN}${canonicalJson(body)}`),
  });
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
  return path;
}

function inside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

async function sha256File(path: string, expected: string, label: string): Promise<void> {
  absolute(path, label);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular non-symlink, non-hard-linked file`);
  }
  const digest = await new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
  if (digest !== expected) throw new Error(`${label} content hash differs from the frozen LC4-DEV dependency`);
}

async function readCalibration(root: string): Promise<Lc4DevelopmentSemanticCalibrationArtifact> {
  absolute(root, "LC4-DEV semantic calibration root");
  const path = resolve(root, "calibration-artifact.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) {
    throw new Error("LC4-DEV calibration artifact must be one bounded regular file");
  }
  return JSON.parse(await readFile(path, "utf8")) as Lc4DevelopmentSemanticCalibrationArtifact;
}

async function createRunnerSigner(
  source: string,
  artifact: Lc4DevelopmentSemanticCalibrationArtifact,
) {
  absolute(source, "LC4-DEV ASR runner private key");
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0 || metadata.size < 32 || metadata.size > MAX_KEY_BYTES) {
    throw new Error("LC4-DEV ASR runner private key must be regular, private, non-linked, and bounded");
  }
  const privateKeyPem = await readFile(source, "utf8");
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("LC4-DEV ASR runner private key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const fingerprint = sha256Hex(new Uint8Array(publicKey.export({ type: "spki", format: "der" })));
  if (fingerprint !== artifact.runner_trust.publicKeySha256) {
    throw new Error("LC4-DEV ASR runner key differs from the signed calibration trust root");
  }
  return createBenchmarkKernelAttestationSigner({
    keyId: artifact.runner_trust.keyId,
    privateKeyPem,
    publicKeyPem: artifact.runner_trust.publicKeyPem,
  });
}

function authoritySigner(signer: Lc4DevOperatorSigner) {
  return createBenchmarkKernelAttestationSigner({
    keyId: `lc4-dev-authority-${signer.public_key_fingerprint_sha256.slice(0, 24)}`,
    privateKeyPem: signer.private_key_pkcs8_pem,
    publicKeyPem: signer.public_key_spki_pem,
  });
}

function repairLoader(root: string, manifest: Lc4DevRepairAudioManifest) {
  const normalizedRoot = resolve(root);
  return async (binding: Lc4DevRepairAudioBinding): Promise<Uint8Array> => {
    const expected = manifest.repair_audio_bindings.find((candidate) =>
      candidate.provider === binding.provider && candidate.repair_id === binding.repair_id
    );
    if (!expected || canonicalJson(expected) !== canonicalJson(binding)) {
      throw new Error("LC4-DEV repair loader rejected an uncommitted binding");
    }
    const path = resolve(normalizedRoot, binding.pcm_path);
    if (!inside(normalizedRoot, path)) throw new Error("LC4-DEV repair PCM path escapes the audio root");
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength !== binding.pcm_byte_length || sha256Hex(bytes) !== binding.pcm_sha256) {
      throw new Error("LC4-DEV repair PCM differs from its immutable manifest binding");
    }
    return bytes;
  };
}

/**
 * Builds the actual six-episode operator runtime from explicit local evidence.
 * Construction verifies the large-v3 toolchain, signed v4 calibration, and
 * retained calibration signer before a provider socket can be opened.
 */
export async function createLc4DevelopmentDefaultOperatorRuntime(
  config: Lc4DevDefaultRuntimeConfig,
): Promise<Lc4DevOperatorRuntime> {
  const audioRoot = absolute(config.audio_root, "LC4-DEV audio root");
  const calibrationRoot = absolute(config.semantic_calibration_root, "LC4-DEV semantic calibration root");
  const [artifact] = await Promise.all([
    readCalibration(calibrationRoot),
    sha256File(config.whisper_cli_path, LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256, "LC4-DEV whisper CLI"),
    sha256File(config.whisper_model_path, LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256, "LC4-DEV whisper model"),
    sha256File(config.ffmpeg_path, LC4_DEV_FFMPEG_SHA256, "LC4-DEV ffmpeg"),
  ]);
  const [calibration, asrRunnerSigner] = await Promise.all([
    prepareLc4DevelopmentSemanticCalibrationFromArtifact({ artifact, root_dir: calibrationRoot }),
    createRunnerSigner(config.asr_runner_private_key_source, artifact),
  ]);
  const asrRunnerPublicKey = createPublicKey(
    artifact.runner_trust.publicKeyPem,
  );
  const asrRunnerPublicKeyDer = asrRunnerPublicKey.export({
    format: "der",
    type: "spki",
  });
  const asrRunnerTrust = createLc4DevAsrRunnerTrust({
    key_id: asrRunnerSigner.keyId,
    public_key_spki_base64: asrRunnerPublicKeyDer.toString("base64"),
    public_key_fingerprint_sha256: asrRunnerSigner.publicKeySha256,
    signature_algorithm: "Ed25519",
  });
  const whisper = createLc4DevelopmentLargeV3WhisperRuntime({
    whisper_cli_path: config.whisper_cli_path,
    model_path: config.whisper_model_path,
    ffmpeg_path: config.ffmpeg_path,
  });
  if (canonicalJson(whisper.contract) !== canonicalJson(artifact.asr_contract)
    || whisper.contract_sha256 !== artifact.asr_contract_sha256
    || whisper.whisper_config_sha256 !== artifact.whisper_config_sha256) {
    throw new Error("LC4-DEV runtime ASR identity differs from the verified calibration artifact");
  }
  const criteria = lc4DevelopmentListenerCriterionBindings();
  const asrEvaluatorToolchainSha256 = sha256Hex(`${ASR_TOOLCHAIN_DOMAIN}${canonicalJson({
    whisper_cli_sha256: LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256,
    whisper_model_sha256: LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256,
    ffmpeg_sha256: LC4_DEV_FFMPEG_SHA256,
    whisper_config_sha256: whisper.whisper_config_sha256,
    asr_contract_sha256: whisper.contract_sha256,
  })}`);
  let runtimeComposition: Lc4DevDefaultRuntimeComposition | null = null;
  let responseControlPreflight: Lc4DevResponseControlPreflightReport | null = null;
  const baseRuntimeComposition = {
    calibration_artifact_sha256: artifact.artifact_sha256,
    calibration_sha256: artifact.calibration_sha256,
    asr_contract: whisper.contract,
    asr_contract_sha256: whisper.contract_sha256,
    whisper_config_sha256: whisper.whisper_config_sha256,
    asr_evaluator_build_sha256: calibration.summary.evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: asrEvaluatorToolchainSha256,
    asr_runner_trust: asrRunnerTrust,
    criterion_binding_set_sha256: sha256Hex(canonicalJson(criteria)),
  };

  function mechanism(input: Readonly<{
    audio_manifest: Lc4DevAudioManifest;
    repair_manifest: Lc4DevRepairAudioManifest;
    signer: Lc4DevOperatorSigner;
  }>) {
    const signer = authoritySigner(input.signer);
    const branchSigningIdentity = Object.freeze({
      key_id: `lc4-dev-authority-${input.signer.public_key_fingerprint_sha256.slice(0, 24)}`,
      private_key_pem: input.signer.private_key_pkcs8_pem,
      public_key_pem: input.signer.public_key_spki_pem,
    });
    const branchAudio = createLc4DevCallerBranchAudioAccessor({ manifest: input.audio_manifest });
    const branchMatrix = createLc4DevCallerBranchMatrixArtifact({
      audio_manifest_sha256: branchAudio.audio_manifest_sha256,
      audio_bindings: input.audio_manifest.caller_branch_audio_bindings,
      signing_identity: branchSigningIdentity,
    });
    const branchAuthority = createLc4DevCallerBranchAuthority({
      matrix: branchMatrix,
      signing_identity: branchSigningIdentity,
    });
    const control = createLc4DevMunicipalControlPlane({
      audio_manifest: input.audio_manifest,
      repair_manifest: input.repair_manifest,
      signer,
    });
    const playbackAuthority = createLc4HeadlessListenerPlaybackAuthority({ signer });
    const playbackAuthorityManifestSha256 = createLc4HeadlessListenerAuthorityManifestSha256({ signer });
    const listenerManifestSha256 = createLc4PinnedListenerManifestSha256({
      corpus_sha256: input.audio_manifest.public_corpus_artifact_sha256,
      evaluator: {
        evaluator_contract_sha256: whisper.contract_sha256,
        evaluator_build_sha256: calibration.summary.evaluator_build_sha256,
        calibration_sha256: artifact.calibration_sha256,
      },
      criteria,
      playback_authority_manifest_sha256: playbackAuthorityManifestSha256,
    });
    return Object.freeze({
      signer,
      control,
      caller_branch: Object.freeze({
        matrix: branchMatrix,
        authority: branchAuthority,
        trust: Object.freeze({
          key_id: branchSigningIdentity.key_id,
          public_key_pem: branchSigningIdentity.public_key_pem,
        }),
      }),
      playback_authority: playbackAuthority,
      playback_authority_manifest_sha256: playbackAuthorityManifestSha256,
      listener_manifest_sha256: listenerManifestSha256,
    });
  }

  return Object.freeze({
    kind: "lc4-dev-operator-runtime-v1" as const,
    inspect: async ({ prepare, audio_manifest, repair_manifest, signer }) => {
      const callerLoader = createLc4DevCallerAudioLoader({ outputRoot: audioRoot, manifest: audio_manifest });
      const loadRepairPcm = repairLoader(audioRoot, repair_manifest);
      await Promise.all([
        ...audio_manifest.caller_audio_bindings.map((binding) => callerLoader.load(binding)),
        ...audio_manifest.caller_branch_audio_bindings.map((binding) => callerLoader.loadBranch(binding)),
        ...repair_manifest.repair_audio_bindings.map((binding) => loadRepairPcm(binding)),
      ]);
      const composition = createLc4DevelopmentDefaultRuntimeComposition({
        ...baseRuntimeComposition,
        audio_manifest_sha256: audio_manifest.manifest_sha256,
        repair_manifest_sha256: repair_manifest.repair_manifest_sha256,
        caller_binding_count: audio_manifest.caller_audio_bindings.length as 180,
        repair_binding_count: repair_manifest.repair_audio_bindings.length as 72,
      });
      if (runtimeComposition && canonicalJson(runtimeComposition) !== canonicalJson(composition)) {
        throw new Error("LC4-DEV default runtime composition changed after inspection");
      }
      runtimeComposition = composition;
      const built = mechanism({ audio_manifest, repair_manifest, signer });
      if (responseControlPreflight === null) {
        responseControlPreflight = await inspectLc4DevResponseControlSizes({
          episodes: prepare.episodes,
          create_control: () => mechanism({ audio_manifest, repair_manifest, signer }).control,
        });
      } else if (
        responseControlPreflight.control_manifest_sha256
        !== built.control.manifest_sha256
      ) {
        throw new Error(
          "LC4-DEV response control preflight differs from the inspected control plane",
        );
      }
      return Object.freeze({
        control_plane_manifest_sha256: built.control.manifest_sha256,
        listener_evidence_manifest_sha256: built.listener_manifest_sha256,
        runtime_config_sha256: composition.runtime_config_sha256,
        asr_evaluator_build_sha256: composition.asr_evaluator_build_sha256,
        asr_evaluator_toolchain_sha256: composition.asr_evaluator_toolchain_sha256,
        asr_contract: composition.asr_contract,
        asr_contract_sha256: composition.asr_contract_sha256,
        asr_runner_trust: composition.asr_runner_trust,
      });
    },
    build: async ({
      prepare,
      preflight,
      audio_manifest,
      repair_manifest,
      audio_root,
      evidence_root,
      credentials,
      signer,
      budget_authority,
      completed_prefix,
    }) => {
      if (resolve(audio_root) !== audioRoot) throw new Error("LC4-DEV build audio root differs from the inspected runtime root");
      const built = mechanism({ audio_manifest, repair_manifest, signer });
      if (built.control.manifest_sha256 !== preflight.control_plane_manifest_sha256
        || built.listener_manifest_sha256 !== preflight.listener_evidence_manifest_sha256
        || responseControlPreflight === null
        || responseControlPreflight.control_manifest_sha256 !== built.control.manifest_sha256
        || runtimeComposition?.runtime_config_sha256 !== preflight.runtime_config_sha256
        || calibration.summary.evaluator_build_sha256 !== preflight.asr_evaluator_build_sha256
        || asrEvaluatorToolchainSha256 !== preflight.asr_evaluator_toolchain_sha256
        || whisper.contract_sha256 !== preflight.asr_contract_sha256
        || canonicalJson(whisper.contract)
          !== canonicalJson(preflight.asr_contract)
        || canonicalJson(asrRunnerTrust)
          !== canonicalJson(preflight.asr_runner_trust)) {
        throw new Error("LC4-DEV default runtime roots differ from signed preflight");
      }
      const casRoot = resolve(evidence_root, "cas");
      const evaluatorCas = await createLc4ImmutableCas(casRoot);
      const evaluator = createLc4DevelopmentPinnedListenerEvaluator({
        asr_contract: whisper.contract,
        asr_calibration: calibration,
        asr_runner_signer: asrRunnerSigner,
        retention: Object.freeze({ put: (bytes, mediaType) => evaluatorCas.put(bytes, mediaType) }),
        execute_asr: whisper.execute_asr,
      });
      if (evaluator.evaluator_contract_sha256 !== whisper.contract_sha256
        || evaluator.evaluator_build_sha256 !== calibration.summary.evaluator_build_sha256
        || evaluator.calibration_sha256 !== artifact.calibration_sha256) {
        throw new Error("LC4-DEV evaluator identity differs from the inspected listener root");
      }
      const loadRepairPcm = repairLoader(audio_root, repair_manifest);
      const repairs = Object.freeze(Object.fromEntries((["openai", "gemini", "xai"] as const).map((provider) => [
        provider,
        createLc4DevRepairPlaybackController({
          provider,
          audio_manifest,
          repair_manifest,
          load_repair_pcm: loadRepairPcm,
        }),
      ])) as Record<"openai" | "gemini" | "xai", ReturnType<typeof createLc4DevRepairPlaybackController>>);
      const callerAudio = createLc4DevCallerAudioLoader({ outputRoot: audio_root, manifest: audio_manifest });
      return createLc4DevelopmentLiveDependencies({
        prepare,
        preflight,
        cas_root_dir: casRoot,
        ledger_path: resolve(evidence_root, "ledger.jsonl"),
        completed_prefix,
        caller_audio: callerAudio,
        caller_branch: Object.freeze({
          ...built.caller_branch,
          load: callerAudio.loadBranch,
        }),
        control: built.control,
        authority_signer: built.signer,
        repair: repairs,
        criteria,
        evaluator,
        playback_authority: built.playback_authority,
        playback_authority_manifest_sha256: built.playback_authority_manifest_sha256,
        create_adapter: (listener, gatewayExecutor, evidence) => createLc4DevelopmentRealtimeAdapter({
          prepare,
          preflight,
          credentials,
          caller_branch_authority: Object.freeze({
            matrix: built.caller_branch.matrix,
            trust: built.caller_branch.trust,
          }),
          listener,
          gateway_executor: gatewayExecutor,
          evidence,
          budget_authority,
        }),
      });
    },
  });
}
