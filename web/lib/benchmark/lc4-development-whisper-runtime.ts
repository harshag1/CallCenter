import { canonicalJson, sha256Hex } from "./artifacts";
import {
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  independentAsrContractSha256,
  type IndependentAsrAdapterExecution,
  type IndependentAsrAdapterInput,
  type IndependentAsrContract,
} from "./audible-evidence";
import { LC4_DEV_TIMEOUT_CONTRACT } from "./lc4-development-timeout-contract";
import {
  runWhisperCppAsr,
  type WhisperCppAsrConfig,
  type WhisperCppAsrReceipt,
} from "./whisper-cpp-asr";

const SHA256 = /^[a-f0-9]{64}$/u;
const CONFIG_DOMAIN = "hacc/whisper-cpp-asr-config/v1\n";
const RESAMPLING_PROFILE = "ffmpeg-pcm16le-24khz-mono-to-wav-pcm16le-16khz-mono-bitexact-v1";
const DEPENDENCY_LOCK_DOMAIN = "harshas-amazing-call-center/lc4-dev-whisper-dependency-lock/v1\n";

export const LC4_DEV_WHISPER_CPP_VERSION = "1.9.1" as const;
export const LC4_DEV_WHISPER_CPP_SOURCE_REVISION = "f049fff95a089aa9969deb009cdd4892b3e74916" as const;
export const LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256 = "1fbabb51a45906bd36684695de9025eab63618a6eedc26971c47fa5affc5fe49" as const;
export const LC4_DEV_WHISPER_LARGE_V3_MODEL_ID = "ggml-large-v3-turbo-q5_0" as const;
export const LC4_DEV_WHISPER_LARGE_V3_MODEL_REVISION = "98aa99a0a9db05ae2342309f5096248665f7cba3" as const;
export const LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2" as const;
export const LC4_DEV_FFMPEG_SHA256 = "7bd117ad875e7ebfc48bdd90715836b71b24ecac2ef92b8e1240def7435ca63d" as const;
export const LC4_DEV_OUTPUT_ROUTE_CALIBRATION_ARTIFACT_SHA256 = "5a40c0a29ed4719876a6613a9679e55bc94f8d6b50fe2862e1cbfb1f3477cda2" as const;
export const LC4_DEV_OUTPUT_ROUTE_CALIBRATION_CONFIG_SHA256 = "350dd7ba017a00adecb413a46eac986b8da4b9c8d5e889fbff5ff3a40acfc974" as const;
export const LC4_DEV_OUTPUT_ROUTE_CALIBRATION_MANIFEST_SHA256 = "63310807b42ee1ab7fdf11e4bffa084f040677f1e3d4bbefb623fade7d926d0e" as const;

export const LC4_DEV_OUTPUT_ROUTE_IDS = Object.freeze([
  "openai/gpt-realtime-2.1/marin",
  "gemini/gemini-3.1-flash-live-preview/Aoede",
  "xai/grok-voice-think-fast-1.0/ara",
] as const);

export type Lc4DevelopmentWhisperRuntimePaths = Readonly<{
  whisper_cli_path: string;
  model_path: string;
  ffmpeg_path: string;
  temporary_root?: string;
}>;

export type Lc4DevelopmentWhisperRuntime = Readonly<{
  contract: IndependentAsrContract;
  contract_sha256: string;
  whisper_config: WhisperCppAsrConfig;
  whisper_config_sha256: string;
  execute_asr(input: IndependentAsrAdapterInput): Promise<IndependentAsrAdapterExecution>;
}>;

function configSha256(config: WhisperCppAsrConfig): string {
  return sha256Hex(`${CONFIG_DOMAIN}${canonicalJson({
    schema_version: 1,
    engine: {
      implementation: "whisper.cpp",
      version: config.whisperCppVersion,
      source_revision: config.whisperCppSourceRevision,
      executable_sha256: config.whisperCliSha256,
      model_id: config.modelId,
      model_revision: config.modelRevision,
      weights_sha256: config.modelSha256,
    },
    decoding: {
      language: config.language,
      task: "transcribe",
      temperature_milli: 0,
      beam_size: config.beamSize,
      best_of: config.bestOf,
      threads: config.threads,
      condition_on_previous_text: false,
    },
    ffmpeg_sha256: config.ffmpegSha256,
    resampling_profile: RESAMPLING_PROFILE,
    timeout_ms: config.timeoutMs,
  })}`);
}

function requireHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function dependencyLockSha256(config: WhisperCppAsrConfig): string {
  return sha256Hex(`${DEPENDENCY_LOCK_DOMAIN}${canonicalJson({
    whisper_cpp_version: config.whisperCppVersion,
    whisper_cpp_source_revision: config.whisperCppSourceRevision,
    whisper_cli_sha256: config.whisperCliSha256,
    model_id: config.modelId,
    model_revision: config.modelRevision,
    model_sha256: config.modelSha256,
    ffmpeg_sha256: config.ffmpegSha256,
    resampling_profile: RESAMPLING_PROFILE,
  })}`);
}

