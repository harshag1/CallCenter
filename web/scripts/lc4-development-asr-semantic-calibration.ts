import { execFile } from "node:child_process";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  createIndependentAsrRequest,
  independentAsrCalibrationSha256,
  prepareIndependentAsrCalibration,
  runIndependentAsrAdapter,
  type AsrCalibrationSourceFixture,
} from "../lib/benchmark/audible-evidence";
import {
  LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
  LC4_DEV_LISTENER_PLAN_SHA256,
  LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
} from "../lib/benchmark/lc4-development-listener-semantics";
import {
  createLc4DevelopmentLargeV3WhisperRuntime,
  type Lc4DevelopmentWhisperRuntimePaths,
} from "../lib/benchmark/lc4-development-whisper-runtime";
import { verifyLc4DevelopmentSemanticCalibrationArtifact } from "../lib/benchmark/lc4-development-asr-calibration-artifact";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
} from "../lib/benchmark/kernel-attestation";

const executeFile = promisify(execFile);
const ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-dev-semantic-asr-calibration/v1\n";
const SIGNATURE_DOMAIN = "harshas-amazing-call-center/lc4-dev-semantic-asr-calibration-signature/v1\n";
const SELECTED = Object.freeze([
  "lc4-dev-op-05", "lc4-dev-op-10", "lc4-dev-op-11", "lc4-dev-op-15",
  "lc4-dev-op-19", "lc4-dev-op-20", "lc4-dev-op-21", "lc4-dev-op-23",
  "lc4-dev-op-26", "lc4-dev-op-01", "lc4-dev-op-02", "lc4-dev-op-30",
  "lc4-dev-op-04", "lc4-dev-op-37", "lc4-dev-op-39", "lc4-dev-op-40",
  "lc4-dev-op-41", "lc4-dev-op-45", "lc4-dev-op-46", "lc4-dev-op-48",
  "lc4-dev-op-50", "lc4-dev-op-53", "lc4-dev-op-54", "lc4-dev-op-57",
] as const);
const ROUTES = Object.freeze([
  Object.freeze({ route_id: "synthetic-samantha", voice: "Samantha" }),
  Object.freeze({ route_id: "synthetic-daniel", voice: "Daniel" }),
]);
const SAMPLE_WORDS = Object.freeze([
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
  "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "zulu",
]);

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function speechFriendly(phrases: readonly string[]): string | null {
  const numericWord = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twentieth)\b/iu;
  const candidates = phrases.filter((phrase) => !/\d/u.test(phrase) && !numericWord.test(phrase));
  return [...candidates].sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? null;
}

function calibrationItems() {
  return SELECTED.map((opportunityId) => {
    const opportunity = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities
      .find((candidate) => candidate.opportunity_id === opportunityId);
    if (!opportunity || opportunity.criteria.length === 0) {
      throw new Error(`selected LC4-DEV semantic opportunity ${opportunityId} is unavailable`);
    }
    return Object.freeze({
      opportunity_id: opportunityId,
      criterion_plan_sha256: opportunity.criterion_plan_sha256,
      phrases: Object.freeze(opportunity.criteria.flatMap((criterion) => {
        const phrase = speechFriendly(criterion.phrases);
        return phrase === null ? [] : [phrase];
      })),
    });
  }).map((item) => {
    if (item.phrases.length === 0) throw new Error(`selected LC4-DEV semantic opportunity ${item.opportunity_id} has no speech-stable phrase`);
    return item;
  });
}

