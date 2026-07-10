import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkProcessRequest,
  BenchmarkProcessResult,
  BenchmarkProcessRunner,
  prepareCallerAudioFixture,
} from "../audio-fixture-generator";
import {
  CallerAudioScenarioIdentity,
  CallerAudioTurn,
  assertPairedCallerAudio,
  createCallerAudioFixtureManifest,
  createCallerPcmDescriptor,
  hashCallerAudioSequence,
  loadFrozenCallerAudioForPaidTrial,
  readFrozenFixtureFileNoFollow,
  verifyCallerAudioFixture,
} from "../audio-fixtures";
import { canonicalJson, sha256Hex } from "../artifacts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type FakeToolchain = Readonly<{
  root: string;
  fixtureRoot: string;
  say: string;
  ffmpeg: string;
  swVers: string;
  otool: string;
  libsoxr: string;
  calls: BenchmarkProcessRequest[];
  runner: BenchmarkProcessRunner;
}>;

function success(stdout = "", stderr = ""): BenchmarkProcessResult {
  return Object.freeze({ exitCode: 0, signal: null, stdout, stderr });
}

async function createFakeToolchain(): Promise<FakeToolchain> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hacc-audio-fixture-"));
  cleanup.push(temporaryRoot);
  const root = await realpath(temporaryRoot);
  const say = join(root, "say");
  const ffmpeg = join(root, "ffmpeg");
  const swVers = join(root, "sw_vers");
  const otool = join(root, "otool");
  const libsoxr = join(root, "libsoxr.0.1.3.dylib");
  await Promise.all([
    writeFile(say, "fake-say-binary"),
    writeFile(ffmpeg, "fake-ffmpeg-binary"),
    writeFile(swVers, "fake-sw-vers-binary"),
    writeFile(otool, "fake-otool-binary"),
    writeFile(libsoxr, "fake-libsoxr-binary"),
  ]);
  await Promise.all([say, ffmpeg, swVers, otool].map((path) => chmod(path, 0o755)));

  const calls: BenchmarkProcessRequest[] = [];
  const runner: BenchmarkProcessRunner = async (request) => {
    calls.push(Object.freeze({ ...request, args: Object.freeze([...request.args]) }));
    if (request.executable === swVers) {
      if (request.args[0] === "-productVersion") return success("26.3.1\n");
      if (request.args[0] === "-buildVersion") return success("25D2128\n");
    }
    if (request.executable === ffmpeg && request.args[0] === "-version") {
      return success("ffmpeg version 7.1.3 Copyright fake\n");
    }
    if (request.executable === ffmpeg && request.args[0] === "-buildconf") {
      return success("configuration: --enable-libsoxr --enable-audiotoolbox\n");
    }
    if (request.executable === otool) {
      return success(`${ffmpeg}:\n\t${libsoxr} (compatibility version 1.0.0, current version 1.3.0)\n`);
    }
    if (request.executable === say && request.args[0] === "-v" && request.args[1] === "?") {
      return success("Samantha             en_US    # Hello, my name is Samantha.\n");
    }
    if (request.executable === say) {
      const outputIndex = request.args.indexOf("-o") + 1;
      expect(outputIndex).toBeGreaterThan(0);
      expect(typeof request.stdin).toBe("string");
      const source = Buffer.from(`AIFF:${request.stdin as string}`, "utf8");
      await writeFile(request.args[outputIndex], source);
      return success();
    }
    if (request.executable === ffmpeg) {
      const inputPath = request.args[request.args.indexOf("-i") + 1];
      const sampleRate = Number(request.args[request.args.indexOf("-ar") + 1]);
      const outputPath = request.args.at(-1)!;
      const source = await readFile(inputPath);
      const sampleCount = sampleRate;
      const pcm = Buffer.alloc(sampleCount * 2);
      const seed = createHash("sha256").update(source).digest()[0];
      for (let index = 0; index < sampleCount; index += 1) {
        const amplitude = 1_024 + seed;
        pcm.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
      }
      await writeFile(outputPath, pcm);
      return success();
    }
    throw new Error(`Unexpected fake process: ${request.executable}`);
  };

  return Object.freeze({
    root,
    fixtureRoot: join(root, "fixture"),
    say,
    ffmpeg,
    swVers,
    otool,
    libsoxr,
    calls,
    runner,
  });
}

const scenario: CallerAudioScenarioIdentity = Object.freeze({
  id: "industrial-field-service",
  version: "1.0.0",
  canonical_sha256: sha256Hex("canonical industrial scenario"),
});

