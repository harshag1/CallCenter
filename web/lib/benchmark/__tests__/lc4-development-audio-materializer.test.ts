import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEV_PINNED_VOICE,
  assertLc4DevAudioArtifacts,
  createLc4DevCallerBranchAudioAccessor,
  createLc4DevCallerAudioLoader,
  createPinnedMacOsLc4DevAudioRenderer,
  materializeLc4DevelopmentAudio,
  type Lc4DevAudioManifest,
  type Lc4DevAudioRenderer,
  type Lc4DevRepairAudioManifest,
} from "../lc4-development-audio-materializer";
import {
  LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256,
  LC4_DEV_PRIOR_MUTATION_OUTCOMES,
  createLc4DevCallerBranchMatrixArtifact,
} from "../lc4-development-caller-branch";
import {
  LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
  LC4_DEV_AUDIO_EXECUTION_CONTRACT_SHA256,
  LC4_DEV_AUDIO_PACKETIZER_CONTRACT_SHA256,
} from "../lc4-development-audio-contract";
const roots: string[] = [];

function pcm(sampleRate: 16_000 | 24_000 | 48_000, seed: number): Uint8Array {
  const samples = Math.floor(sampleRate * 0.12);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin((index + seed) / 9) * 8_000);
    view.setInt16(index * 2, sample, true);
  }
  return bytes;
}

