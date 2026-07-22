import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import { loadLc4DevXaiServerVadGateBBinding } from "../lc4-development-qualification-v3";
import type { Lc4XaiServerVadGateBBindingArtifact } from "../lc4-qualification-v3-runner";

const DOMAIN = "harshas-amazing-call-center/xai-server-vad-gate-b-binding/v1\n";
const roots: string[] = [];

function artifact(label = "original"): Lc4XaiServerVadGateBBindingArtifact {
  const body = {
    schema_version: 1 as const,
    provider: "xai" as const,
    model: "grok-voice-think-fast-1.0",
    source_commit: sha256Hex(`commit:${label}`).slice(0, 40),
    plan_sha256: sha256Hex(`plan:${label}`),
    provider_profile_manifest_sha256: sha256Hex(`profile:${label}`),
    gate_a_risk_sha256: sha256Hex(`risk:${label}`),
    production_session_payload_sha256: sha256Hex(`payload:${label}`),
    gate_b_execution_sha256: sha256Hex(`execution:${label}`),
    connection_epoch: 1,
    per_turn_session_update_observation_sha256: sha256Hex(`update:${label}`),
    per_turn_session_ack_observation_sha256: sha256Hex(`ack:${label}`),
    transport_parity_sha256: sha256Hex(`transport:${label}`),
    tool_frontier_sha256: sha256Hex(`frontier:${label}`),
    exact_gateway_call_evidence_sha256: sha256Hex(`call:${label}`),
    matching_gateway_result_evidence_sha256: sha256Hex(`result:${label}`),
    public_execution_sha256: sha256Hex(`public:${label}`),
    replay_sha256: sha256Hex(`replay:${label}`),
    dynamic_update_provider_echo: "unverifiable" as const,
    ordered_vad_verified: true as const,
    exact_gateway_call_verified: true as const,
    matching_gateway_result_verified: true as const,
    sole_continuation_terminal_usage_verified: true as const,
  };
  return Object.freeze({
    ...body,
    binding_sha256: sha256Hex(`${DOMAIN}${canonicalJson(body)}`),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LC4-DEV retained xAI Gate B binding", () => {
  it("reopens the exact terminal-named artifact and rejects deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-gate-b-"));
    roots.push(root);
    const path = join(root, "xai-server-vad-gate-b-binding.json");
    const expected = artifact();
    await writeFile(path, `${canonicalJson(expected)}\n`, { flag: "wx" });

    await expect(loadLc4DevXaiServerVadGateBBinding({
      path,
      expected_binding_sha256: expected.binding_sha256,
    })).resolves.toEqual(expected);

    await rm(path);
    await expect(loadLc4DevXaiServerVadGateBBinding({
      path,
      expected_binding_sha256: expected.binding_sha256,
    })).rejects.toThrow();
  });

  it("rejects both in-place mutation and a self-consistent substituted artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-gate-b-"));
    roots.push(root);
    const path = join(root, "xai-server-vad-gate-b-binding.json");
    const expected = artifact();
    await writeFile(path, `${canonicalJson({ ...expected, model: "substituted-model" })}\n`);
    await expect(loadLc4DevXaiServerVadGateBBinding({
      path,
      expected_binding_sha256: expected.binding_sha256,
    })).rejects.toThrow(/artifact hash mismatch/);

    const replacement = artifact("replacement");
    await writeFile(path, `${canonicalJson(replacement)}\n`);
    await expect(loadLc4DevXaiServerVadGateBBinding({
      path,
      expected_binding_sha256: expected.binding_sha256,
    })).rejects.toThrow(/artifact hash mismatch/);
  });
});