const turns: readonly CallerAudioTurn[] = Object.freeze([
  Object.freeze({ id: "identify-unit", text: "The unit is HX-204.", pause_after_ms: 250 }),
  Object.freeze({ id: "correct-reading", text: "Correction: the café reading is 81 °C, not 18 °C.", pause_after_ms: 0 }),
]);

async function prepare(fake: FakeToolchain) {
  return prepareCallerAudioFixture({
    phase: "fixture-preparation",
    rootDirectory: fake.fixtureRoot,
    scenario,
    turns,
    voice: "Samantha",
    rateWpm: 175,
    sayExecutable: fake.say,
    ffmpegExecutable: fake.ffmpeg,
    swVersExecutable: fake.swVers,
    otoolExecutable: fake.otool,
    processRunner: fake.runner,
    environment: { PATH: fake.root, OPENAI_API_KEY: "must-not-reach-local-tools" },
    now: () => "2026-07-10T12:00:00.000Z",
  });
}

describe("frozen paired caller audio", () => {
  it("prepares deterministic native-rate PCM pairs and records exact provenance", async () => {
    const fake = await createFakeToolchain();
    const manifest = await prepare(fake);

    expect(manifest.caller_sequence_sha256).toBe(hashCallerAudioSequence(turns));
    expect(manifest.toolchain).toMatchObject({
      macos: { product_version: "26.3.1", build_version: "25D2128" },
      say: {
        binary_sha256: sha256Hex("fake-say-binary"),
        version_source: "macos-bundle",
      },
      ffmpeg: {
        version: "ffmpeg version 7.1.3 Copyright fake",
        binary_sha256: sha256Hex("fake-ffmpeg-binary"),
        libsoxr_enabled: true,
        libsoxr_binary_sha256: sha256Hex("fake-libsoxr-binary"),
        libsoxr_version: "0.1.3",
      },
    });
    expect(manifest).toMatchObject({
      synthesis: {
        redistribution_status: "review-required",
        license_spdx: null,
      },
      normalization: {
        resampler: "libsoxr",
        precision_bits: 28,
        dither: "none",
        loudness_normalization: false,
        silence_trimming: false,
      },
    });
    expect(manifest.turns).toHaveLength(2);
    for (const turn of manifest.turns) {
      expect(turn.renditions.pcm16le_mono_16000).toMatchObject({
        byte_length: 32_000,
        sample_count: 16_000,
        sample_rate_hz: 16_000,
      });
      expect(turn.renditions.pcm16le_mono_24000).toMatchObject({
        byte_length: 48_000,
        sample_count: 24_000,
        sample_rate_hz: 24_000,
      });
    }

    const sayCalls = fake.calls.filter(
      (call) => call.executable === fake.say && call.args.includes("-o")
    );
    expect(sayCalls.map((call) => call.stdin)).toEqual(turns.map((turn) => turn.text));
    for (const [index, call] of sayCalls.entries()) {
      expect(call.args).not.toContain(turns[index].text);
      expect(call.args).toContain("--file-format=AIFF");
    }
    for (const call of fake.calls) {
      expect(call.environment).not.toHaveProperty("OPENAI_API_KEY");
    }
    const conversions = fake.calls.filter(
      (call) => call.executable === fake.ffmpeg && call.args[0] === "-nostdin"
    );
    expect(conversions).toHaveLength(4);
    for (const call of conversions) {
      expect(call.args).toEqual(expect.arrayContaining([
        "-bitexact",
        "-threads", "1",
        "-filter_threads", "1",
        "-map_metadata", "-1",
        "-n",
      ]));
      const filter = call.args[call.args.indexOf("-af") + 1];
      expect(filter).toContain("resampler=soxr");
      expect(filter).toContain("dither_method=none");
    }

    const verification = await verifyCallerAudioFixture({
      rootDirectory: fake.fixtureRoot,
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: manifest.manifest_sha256,
    });
    expect(verification).toMatchObject({ valid: true, errors: [] });

    const frozen = await loadFrozenCallerAudioForPaidTrial({
      rootDirectory: fake.fixtureRoot,
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: manifest.manifest_sha256,
    });
    const firstRead = frozen.readPcm("identify-unit", "pcm16le_mono_24000");
    firstRead[0] ^= 0xff;
    expect(frozen.readPcm("identify-unit", "pcm16le_mono_24000")[0]).not.toBe(firstRead[0]);
    expect(() => assertPairedCallerAudio(frozen, frozen, "pcm16le_mono_24000")).not.toThrow();
  });

  it("hashes exact caller text and order, including Unicode representation", () => {
    const reordered = [turns[1], turns[0]];
    const decomposed = [turns[0], { ...turns[1], text: turns[1].text.normalize("NFD") }];
    expect(hashCallerAudioSequence(reordered)).not.toBe(hashCallerAudioSequence(turns));
    expect(hashCallerAudioSequence(decomposed)).not.toBe(hashCallerAudioSequence(turns));
  });

  it("keeps semantic audio and fixture identities stable across storage-path renames", async () => {
    const fake = await createFakeToolchain();
    const original = await prepare(fake);
    const renamedGeneratedTurns = original.turns.map((turn, index) => ({
      caller_turn_id: turn.caller_turn_id,
      source_aiff_sha256: turn.source_aiff_sha256,
      renditions: {
        pcm16le_mono_16000: {
          ...turn.renditions.pcm16le_mono_16000,
          path: `renamed/${index}/caller-16k.pcm`,
        },
        pcm16le_mono_24000: {
          ...turn.renditions.pcm16le_mono_24000,
          path: `renamed/${index}/caller-24k.pcm`,
        },
      },
    }));
    const renamed = createCallerAudioFixtureManifest({
      generatedAt: original.generated_at,
      scenario,
      turns,
      voice: original.synthesis.voice,
      rateWpm: original.synthesis.rate_wpm,
      toolchain: original.toolchain,
      generatedTurns: renamedGeneratedTurns,
    });

    expect(renamed.audio_sequence_sha256_by_rendition)
      .toEqual(original.audio_sequence_sha256_by_rendition);
    expect(renamed.audio_set_sha256).toBe(original.audio_set_sha256);
    expect(renamed.fixture_set_id).toBe(original.fixture_set_id);
    expect(renamed.manifest_sha256).not.toBe(original.manifest_sha256);

    expect(() => createCallerAudioFixtureManifest({
      generatedAt: "2026-02-30T12:00:00.000Z",
      scenario,
      turns,
      voice: original.synthesis.voice,
      rateWpm: original.synthesis.rate_wpm,
      toolchain: original.toolchain,
      generatedTurns: renamedGeneratedTurns,
    })).toThrow(/exact valid UTC calendar timestamp/);
  });

  it("rejects silent, constant, and implausibly short PCM before it can enter a manifest", () => {
    expect(() => createCallerPcmDescriptor({
      path: "turns/0000/silent.pcm",
      bytes: new Uint8Array(16_000 * 2),
      sampleRateHz: 16_000,
    })).toThrow(/non-silence|waveform-variation/);

    const constant = Buffer.alloc(16_000 * 2);
    for (let index = 0; index < 16_000; index += 1) constant.writeInt16LE(2_000, index * 2);
    expect(() => createCallerPcmDescriptor({
      path: "turns/0000/constant.pcm",
      bytes: constant,
      sampleRateHz: 16_000,
    })).toThrow(/waveform-variation/);

    const short = Buffer.alloc(100 * 2);
    for (let index = 0; index < 100; index += 1) short.writeInt16LE(index % 2 ? -2_000 : 2_000, index * 2);
    expect(() => createCallerPcmDescriptor({
      path: "turns/0000/short.pcm",
      bytes: short,
      sampleRateHz: 16_000,
    })).toThrow(/250 ms/);
  });

  it("rejects sparse impulses and word-rate truncation while preserving natural pauses", async () => {
    const sparseImpulses = Buffer.alloc(16_000 * 3 * 2);
    for (let index = 0; index < 128; index += 1) {
      sparseImpulses.writeInt16LE(index % 2 === 0 ? 32_700 : -32_700, index * 2);
    }
    expect(() => createCallerPcmDescriptor({
      path: "turns/0000/sparse-impulses.pcm",
      bytes: sparseImpulses,
      sampleRateHz: 16_000,
    })).toThrow(/frame-coverage|impulse-density/);

    const withNaturalPause = Buffer.alloc(16_000 * 10 * 2);
    for (let index = 0; index < 16_000 * 10; index += 1) {
      const inPause = index >= 16_000 * 3 && index < 16_000 * 7;
      withNaturalPause.writeInt16LE(inPause ? 0 : index % 2 === 0 ? 1_200 : -1_200, index * 2);
    }
    expect(() => createCallerPcmDescriptor({
      path: "turns/0000/natural-pause.pcm",
      bytes: withNaturalPause,
      sampleRateHz: 16_000,
    })).not.toThrow();

    const fake = await createFakeToolchain();
    const provenance = await prepare(fake);
    const fortyWords = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const continuousPcm = (sampleRateHz: 16_000 | 24_000): Buffer => {
      const pcm = Buffer.alloc(sampleRateHz * 3 * 2);
      for (let index = 0; index < sampleRateHz * 3; index += 1) {
        pcm.writeInt16LE(index % 2 === 0 ? 1_200 : -1_200, index * 2);
      }
      return pcm;
    };
    expect(() => createCallerAudioFixtureManifest({
      generatedAt: "2026-07-10T12:00:00.000Z",
      scenario,
      turns: [{ id: "forty-words", text: fortyWords }],
      voice: "Samantha",
      rateWpm: 175,
      toolchain: provenance.toolchain,
      generatedTurns: [{
        caller_turn_id: "forty-words",
        source_aiff_sha256: sha256Hex("truncated source"),
        renditions: {
          pcm16le_mono_16000: createCallerPcmDescriptor({
            path: "turns/0000/truncated-16k.pcm",
            bytes: continuousPcm(16_000),
            sampleRateHz: 16_000,
          }),
          pcm16le_mono_24000: createCallerPcmDescriptor({
            path: "turns/0000/truncated-24k.pcm",
            bytes: continuousPcm(24_000),
            sampleRateHz: 24_000,
          }),
        },
      }],
    })).toThrow(/implausibly short/);
  });

  it("rejects tampered PCM and symlink substitution before returning trial bytes", async () => {
    const fake = await createFakeToolchain();
    const manifest = await prepare(fake);
    const descriptor = manifest.turns[0].renditions.pcm16le_mono_16000;
    const pcmPath = join(fake.fixtureRoot, ...descriptor.path.split("/"));
    const original = await readFile(pcmPath);
    const tampered = Buffer.from(original);
    tampered[0] ^= 0xff;
    await writeFile(pcmPath, tampered);

    await expect(loadFrozenCallerAudioForPaidTrial({
      rootDirectory: fake.fixtureRoot,
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: manifest.manifest_sha256,
    })).rejects.toThrow(/sha256 mismatch/);

    await writeFile(pcmPath, original);
    const symlinkTarget = join(fake.fixtureRoot, "same-bytes.pcm");
    await writeFile(symlinkTarget, original);
    await unlink(pcmPath);
    await symlink(symlinkTarget, pcmPath);
    await expect(loadFrozenCallerAudioForPaidTrial({
      rootDirectory: fake.fixtureRoot,
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: manifest.manifest_sha256,
    })).rejects.toThrow(/symbolic link|regular file/);
  });

  it("rejects unknown manifest fields and a non-preregistered manifest hash", async () => {
    const fake = await createFakeToolchain();
    const manifest = await prepare(fake);
    await expect(loadFrozenCallerAudioForPaidTrial({
      rootDirectory: fake.fixtureRoot,
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: "0".repeat(64),
    })).rejects.toThrow(/preregistered fixture hash/);

    const manifestPath = join(fake.fixtureRoot, "fixture-manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${canonicalJson({ ...parsed, unexpected: true })}\n`);
    const verification = await verifyCallerAudioFixture({
      rootDirectory: fake.fixtureRoot,
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: manifest.manifest_sha256,
    });
    expect(verification.valid).toBe(false);
    expect(verification.manifest).toBeNull();
    expect(verification.errors).toContain("fixture manifest does not match schema version 1");
  });

  it("does not read any PCM after manifest/preregistration semantics fail", async () => {
    const fake = await createFakeToolchain();
    await prepare(fake);
    const reads: string[] = [];
    const verification = await verifyCallerAudioFixture({
      rootDirectory: fake.fixtureRoot,
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: "0".repeat(64),
      readFrozenFile: async (root, relativePath) => {
        reads.push(relativePath);
        return readFile(join(root, ...relativePath.split("/")));
      },
    });
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain("manifest_sha256 does not match the preregistered fixture hash");
    expect(reads).toEqual(["fixture-manifest.json"]);
  });

  it("rejects runtime reader injection in paid mode and redacts missing local paths", async () => {
    const injectedReads: string[] = [];
    await expect(loadFrozenCallerAudioForPaidTrial({
      rootDirectory: "/does/not/exist",
      expectedScenario: scenario,
      expectedTurns: turns,
      expectedManifestSha256: "0".repeat(64),
      readFrozenFile: async (_root: string, path: string) => {
        injectedReads.push(path);
        return new Uint8Array();
      },
    } as never)).rejects.toThrow(/cannot override/);
    expect(injectedReads).toEqual([]);

    const sentinel = "/tmp/private-account-ACME-SENTINEL/missing";
    let message = "";
    try {
      await loadFrozenCallerAudioForPaidTrial({
        rootDirectory: sentinel,
        expectedScenario: scenario,
        expectedTurns: turns,
        expectedManifestSha256: "0".repeat(64),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("missing, unreadable, or unsafe");
    expect(message).not.toContain("ACME-SENTINEL");
    expect(message).not.toContain(sentinel);

    let lowLevelMessage = "";
    try {
      await readFrozenFixtureFileNoFollow(sentinel, "turns/0000/caller.pcm");
    } catch (error) {
      lowLevelMessage = error instanceof Error ? error.message : String(error);
    }
    expect(lowLevelMessage).toBe("frozen fixture file is missing, unreadable, or unsafe");
    expect(lowLevelMessage).not.toContain("ACME-SENTINEL");
  });

  it("times out a hung preparation process even when an injected runner ignores abort", async () => {
    const fake = await createFakeToolchain();
    const hungRunner: BenchmarkProcessRunner = async () => new Promise(() => undefined);
    await expect(prepareCallerAudioFixture({
      phase: "fixture-preparation",
      rootDirectory: fake.fixtureRoot,
      scenario,
      turns,
      voice: "Samantha",
      sayExecutable: fake.say,
      ffmpegExecutable: fake.ffmpeg,
      swVersExecutable: fake.swVers,
      otoolExecutable: fake.otool,
      processRunner: hungRunner,
      environment: { PATH: fake.root },
      commandTimeoutMs: 10,
    })).rejects.toThrow(/timed out/);
    await expect(readFile(join(fake.fixtureRoot, ".fixture-preparation.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a toolchain binary swap after synthesis and before publication", async () => {
    const fake = await createFakeToolchain();
    let swapped = false;
    const swappingRunner: BenchmarkProcessRunner = async (request) => {
      const result = await fake.runner(request);
      if (!swapped && request.executable === fake.ffmpeg && request.args[0] === "-nostdin") {
        swapped = true;
        await writeFile(fake.ffmpeg, "replacement-ffmpeg-binary");
      }
      return result;
    };

    await expect(prepareCallerAudioFixture({
      phase: "fixture-preparation",
      rootDirectory: fake.fixtureRoot,
      scenario,
      turns,
      voice: "Samantha",
      rateWpm: 175,
      sayExecutable: fake.say,
      ffmpegExecutable: fake.ffmpeg,
      swVersExecutable: fake.swVers,
      otoolExecutable: fake.otool,
      processRunner: swappingRunner,
      environment: { PATH: fake.root },
      now: () => "2026-07-10T12:00:00.000Z",
    })).rejects.toThrow("Audio fixture toolchain changed during synthesis");
    expect(swapped).toBe(true);
    await expect(readFile(join(fake.fixtureRoot, "fixture-manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(fake.fixtureRoot, "turns"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove or bypass another preparation process's exclusive lock", async () => {
    const fake = await createFakeToolchain();
    await mkdir(fake.fixtureRoot, { recursive: true });
    const lockPath = join(fake.fixtureRoot, ".fixture-preparation.lock");
    await writeFile(lockPath, "active-owner\n", { flag: "wx" });
    await expect(prepare(fake)).rejects.toThrow(/already active|requires recovery/);
    expect(await readFile(lockPath, "utf8")).toBe("active-owner\n");
    expect(fake.calls).toHaveLength(0);
  });

  it("has no paid-trial synthesis path and refuses to overwrite a frozen fixture", async () => {
    const fake = await createFakeToolchain();
    await expect(prepareCallerAudioFixture({
      phase: "paid-trial" as "fixture-preparation",
      rootDirectory: fake.fixtureRoot,
      scenario,
      turns,
      voice: "Samantha",
      processRunner: fake.runner,
    })).rejects.toThrow(/never a paid trial/);
    expect(fake.calls).toHaveLength(0);

    await prepare(fake);
    const callCount = fake.calls.length;
    await expect(prepare(fake)).rejects.toThrow(/refusing to overwrite/);
    expect(fake.calls).toHaveLength(callCount);
  });
});
