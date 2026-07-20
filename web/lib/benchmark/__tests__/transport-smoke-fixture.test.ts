import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFixtureOutputSecurely,
  writeFixtureOutputAtomically,
} from "../../../../benchmarks/voice-long-horizon/fixtures/transport-smoke-v1/generate";
import {
  CALLER_AUDIO_MANIFEST_FILE,
  deterministicTransportSmokeSynthesis,
  loadFrozenCallerAudioForPaidTrial,
  renderDeterministicTransportSignalPcm,
  verifyCallerAudioFixture,
} from "../audio-fixtures";
import { sha256Hex } from "../artifacts";
import { resolveScenarioSource } from "../scenario-source-registry";
import { TRANSPORT_SMOKE_SCENARIO } from "../transport-smoke-scenario";

const FIXTURE_ROOT = resolve(
  process.cwd(),
  "../benchmarks/voice-long-horizon/fixtures/transport-smoke-v1"
);
const EXPECTED_MANIFEST_SHA256 =
  "1397896bb7e894a3965f6683b2a039da14500749b4f5828d86b0997f9ea0099c";
const RETIRED_UNBACKED_MANIFEST_SHA256 =
  "eb0eb24f8cb0ee95aedaa10988f6889252e041c513e65e94dc0d5b936b014a49";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

const expectedScenario = Object.freeze({
  id: TRANSPORT_SMOKE_SCENARIO.id,
  version: TRANSPORT_SMOKE_SCENARIO.version,
  canonical_sha256:
    "6a1201c96724ffcb347b11482d898f3b01bd3b50a43e9734ecb5447fea2e4d56",
});
const expectedTurns = Object.freeze(
  TRANSPORT_SMOKE_SCENARIO.caller.turns.map((turn) =>
    Object.freeze({ id: turn.id, text: turn.utterance, pause_after_ms: 0 })
  )
);