export function createLc4DevelopmentLargeV3WhisperContract(config: WhisperCppAsrConfig): IndependentAsrContract {
  const actualConfigSha256 = configSha256(config);
  if (actualConfigSha256 !== LC4_DEV_OUTPUT_ROUTE_CALIBRATION_CONFIG_SHA256) {
    throw new Error("LC4-DEV whisper configuration differs from the exact passing output-route calibration");
  }
  const contract: IndependentAsrContract = Object.freeze({
    schema_version: 1,
    contract_id: "lc4-dev-whisper-cpp-large-v3-turbo-q5-v1",
    engine: Object.freeze({
      implementation: "whisper.cpp",
      source_repository: "https://github.com/ggml-org/whisper.cpp",
      source_revision: config.whisperCppSourceRevision,
      executable_sha256: config.whisperCliSha256,
      dependency_lock_sha256: dependencyLockSha256(config),
      model_id: config.modelId,
      model_revision: config.modelRevision,
      weights_sha256: config.modelSha256,
    }),
    decoding: Object.freeze({
      language: "en",
      task: "transcribe",
      temperature_milli: 0,
      beam_size: 5,
      best_of: 5,
      word_timestamps: true,
      condition_on_previous_text: false,
      initial_prompt_sha256: null,
    }),
    resampling_profile_sha256: sha256Hex(RESAMPLING_PROFILE),
    result_schema_sha256: INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  });
  independentAsrContractSha256(contract);
  return contract;
}

function assertInnerReceipt(receipt: WhisperCppAsrReceipt, input: IndependentAsrAdapterInput, config: WhisperCppAsrConfig): void {
  if (receipt.config_sha256 !== LC4_DEV_OUTPUT_ROUTE_CALIBRATION_CONFIG_SHA256
    || receipt.source_request_sha256 !== input.source_request_sha256
    || receipt.source_chunk_sequence_sha256 !== input.source_chunk_sequence_sha256
    || receipt.source_played_audio_sha256 !== sha256Hex(input.played_pcm)
    || receipt.input.sample_count !== input.played_sample_count
    || receipt.toolchain.whisper_cli_sha256 !== config.whisperCliSha256
    || receipt.toolchain.model_sha256 !== config.modelSha256
    || receipt.toolchain.ffmpeg_sha256 !== config.ffmpegSha256) {
    throw new Error("LC4-DEV whisper receipt differs from the blind request or pinned toolchain");
  }
}

/**
 * Exact local runtime used by the condition-blind listener evaluator. The
 * adapter input has no provider, arm, flow, criterion text, or response-plan
 * fields. It performs no executable discovery or network access.
 */
export function createLc4DevelopmentLargeV3WhisperRuntime(
  paths: Lc4DevelopmentWhisperRuntimePaths,
): Lc4DevelopmentWhisperRuntime {
  const whisperConfig: WhisperCppAsrConfig = Object.freeze({
    whisperCliPath: paths.whisper_cli_path,
    whisperCliSha256: LC4_DEV_WHISPER_CPP_EXECUTABLE_SHA256,
    whisperCppVersion: LC4_DEV_WHISPER_CPP_VERSION,
    whisperCppSourceRevision: LC4_DEV_WHISPER_CPP_SOURCE_REVISION,
    modelPath: paths.model_path,
    modelSha256: LC4_DEV_WHISPER_LARGE_V3_MODEL_SHA256,
    modelId: LC4_DEV_WHISPER_LARGE_V3_MODEL_ID,
    modelRevision: LC4_DEV_WHISPER_LARGE_V3_MODEL_REVISION,
    ffmpegPath: paths.ffmpeg_path,
    ffmpegSha256: LC4_DEV_FFMPEG_SHA256,
    language: "en",
    threads: 8,
    beamSize: 5,
    bestOf: 5,
    timeoutMs: LC4_DEV_TIMEOUT_CONTRACT.listener_asr_ms,
  });
  const whisperConfigSha256 = configSha256(whisperConfig);
  const contract = createLc4DevelopmentLargeV3WhisperContract(whisperConfig);
  const contractSha256 = independentAsrContractSha256(contract);
  for (const digest of [whisperConfigSha256, contractSha256]) requireHash(digest, "LC4-DEV whisper runtime hash");

  return Object.freeze({
    contract,
    contract_sha256: contractSha256,
    whisper_config: whisperConfig,
    whisper_config_sha256: whisperConfigSha256,
    execute_asr: async (adapterInput): Promise<IndependentAsrAdapterExecution> => {
      if (adapterInput.schema_version !== 1
        || adapterInput.asr_contract_sha256 !== contractSha256
        || adapterInput.format.encoding !== "pcm16"
        || adapterInput.format.endianness !== "little"
        || adapterInput.format.channels !== 1
        || adapterInput.format.sample_rate_hz !== 24_000
        || adapterInput.played_sample_count * 2 !== adapterInput.played_pcm.byteLength) {
        throw new Error("LC4-DEV whisper adapter received an unsupported or detached blind PCM request");
      }
      requireHash(adapterInput.adapter_blind_nonce_sha256, "LC4-DEV ASR blind nonce");
      requireHash(adapterInput.source_request_sha256, "LC4-DEV ASR request hash");
      requireHash(adapterInput.source_chunk_sequence_sha256, "LC4-DEV ASR chunk-sequence hash");
      const run = await runWhisperCppAsr({
        config: whisperConfig,
        source: {
          runId: `blind-${adapterInput.adapter_blind_nonce_sha256.slice(0, 24)}`,
          unitId: `pcm-${sha256Hex(adapterInput.played_pcm).slice(0, 24)}`,
          invocationId: `asr-${adapterInput.adapter_blind_nonce_sha256.slice(0, 24)}`,
          sourceRequestSha256: adapterInput.source_request_sha256,
          sourceChunkSequenceSha256: adapterInput.source_chunk_sequence_sha256,
          pcm16Mono24khz: Uint8Array.from(adapterInput.played_pcm),
        },
        temporaryRoot: paths.temporary_root,
      });
      assertInnerReceipt(run.receipt, adapterInput, whisperConfig);
      return Object.freeze({
        result: run.receipt.result,
        exitCode: 0,
        runtimeMs: run.receipt.conversion.runtime_ms + run.receipt.inference.runtime_ms,
        stdout: run.canonicalReceiptJson,
        stderr: "",
      });
    },
  });
}
