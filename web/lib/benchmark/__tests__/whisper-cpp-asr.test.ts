import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  runWhisperCppAsr,
  type WhisperCppAsrConfig,
  type WhisperCppAsrSource,
} from "../whisper-cpp-asr";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function executable(path: string, source: string): Promise<string> {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return sha256Hex(await readFile(path));
}

async function fixture(whisperBody: string = `
const prefixIndex = process.argv.indexOf("--output-file");
if (prefixIndex < 0) process.exit(23);
require("node:fs").writeFileSync(process.argv[prefixIndex + 1] + ".txt", "Caller requested a Tuesday callback.\\n");
`): Promise<Readonly<{
  root: string;
  config: WhisperCppAsrConfig;
  source: WhisperCppAsrSource;
  whisperPath: string;
  ffmpegPath: string;
}>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hacc-whisper-test-")));
  roots.push(root);
  const whisperPath = join(root, "fake-whisper-cli");
  const ffmpegPath = join(root, "fake-ffmpeg");
  const modelPath = join(root, "ggml-small.en.bin");
  const nodeHeader = "#!/usr/bin/env node\n";
  const ffmpegSha256 = await executable(ffmpegPath, `${nodeHeader}
const fs = require("node:fs");
fs.writeFileSync(process.argv[1] + ".argv.json", JSON.stringify(process.argv.slice(2)));
const args = process.argv.slice(2);
const input = args[args.indexOf("-i") + 1];
const output = args.at(-1);
const wav = Buffer.alloc(44);
wav.write("RIFF", 0, "ascii");
wav.write("WAVE", 8, "ascii");
fs.writeFileSync(output, Buffer.concat([wav, fs.readFileSync(input)]));
`);
  const whisperSha256 = await executable(whisperPath, `${nodeHeader}
require("node:fs").writeFileSync(process.argv[1] + ".argv.json", JSON.stringify(process.argv.slice(2)));
${whisperBody}
`);
  await writeFile(modelPath, "fake pinned small.en weights", { mode: 0o600 });
  const modelSha256 = sha256Hex(await readFile(modelPath));
  return Object.freeze({
    root,
    whisperPath,
    ffmpegPath,
    config: Object.freeze({
      whisperCliPath: whisperPath,
      whisperCliSha256: whisperSha256,
      whisperCppVersion: "1.9.1",
      whisperCppSourceRevision: "a".repeat(40),
      modelPath,
      modelSha256,
      modelId: "ggml-small.en",
      modelRevision: "b".repeat(40),
      ffmpegPath,
      ffmpegSha256,
      language: "en",
      threads: 4,
      beamSize: 5,
      bestOf: 5,
      timeoutMs: 5_000,
    }),
    source: Object.freeze({
      runId: "run-long-call-001",
      unitId: "agent-turn-017",
      invocationId: "asr-invocation-017",
      sourceRequestSha256: "1".repeat(64),
      sourceChunkSequenceSha256: "2".repeat(64),
      pcm16Mono24khz: Uint8Array.from({ length: 96 }, (_, index) => index % 256),
    }),
  });
}