async function synthesize(input: Readonly<{
  voice: string;
  text: string;
  aiff_path: string;
  pcm_path: string;
  ffmpeg_path: string;
}>): Promise<Uint8Array> {
  await executeFile("/usr/bin/say", ["-v", input.voice, "-r", "175", "-o", input.aiff_path, input.text], {
    env: { NODE_ENV: "production", PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  await executeFile(input.ffmpeg_path, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input.aiff_path,
    "-map_metadata", "-1", "-vn", "-fflags", "+bitexact", "-flags:a", "+bitexact",
    "-ac", "1", "-ar", "24000", "-f", "s16le", "-c:a", "pcm_s16le", input.pcm_path,
  ], {
    env: { NODE_ENV: "production", PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const pcm = new Uint8Array(await readFile(input.pcm_path));
  if (pcm.byteLength < 2 || pcm.byteLength % 2 !== 0) throw new Error("synthetic calibration produced invalid PCM16");
  return pcm;
}

async function main(): Promise<void> {
  const root = flag("--root");
  const paths: Lc4DevelopmentWhisperRuntimePaths = Object.freeze({
    whisper_cli_path: flag("--whisper-cli"),
    model_path: flag("--model"),
    ffmpeg_path: flag("--ffmpeg"),
    temporary_root: root,
  });
  await mkdir(root, { recursive: false, mode: 0o700 });
  const runtime = createLc4DevelopmentLargeV3WhisperRuntime(paths);
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPath = join(root, "runner-private-key.pem");
  await writeFile(privateKeyPath, privateKeyPem, { flag: "wx", mode: 0o400 });
  await chmod(privateKeyPath, 0o400);
  const runnerSigner = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-dev-semantic-asr-calibration-20260721",
    privateKeyPem,
    publicKeyPem,
  });
  const runnerTrust = Object.freeze({
    keyId: runnerSigner.keyId,
    publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem),
    publicKeyPem,
  });
  const items = calibrationItems();
  const fixtures: AsrCalibrationSourceFixture[] = [];
  const retained: unknown[] = [];
  for (const route of ROUTES) {
    for (const [index, item] of items.entries()) {
      const fixtureId = `lc4-dev-${route.route_id}-${String(index + 1).padStart(2, "0")}`;
      const reference = `Listener calibration ${SAMPLE_WORDS[index]}. ${item.phrases.join(". ")}.`;
      const aiffPath = join(root, `${fixtureId}.aiff`);
      const pcmPath = join(root, `${fixtureId}.pcm`);
      const pcm = await synthesize({ voice: route.voice, text: reference, aiff_path: aiffPath, pcm_path: pcmPath, ffmpeg_path: paths.ffmpeg_path });
      const request = createIndependentAsrRequest({
        runId: "lc4-dev-semantic-calibration",
        unitId: fixtureId,
        invocationId: `inv-${fixtureId}`,
        adapterBlindNonceSha256: sha256Hex(`lc4-dev-semantic-calibration:${fixtureId}`),
        contract: runtime.contract,
        chunks: Object.freeze([{ chunkId: "synthetic-reference", encoding: "pcm16", sampleRateHz: 24_000, channels: 1, data: pcm }]),
        playedThroughByte: pcm.byteLength,
      });
      const invocation = await runIndependentAsrAdapter({
        request,
        contract: runtime.contract,
        runnerSigner,
        execute: runtime.execute_asr,
      });
      const fixture: AsrCalibrationSourceFixture = Object.freeze({
        fixture_id: fixtureId,
        route_id: route.route_id,
        split: "held_out",
        corpus_sample_id: `${item.opportunity_id}-${route.voice.toLowerCase()}`,
        reference_transcript: reference,
        expected_semantic_phrases: item.phrases,
        forbidden_semantic_phrases: Object.freeze(["counterfeit lunar permission", "zebra override accepted"]),
        reference_audio_start_sample: 0,
        reference_audio_end_sample: request.played_sample_count,
        invocation,
      });
      fixtures.push(fixture);
      retained.push(Object.freeze({
        fixture_id: fixtureId,
        route_id: route.route_id,
        voice: route.voice,
        opportunity_id: item.opportunity_id,
        criterion_plan_sha256: item.criterion_plan_sha256,
        reference_transcript: reference,
        expected_semantic_phrases: item.phrases,
        pcm_path: `${fixtureId}.pcm`,
        pcm_sha256: request.source_played_audio_sha256,
        request: {
          run_id: request.run_id,
          unit_id: request.unit_id,
          invocation_id: request.invocation_id,
          adapter_blind_nonce_sha256: request.adapter_blind_nonce_sha256,
          request_sha256: request.request_sha256,
          source_chunk_sequence_sha256: request.source_chunk_sequence_sha256,
          played_sample_count: request.played_sample_count,
        },
        result: invocation.result,
        signed_receipt: invocation.receipt,
      }));
    }
  }
  const calibration = prepareIndependentAsrCalibration({
    plan: Object.freeze({
      calibration_id: "lc4-dev-large-v3-semantic-tts-v1",
      protocol_sha256: LC4_DEV_LISTENER_PLAN_SHA256,
      corpus_manifest_sha256: sha256Hex(canonicalJson(items)),
      evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
      expected_route_ids: Object.freeze(ROUTES.map((route) => route.route_id)),
      thresholds: Object.freeze({
        min_fixture_coverage_ppm: 1_000_000,
        max_word_error_upper_bound_ppm: 250_000,
        max_semantic_false_negative_upper_bound_ppm: 200_000,
        max_semantic_false_positive_upper_bound_ppm: 200_000,
        max_alignment_boundary_p95_ms: 1_000,
        max_route_word_error_gap_ppm: 150_000,
      }),
    }),
    contract: runtime.contract,
    fixtures,
    runnerTrust,
  });
  const body = Object.freeze({
    schema_version: 1,
    artifact_type: "lc4_dev_provider_free_semantic_asr_calibration",
    created_at: new Date().toISOString(),
    semantic_plan_sha256: LC4_DEV_LISTENER_PLAN_SHA256,
    asr_contract: runtime.contract,
    asr_contract_sha256: runtime.contract_sha256,
    whisper_config_sha256: runtime.whisper_config_sha256,
    runner_trust: runnerTrust,
    tts: Object.freeze({
      executable: "/usr/bin/say",
      executable_sha256: sha256Hex(await readFile("/usr/bin/say")),
      routes: ROUTES,
      fixture_count: retained.length,
    }),
    calibration: calibration.summary,
    calibration_sha256: independentAsrCalibrationSha256(calibration.summary),
    fixtures: retained,
  });
  const artifactSha256 = sha256Hex(`${ARTIFACT_DOMAIN}${canonicalJson(body)}`);
  const artifact = Object.freeze({
    ...body,
    artifact_sha256: artifactSha256,
    signature: Object.freeze({
      algorithm: "ed25519",
      key_id: runnerSigner.keyId,
      signature_base64: signBytes(null, Buffer.from(`${SIGNATURE_DOMAIN}${artifactSha256}`, "utf8"), pair.privateKey).toString("base64"),
    }),
  });
  const path = join(root, "calibration-artifact.json");
  await writeFile(path, `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o400 });
  await chmod(path, 0o400);
  const verification = await verifyLc4DevelopmentSemanticCalibrationArtifact({ artifact, root_dir: root });
  if (!verification.valid) throw new Error(`retained calibration verification failed: ${verification.errors.join("; ")}`);
  process.stdout.write(`${canonicalJson({
    artifact_path: path,
    artifact_sha256: artifactSha256,
    calibration_sha256: body.calibration_sha256,
    status: calibration.summary.status,
    metrics: calibration.summary.metrics,
    route_metrics: calibration.summary.route_metrics,
    unvalidated_reasons: calibration.summary.unvalidated_reasons,
    verification,
    runner_private_key_path: privateKeyPath,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