describe("redistributable C3 transport-smoke fixture", () => {
  it("atomically replaces only single-link regular outputs without following links", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "hacc-transport-fixture-writer-"))
    );
    temporaryDirectories.push(directory);
    const victim = join(directory, "victim.bin");
    const symlinkOutput = "fixture-manifest.json";
    await writeFile(victim, "victim-bytes", "utf8");
    await symlink(victim, join(directory, symlinkOutput));

    await expect(writeFixtureOutputAtomically(
      directory,
      symlinkOutput,
      Buffer.from("replacement", "utf8")
    )).rejects.toThrow(/not a safe regular file/);
    await expect(readFixtureOutputSecurely(directory, symlinkOutput))
      .rejects.toThrow(/not a safe regular file/);
    expect(await readFile(victim, "utf8")).toBe("victim-bytes");

    const hardLinkOutput = "freeze-input.json";
    const hardLinkSibling = join(directory, "hard-link-sibling.json");
    await writeFile(join(directory, hardLinkOutput), "shared-bytes", "utf8");
    await link(join(directory, hardLinkOutput), hardLinkSibling);
    await expect(writeFixtureOutputAtomically(
      directory,
      hardLinkOutput,
      Buffer.from("replacement", "utf8")
    )).rejects.toThrow(/multiple hard links/);
    await expect(readFixtureOutputSecurely(directory, hardLinkOutput))
      .rejects.toThrow(/multiple hard links/);
    expect(await readFile(hardLinkSibling, "utf8")).toBe("shared-bytes");

    const regularOutput = "turn_01.pcm";
    await writeFile(join(directory, regularOutput), "old-bytes", "utf8");
    await writeFixtureOutputAtomically(
      directory,
      regularOutput,
      Buffer.from("deterministic-new-bytes", "utf8")
    );
    expect(Buffer.from(
      (await readFixtureOutputSecurely(directory, regularOutput))!
    ).toString("utf8")).toBe("deterministic-new-bytes");
    const installed = await lstat(join(directory, regularOutput));
    expect(installed.isFile()).toBe(true);
    expect(installed.isSymbolicLink()).toBe(false);
    expect(installed.nlink).toBe(1);
    expect(installed.mode & 0o777).toBe(0o644);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);

    await expect(writeFixtureOutputAtomically(
      directory,
      "../escape.pcm",
      Buffer.from("unsafe", "utf8")
    )).rejects.toThrow(/name is unsafe/);

    const victimDirectory = join(directory, "victim-directory");
    const aliasDirectory = join(directory, "fixture-directory-alias");
    await mkdir(victimDirectory);
    await writeFile(
      join(victimDirectory, "fixture-manifest.json"),
      "victim-directory-bytes",
      "utf8"
    );
    await symlink(victimDirectory, aliasDirectory);
    await expect(writeFixtureOutputAtomically(
      aliasDirectory,
      "fixture-manifest.json",
      Buffer.from("REPLACED", "utf8")
    )).rejects.toThrow(/output directory.*safe regular directory/);
    await expect(readFixtureOutputSecurely(
      aliasDirectory,
      "fixture-manifest.json"
    )).rejects.toThrow(/output directory.*safe regular directory/);
    expect(
      await readFile(join(victimDirectory, "fixture-manifest.json"), "utf8")
    ).toBe("victim-directory-bytes");
    expect(await readdir(victimDirectory)).toEqual(["fixture-manifest.json"]);
  });

  it("securely loads exact native-rate true-audio bytes under the freeze input hash", async () => {
    const verification = await verifyCallerAudioFixture({
      rootDirectory: FIXTURE_ROOT,
      expectedScenario,
      expectedTurns,
      expectedManifestSha256: EXPECTED_MANIFEST_SHA256,
    });

    expect(verification).toMatchObject({ valid: true, errors: [] });
    expect(verification.manifest).toMatchObject({
      schema_version: 2,
      fixture_set_id: "caf_7b5666b42f238794a8bd98fb",
      manifest_sha256: EXPECTED_MANIFEST_SHA256,
      caller_sequence_sha256:
        "09d52a54f1a83f6907e06cbe980e4da7bb39691983d08fb31495a6728d853ece",
      synthesis: {
        semantic_content: "non-speech-transport-calibration",
        redistribution_status: "redistributable",
        license_spdx: "MIT",
      },
    });

    const fixture = await loadFrozenCallerAudioForPaidTrial({
      rootDirectory: FIXTURE_ROOT,
      expectedScenario,
      expectedTurns,
      expectedManifestSha256: EXPECTED_MANIFEST_SHA256,
    });
    const pcm16 = fixture.readPcm("turn_01", "pcm16le_mono_16000");
    const pcm24 = fixture.readPcm("turn_01", "pcm16le_mono_24000");
    expect(pcm16.byteLength).toBe(76_800);
    expect(pcm24.byteLength).toBe(115_200);
    expect(pcm16.byteLength / 2 / 16_000).toBe(2.4);
    expect(pcm24.byteLength / 2 / 24_000).toBe(2.4);
    const synthesis = deterministicTransportSmokeSynthesis();
    expect(Buffer.from(pcm16).equals(Buffer.from(
      renderDeterministicTransportSignalPcm(synthesis, 16_000)
    ))).toBe(true);
    expect(Buffer.from(pcm24).equals(Buffer.from(
      renderDeterministicTransportSignalPcm(synthesis, 24_000)
    ))).toBe(true);
    const substitutedFrequency = {
      ...synthesis,
      sequence: [
        synthesis.sequence[0],
        synthesis.sequence[1],
        { ...synthesis.sequence[2], frequency_hz: 800 },
      ],
    } as typeof synthesis;
    expect(Buffer.from(pcm16).equals(Buffer.from(
      renderDeterministicTransportSignalPcm(substitutedFrequency, 16_000)
    ))).toBe(false);
    expect(fixture.manifest.turns[0].renditions.pcm16le_mono_16000.signal)
      .toMatchObject({ clipped_sample_count: 0, large_step_sample_count: 0 });
  });

  it("rejects the retired unbacked freeze hash and generator provenance tampering", async () => {
    const retired = await verifyCallerAudioFixture({
      rootDirectory: FIXTURE_ROOT,
      expectedScenario,
      expectedTurns,
      expectedManifestSha256: RETIRED_UNBACKED_MANIFEST_SHA256,
    });
    expect(retired.valid).toBe(false);
    expect(retired.errors).toContain(
      "manifest_sha256 does not match the preregistered fixture hash"
    );

    const tamperedGenerator = await verifyCallerAudioFixture({
      rootDirectory: FIXTURE_ROOT,
      expectedScenario,
      expectedTurns,
      expectedManifestSha256: EXPECTED_MANIFEST_SHA256,
      readFrozenFile: async (root, relativePath) => {
        const bytes = await readFile(resolve(root, relativePath));
        return relativePath === "generate.ts"
          ? Buffer.concat([bytes, Buffer.from("\n// tampered\n")])
          : bytes;
      },
    });
    expect(tamperedGenerator.valid).toBe(false);
    expect(tamperedGenerator.errors).toContain(
      "deterministic fixture generator sha256 mismatch"
    );
  });

  it("keeps the manifest canonical and its checked freeze input machine-readable", async () => {
    const manifestBytes = await readFile(resolve(FIXTURE_ROOT, CALLER_AUDIO_MANIFEST_FILE));
    expect(manifestBytes.at(-1)).toBe(0x0a);
    const freezeInput = JSON.parse(
      await readFile(resolve(FIXTURE_ROOT, "freeze-input.json"), "utf8")
    ) as Record<string, unknown>;
    expect(freezeInput).toMatchObject({
      purpose: "c3-transport-compatibility-only",
      fixture_manifest_sha256: EXPECTED_MANIFEST_SHA256,
      duration_ms: 2_400,
      total_pcm_bytes: 192_000,
      semantic_scope: "non-speech-transport-calibration",
      license_spdx: "MIT",
    });
  });

  it("binds the exact registered transport scenario and every paid-loader fixture file into the freeze bundle input", async () => {
    const freezeInput = JSON.parse(
      await readFile(resolve(FIXTURE_ROOT, "freeze-input.json"), "utf8")
    ) as {
      scenario_registry_key: string;
      required_freeze_bundle: Array<{ path: string; sha256: string }>;
    };
    const registered = resolveScenarioSource(structuredClone(TRANSPORT_SMOKE_SCENARIO));
    expect(freezeInput.scenario_registry_key).toBe(registered.registryKey);

    const requiredPaths = freezeInput.required_freeze_bundle.map((entry) => entry.path);
    expect(requiredPaths).toEqual([
      "benchmarks/voice-long-horizon/scenarios/transport-smoke-v1.json",
      "web/lib/benchmark/audio-fixtures.ts",
      "benchmarks/voice-long-horizon/fixtures/transport-smoke-v1/generate.ts",
      "benchmarks/voice-long-horizon/fixtures/transport-smoke-v1/fixture-manifest.json",
      "benchmarks/voice-long-horizon/fixtures/transport-smoke-v1/turn_01.pcm16le-mono-16000.pcm",
      "benchmarks/voice-long-horizon/fixtures/transport-smoke-v1/turn_01.pcm16le-mono-24000.pcm",
    ]);
    const repositoryRoot = resolve(FIXTURE_ROOT, "../../../..");
    for (const descriptor of freezeInput.required_freeze_bundle) {
      expect(sha256Hex(await readFile(resolve(repositoryRoot, descriptor.path))))
        .toBe(descriptor.sha256);
    }
  });
});