describe("pinned local whisper.cpp ASR", () => {
  it("uses fixed direct argv and emits a canonical, fully hash-bound receipt", async () => {
    const setup = await fixture();
    const run = await runWhisperCppAsr({
      config: setup.config,
      source: setup.source,
      temporaryRoot: setup.root,
    });

    const ffmpegArgs = JSON.parse(await readFile(`${setup.ffmpegPath}.argv.json`, "utf8")) as string[];
    const whisperArgs = JSON.parse(await readFile(`${setup.whisperPath}.argv.json`, "utf8")) as string[];
    expect(ffmpegArgs).toEqual(expect.arrayContaining([
      "-f", "s16le", "-ar", "24000", "-ac", "1",
      "-fflags", "+bitexact", "-flags:a", "+bitexact", "-ar", "16000",
    ]));
    expect(whisperArgs).toEqual(expect.arrayContaining([
      "--model", setup.config.modelPath,
      "--language", "en",
      "--temperature", "0",
      "--max-context", "0",
      "--output-txt",
    ]));
    expect(whisperArgs).not.toContain("--prompt");
    expect(run.receipt.source_played_audio_sha256).toBe(sha256Hex(setup.source.pcm16Mono24khz));
    expect(run.receipt.input.sample_rate_hz).toBe(24_000);
    expect(run.receipt.input.sample_count).toBe(48);
    expect(run.receipt.toolchain).toMatchObject({
      whisper_cpp_version: "1.9.1",
      whisper_cli_sha256: setup.config.whisperCliSha256,
      model_sha256: setup.config.modelSha256,
      ffmpeg_sha256: setup.config.ffmpegSha256,
    });
    expect(run.receipt.result).toMatchObject({
      status: "completed",
      source_request_sha256: setup.source.sourceRequestSha256,
      source_chunk_sequence_sha256: setup.source.sourceChunkSequenceSha256,
      transcript: "Caller requested a Tuesday callback.",
      processed_through_sample: 48,
    });
    expect(run.receipt.transcript_file_sha256).toBe(sha256Hex("Caller requested a Tuesday callback.\n"));
    expect(JSON.parse(run.canonicalReceiptJson)).toEqual(run.receipt);
    expect(run.canonicalReceiptJson.endsWith("\n")).toBe(true);
  });

  it("binds different played PCM to different audio, WAV, result, and receipt hashes", async () => {
    const setup = await fixture();
    const first = await runWhisperCppAsr({ config: setup.config, source: setup.source, temporaryRoot: setup.root });
    const secondPcm = Uint8Array.from(setup.source.pcm16Mono24khz);
    secondPcm[0] ^= 0xff;
    const second = await runWhisperCppAsr({
      config: setup.config,
      source: Object.freeze({ ...setup.source, invocationId: "asr-invocation-018", pcm16Mono24khz: secondPcm }),
      temporaryRoot: setup.root,
    });

    expect(second.receipt.source_played_audio_sha256).not.toBe(first.receipt.source_played_audio_sha256);
    expect(second.receipt.conversion.wav_sha256).not.toBe(first.receipt.conversion.wav_sha256);
    expect(second.receipt.normalized_result_sha256).not.toBe(first.receipt.normalized_result_sha256);
    expect(second.receipt.receipt_sha256).not.toBe(first.receipt.receipt_sha256);
  });

  it("fails closed before execution when a binary or model pin is wrong", async () => {
    const setup = await fixture();
    await expect(runWhisperCppAsr({
      config: Object.freeze({ ...setup.config, modelSha256: "f".repeat(64) }),
      source: setup.source,
      temporaryRoot: setup.root,
    })).rejects.toThrow("model hash does not match its pin");
  });

  it("fails closed on malformed transcript bytes", async () => {
    const setup = await fixture(`
const prefixIndex = process.argv.indexOf("--output-file");
require("node:fs").writeFileSync(process.argv[prefixIndex + 1] + ".txt", Buffer.from([0xc3, 0x28]));
`);
    await expect(runWhisperCppAsr({
      config: setup.config,
      source: setup.source,
      temporaryRoot: setup.root,
    })).rejects.toThrow("transcript is not valid UTF-8");
  });

  it("fails closed when whisper.cpp exits without transcript evidence", async () => {
    const setup = await fixture("process.exit(0);");
    await expect(runWhisperCppAsr({
      config: setup.config,
      source: setup.source,
      temporaryRoot: setup.root,
    })).rejects.toThrow("did not produce a regular transcript artifact");
  });

  it("kills a stalled fake whisper.cpp binary at the configured timeout", async () => {
    const setup = await fixture("setTimeout(() => process.exit(0), 5_000);");
    await expect(runWhisperCppAsr({
      config: Object.freeze({ ...setup.config, timeoutMs: 500 }),
      source: setup.source,
      temporaryRoot: setup.root,
    })).rejects.toThrow("whisper.cpp inference timed out");
  });
});
