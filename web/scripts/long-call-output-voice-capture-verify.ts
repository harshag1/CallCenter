#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  createOutputVoiceCalibrationManifest,
  createOutputVoiceCaptureVerificationReceipt,
  validateOutputVoiceCalibrationFixtures,
  verifyOutputVoiceCalibrationPcm,
  type OutputVoiceCalibrationManifest,
} from "../lib/benchmark/long-call-asr-calibration";

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function absoluteFlag(name: string): string {
  const value = flag(name);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${name} must be an absolute normalized path`);
  return value;
}

function fixturePath(root: string, path: string): string {
  if (!SAFE_PATH.test(path)
    || !path.startsWith("output-voice-calibration/")
    || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`unsafe output-voice fixture path ${path}`);
  }
  const resolved = resolve(root, path);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`output-voice fixture escapes root: ${path}`);
  return resolved;
}

async function main(): Promise<void> {
  const manifestPath = absoluteFlag("--manifest");
  const root = absoluteFlag("--root");
  const outputPath = absoluteFlag("--output");
  const expectedCaptureAuthoritySha256 = flag("--expected-capture-authority-sha256");
  if (!/^[a-f0-9]{64}$/u.test(expectedCaptureAuthoritySha256)) {
    throw new Error("--expected-capture-authority-sha256 must be one lowercase SHA-256");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OutputVoiceCalibrationManifest;
  const canonical = createOutputVoiceCalibrationManifest(manifest.fixtures);
  if (canonicalJson(canonical) !== canonicalJson(manifest)) {
    throw new Error("output-voice calibration manifest is noncanonical or has a version/hash mismatch");
  }
  if (manifest.captureAuthority.publicKeySha256 !== expectedCaptureAuthoritySha256) {
    throw new Error("manifest capture authority differs from the preregistered trust root");
  }
  const fixtures = validateOutputVoiceCalibrationFixtures({
    fixtures: manifest.fixtures,
    manifestSha256: manifest.manifestSha256,
  });
  const verifiedFixtures = [];
  for (const fixture of fixtures) {
    const pcm = new Uint8Array(await readFile(fixturePath(root, fixture.path)));
    verifyOutputVoiceCalibrationPcm({ fixture, pcm, expectedCaptureAuthoritySha256 });
    verifiedFixtures.push(Object.freeze({
      calibrationUnitId: fixture.calibrationUnitId,
      provider: fixture.provider,
      model: fixture.model,
      voice: fixture.voice,
      pcmSha256: fixture.sha256,
      captureReceiptSha256: fixture.captureReceipt.receiptSha256,
      outputChunkSequenceSha256: fixture.captureReceipt.wireCapture.outputChunkSequenceSha256,
    }));
  }
  const implementationPath = fileURLToPath(import.meta.url);
  const receipt = createOutputVoiceCaptureVerificationReceipt({
    manifest,
    expectedCaptureAuthoritySha256,
    verificationImplementationSha256: sha256Hex(await readFile(implementationPath)),
  });
  if (canonicalJson(receipt.verifiedFixtures) !== canonicalJson(verifiedFixtures)) {
    throw new Error("capture verifier fixture inventory differs from the canonical manifest");
  }
  await writeFile(outputPath, `${canonicalJson(receipt)}\n`, { flag: "wx", mode: 0o400 });
  process.stdout.write(`${canonicalJson({
    output: outputPath,
    manifestSha256: manifest.manifestSha256,
    captureAuthoritySha256: expectedCaptureAuthoritySha256,
    verifiedFixtures: verifiedFixtures.length,
    verificationSha256: receipt.verificationSha256,
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "output-voice capture verification failed"}\n`);
  process.exitCode = 1;
});