function renderer(mode: "valid" | "silent" | "clipped" = "valid"): Lc4DevAudioRenderer {
  return Object.freeze({
    identity: Object.freeze({
      renderer: "injected-test-renderer",
      identity_sha256: "a".repeat(64),
      toolchain: null,
      voice: LC4_DEV_PINNED_VOICE,
      normalization: "ffmpeg-loudnorm-I-20-LRA-7-TP-3",
    }),
    assertReady: () => undefined,
    assertUnchanged: () => undefined,
    async render({ sourceTextSha256 }) {
      const seed = Number.parseInt(sourceTextSha256.slice(0, 4), 16);
      const create = (rate: 16_000 | 24_000 | 48_000) => {
        const bytes = pcm(rate, seed);
        if (mode === "silent") bytes.fill(0);
        if (mode === "clipped") {
          const view = new DataView(bytes.buffer);
          for (let index = 0; index < bytes.byteLength / 2; index += 1) view.setInt16(index * 2, 32_767, true);
        }
        return bytes;
      };
      return Object.freeze({ master48k: create(48_000), pcm16k: create(16_000), pcm24k: create(24_000) });
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LC4-DEV audio materializer", () => {
  it("publishes exact immutable masters plus canonical, closed-loop branch, and repair bindings", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-audio-"));
    roots.push(parent);
    const outputRoot = join(parent, "published");
    const result = await materializeLc4DevelopmentAudio({ outputRoot, renderer: renderer() });
    expect(() => assertLc4DevAudioArtifacts(result)).not.toThrow();
    expect(result.manifest).toMatchObject({
      schema_version: 2,
      audio_delivery_profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
      audio_packetizer_contract_sha256: LC4_DEV_AUDIO_PACKETIZER_CONTRACT_SHA256,
      audio_execution_contract_sha256: LC4_DEV_AUDIO_EXECUTION_CONTRACT_SHA256,
    });
    expect(result.manifest.canonical_sources).toHaveLength(60);
    expect(result.manifest.caller_audio_bindings).toHaveLength(180);
    expect(result.manifest.branch_sources).toHaveLength(4);
    expect(result.manifest.caller_branch_audio_bindings).toHaveLength(15);
    expect(result.manifest.branch_source_matrix_sha256).toBe(LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256);
    expect(result.repairManifest.repair_sources).toHaveLength(24);
    expect(result.repairManifest.repair_audio_bindings).toHaveLength(72);
    expect(result.manifest.canonical_sources.every((source) => source.master_48khz.sample_rate_hz === 48_000)).toBe(true);
    expect(result.manifest.caller_audio_bindings.slice(0, 60).every((binding) => binding.provider === "openai" && binding.sample_rate_hz === 24_000)).toBe(true);
    expect(result.manifest.caller_audio_bindings.slice(60, 120).every((binding) => binding.provider === "gemini" && binding.sample_rate_hz === 16_000)).toBe(true);
    expect(result.manifest.caller_audio_bindings.slice(120).every((binding) => binding.provider === "xai" && binding.sample_rate_hz === 24_000)).toBe(true);
    expect(result.manifest.canonical_sources.every((source) => source.provider_renditions.openai.sha256 === source.provider_renditions.xai.sha256)).toBe(true);
    const op42 = result.manifest.canonical_sources.find((source) => source.opportunity_id === "lc4-dev-op-42")!;
    for (const provider of ["openai", "gemini", "xai"] as const) {
      const providerBindings = result.manifest.caller_branch_audio_bindings.filter((binding) => binding.provider === provider);
      expect(providerBindings.map((binding) => binding.prior_outcome)).toEqual(LC4_DEV_PRIOR_MUTATION_OUTCOMES);
      expect(providerBindings.find((binding) => binding.prior_outcome === "committed_after_error")?.pcm_sha256)
        .toBe(op42.provider_renditions[provider].sha256);
      expect(new Set(providerBindings.filter((binding) => binding.prior_outcome !== "committed_after_error")
        .map((binding) => binding.source_text_sha256))).toHaveLength(4);
    }
    const accessor = createLc4DevCallerBranchAudioAccessor({ manifest: result.manifest });
    expect(accessor.audio_manifest_sha256).toBe(result.manifest.manifest_sha256);
    expect(accessor.source_matrix_sha256).toBe(LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256);
    expect(accessor.binding("gemini", "settled_success")).toMatchObject({ sample_rate_hz: 16_000 });
    const keys = generateKeyPairSync("ed25519");
    const signingIdentity = {
      key_id: "lc4-dev-real-audio-matrix-test",
      private_key_pem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    expect(() => createLc4DevCallerBranchMatrixArtifact({
      audio_manifest_sha256: accessor.audio_manifest_sha256,
      audio_bindings: result.manifest.caller_branch_audio_bindings,
      signing_identity: signingIdentity,
    })).not.toThrow();
    expect(result.prepareFragment.audio_manifest_sha256).toBe(result.manifest.manifest_sha256);
    expect(result.prepareFragment.audio_bindings).toEqual(result.manifest.caller_audio_bindings);
    const serialized = await readFile(join(outputRoot, "manifest.json"), "utf8");
    expect(serialized).not.toContain("municipal oral-history recording");
    expect(serialized).not.toContain("MPL-1402");
    await expect(materializeLc4DevelopmentAudio({ outputRoot, renderer: renderer() })).rejects.toThrow("refusing overwrite");
  }, 30_000);

  it("loads only manifest-bound content-addressed PCM and detects corruption", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-loader-"));
    roots.push(parent);
    const outputRoot = join(parent, "published");
    const result = await materializeLc4DevelopmentAudio({ outputRoot, renderer: renderer() });
    const binding = result.manifest.caller_audio_bindings[0]!;
    const loader = createLc4DevCallerAudioLoader({ outputRoot, manifest: result.manifest });
    const bytes = await loader.load(binding);
    expect(sha256Hex(bytes)).toBe(binding.pcm_sha256);
    for (const branchBinding of result.manifest.caller_branch_audio_bindings) {
      const branchBytes = await loader.loadBranch(branchBinding);
      expect(sha256Hex(branchBytes)).toBe(branchBinding.pcm_sha256);
    }
    const branch = result.manifest.caller_branch_audio_bindings.find((candidate) => candidate.prior_outcome === "no_call")!;
    await expect(loader.loadBranch({ ...branch, pcm_sha256: "b".repeat(64) })).rejects.toThrow("uncommitted branch binding");
    await expect(loader.load({ ...binding, pcm_sha256: "b".repeat(64) })).rejects.toThrow("uncommitted binding");
    const source = result.manifest.canonical_sources[0]!;
    const pcmPath = join(outputRoot, source.provider_renditions.openai.path);
    await chmod(pcmPath, 0o600);
    await writeFile(pcmPath, Buffer.from([1, 2, 3, 4]));
    await expect(loader.load(binding)).rejects.toThrow("PCM corruption");
  }, 30_000);

  it("rejects silent and clipping-heavy renditions before publishing", async () => {
    for (const mode of ["silent", "clipped"] as const) {
      const parent = await mkdtemp(join(tmpdir(), `hacc-lc4-dev-${mode}-`));
      roots.push(parent);
      const outputRoot = join(parent, "failed");
      await expect(materializeLc4DevelopmentAudio({ outputRoot, renderer: renderer(mode) })).rejects.toThrow(mode === "silent" ? "signal floor" : "clipping limit");
      await expect(readFile(join(outputRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects manifest mutation and mismatched executable hashes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-hash-"));
    roots.push(parent);
    const outputRoot = join(parent, "published");
    const result = await materializeLc4DevelopmentAudio({ outputRoot, renderer: renderer() });
    const mutated = JSON.parse(canonicalJson(result.manifest));
    mutated.counts.logical_caller_bindings = 179;
    expect(() => assertLc4DevAudioArtifacts({ manifest: mutated, repairManifest: result.repairManifest })).toThrow("manifest hash mismatch");
    await expect(createPinnedMacOsLc4DevAudioRenderer({
      say_path: "/usr/bin/say",
      say_sha256: "0".repeat(64),
      ffmpeg_path: "/usr/bin/false",
      ffmpeg_sha256: "0".repeat(64),
    })).rejects.toThrow("macOS say executable hash mismatch");
  }, 30_000);

  it("rejects internally rehashed stale provider, delivery, packetizer, and rendition commitments", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-stale-contract-"));
    roots.push(parent);
    const result = await materializeLc4DevelopmentAudio({ outputRoot: join(parent, "published"), renderer: renderer() });
    type MutableManifest = {
      manifest_sha256: string;
      repair_manifest_sha256: string;
      provider_profile_manifest_sha256: string;
      audio_delivery_profile_sha256: string;
      audio_packetizer_contract_sha256: string;
      canonical_sources: Array<{ provider_renditions: { openai: { provider_profile_sha256: string } } }>;
      [key: string]: unknown;
    };
    type MutableRepairs = {
      repair_manifest_sha256: string;
      provider_profile_manifest_sha256: string;
      audio_delivery_profile_sha256: string;
      audio_packetizer_contract_sha256: string;
      [key: string]: unknown;
    };
    const mutateAndRehash = (mutate: (manifest: MutableManifest, repairs: MutableRepairs) => void) => {
      const manifest = JSON.parse(canonicalJson(result.manifest)) as MutableManifest;
      const repairs = JSON.parse(canonicalJson(result.repairManifest)) as MutableRepairs;
      mutate(manifest, repairs);
      const manifestBody = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifest_sha256"));
      manifest.manifest_sha256 = sha256Hex(`harshas-amazing-call-center/lc4-dev-audio-manifest/v2\n${canonicalJson(manifestBody)}`);
      const repairBody = Object.fromEntries(Object.entries(repairs).filter(([key]) => key !== "repair_manifest_sha256"));
      repairs.repair_manifest_sha256 = sha256Hex(`harshas-amazing-call-center/lc4-dev-repair-audio-manifest/v2\n${canonicalJson(repairBody)}`);
      // Keep the root-to-repair link valid so the targeted current-contract
      // check, rather than a generic hash error, is what rejects the artifact.
      manifest.repair_manifest_sha256 = repairs.repair_manifest_sha256;
      const linkedBody = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifest_sha256"));
      manifest.manifest_sha256 = sha256Hex(`harshas-amazing-call-center/lc4-dev-audio-manifest/v2\n${canonicalJson(linkedBody)}`);
      return {
        manifest: manifest as unknown as Lc4DevAudioManifest,
        repairManifest: repairs as unknown as Lc4DevRepairAudioManifest,
      };
    };
    expect(() => assertLc4DevAudioArtifacts(mutateAndRehash((manifest, repairs) => {
      manifest.provider_profile_manifest_sha256 = "0".repeat(64);
      repairs.provider_profile_manifest_sha256 = "0".repeat(64);
    }))).toThrow("stale provider_profile_manifest_sha256");
    expect(() => assertLc4DevAudioArtifacts(mutateAndRehash((manifest, repairs) => {
      manifest.audio_delivery_profile_sha256 = "1".repeat(64);
      repairs.audio_delivery_profile_sha256 = "1".repeat(64);
    }))).toThrow("stale audio_delivery_profile_sha256");
    expect(() => assertLc4DevAudioArtifacts(mutateAndRehash((manifest, repairs) => {
      manifest.audio_packetizer_contract_sha256 = "2".repeat(64);
      repairs.audio_packetizer_contract_sha256 = "2".repeat(64);
    }))).toThrow("stale audio_packetizer_contract_sha256");
    expect(() => assertLc4DevAudioArtifacts(mutateAndRehash((manifest) => {
      manifest.canonical_sources[0].provider_renditions.openai.provider_profile_sha256 = "3".repeat(64);
    }))).toThrow("caller binding differs");
  }, 30_000);
});
