import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  assertLc4DevRetainedRoundtripLogCardinality,
  lc4DevProjectionContainsAssistantOutput,
  lc4DevPreToolOutputIsExactlyQuarantined,
  lc4DevRetainedUsageMatchesProviderBoundary,
  loadLc4DevXaiServerVadGateBBinding,
} from "../lc4-development-qualification-v3";
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

describe("LC4-DEV retained roundtrip log cardinality", () => {
  it("keeps raw usage counts distinct from the single sanitized replay event", () => {
    for (const evidence of [
      { provider: "openai" as const, wire: 141, rawUsage: 2 },
      { provider: "gemini" as const, wire: 113, rawUsage: 1 },
      { provider: "xai" as const, wire: 182, rawUsage: 2 },
    ]) {
      expect(() => assertLc4DevRetainedRoundtripLogCardinality({
        provider: evidence.provider,
        summary_wire_observation_count: evidence.wire,
        summary_raw_usage_event_count: evidence.rawUsage,
        retained_wire_observation_count: evidence.wire,
        retained_sanitized_usage_event_count: 1,
      })).not.toThrow();
    }
  });

  it("fails closed on invalid raw counts, wire drift, or sanitized replay multiplicity", () => {
    const baseline = {
      provider: "openai" as const,
      summary_wire_observation_count: 141,
      summary_raw_usage_event_count: 2,
      retained_wire_observation_count: 141,
      retained_sanitized_usage_event_count: 1,
    };
    expect(() => assertLc4DevRetainedRoundtripLogCardinality({
      ...baseline,
      summary_raw_usage_event_count: 0,
    })).toThrow(/raw usage count is invalid/u);
    expect(() => assertLc4DevRetainedRoundtripLogCardinality({
      ...baseline,
      retained_wire_observation_count: 140,
    })).toThrow(/wire count differs/u);
    expect(() => assertLc4DevRetainedRoundtripLogCardinality({
      ...baseline,
      retained_sanitized_usage_event_count: 0,
    })).toThrow(/exactly one event/u);
    expect(() => assertLc4DevRetainedRoundtripLogCardinality({
      ...baseline,
      retained_sanitized_usage_event_count: 2,
    })).toThrow(/exactly one event/u);
  });
});

describe("LC4-DEV pre-tool assistant-output detection", () => {
  it("does not confuse Gemini caller input transcription with assistant speech", () => {
    expect(lc4DevProjectionContainsAssistantOutput({
      text: [{
        byteLength: 34,
        kind: "input_transcript",
        sha256: "4".repeat(64),
      }],
    })).toBe(false);
    expect(lc4DevProjectionContainsAssistantOutput({
      terminal: { status: "completed" },
      text: [{
        byteLength: 34,
        kind: "transcript",
        sha256: "5".repeat(64),
      }],
    }, "conversation.item.input_audio_transcription.completed")).toBe(false);
  });

  it("fails closed on output, mixed, unknown, malformed, or audio projections", () => {
    for (const projection of [
      { text: [{ kind: "output_transcript", sha256: "1".repeat(64), byteLength: 8 }] },
      { text: [{ kind: "model_text", sha256: "2".repeat(64), byteLength: 8 }] },
      { text: [{ kind: "unknown", sha256: "3".repeat(64), byteLength: 8 }] },
      { text: [{ kind: "transcript", sha256: "4".repeat(64), byteLength: 8 }] },
      { text: [{ kind: "input_transcript" }, { kind: "output_transcript" }] },
      { text: [] },
      { text: "malformed" },
      { text: [null] },
      { audio: { direction: "output" }, text: [{ kind: "input_transcript" }] },
    ]) {
      expect(lc4DevProjectionContainsAssistantOutput(projection)).toBe(true);
    }
  });
});

describe("LC4-DEV xAI pre-tool output quarantine", () => {
  const observationHashes = ["1".repeat(64), "2".repeat(64)];
  const quarantine = {
    schema_version: 1 as const,
    disposition: "suppressed_never_caller_playable" as const,
    response_id_sha256: "3".repeat(64),
    response_started_observation_sha256: "4".repeat(64),
    terminal_observation_sha256: "5".repeat(64),
    observation_sha256s: observationHashes,
    observation_list_sha256: "6".repeat(64),
    audio_content_sha256: "7".repeat(64),
    audio_bytes: 90_712,
    audio_chunk_count: 5,
    sample_rate_hz: 24_000,
    released_audio_bytes: 0 as const,
    evidence_sha256: "8".repeat(64),
  };

  it("accepts only the exact replayed xAI suppression receipt", () => {
    expect(lc4DevPreToolOutputIsExactlyQuarantined({
      provider: "xai",
      pre_call_output_observation_sha256s: observationHashes,
      retained_quarantine: quarantine,
      replayed_quarantine: quarantine,
    })).toBe(true);
  });

  it("rejects unbound, partial, mutated, cross-provider, or released output", () => {
    for (const candidate of [
      { provider: "openai" as const, hashes: observationHashes, retained: quarantine, replayed: quarantine },
      { provider: "xai" as const, hashes: observationHashes.slice(0, 1), retained: quarantine, replayed: quarantine },
      { provider: "xai" as const, hashes: observationHashes, retained: null, replayed: quarantine },
      { provider: "xai" as const, hashes: observationHashes, retained: quarantine, replayed: { ...quarantine, evidence_sha256: "9".repeat(64) } },
      { provider: "xai" as const, hashes: observationHashes, retained: { ...quarantine, released_audio_bytes: 1 as never }, replayed: quarantine },
    ]) {
      expect(lc4DevPreToolOutputIsExactlyQuarantined({
        provider: candidate.provider,
        pre_call_output_observation_sha256s: candidate.hashes,
        retained_quarantine: candidate.retained,
        replayed_quarantine: candidate.replayed,
      })).toBe(false);
    }
  });
});

describe("LC4-DEV retained post-tool usage provider boundary", () => {
  const terminal = "a".repeat(64);
  const providerReported = {
    source: "provider_reported",
    terminal_observation_sha256: terminal,
    provider_usage_observation_sha256: "b".repeat(64),
  };
  const clientMeasured = {
    source: "client_measured_wire_pcm",
    terminal_observation_sha256: terminal,
    provider_usage_observation_sha256: null,
  };

  it("accepts provider-reported usage and xAI's terminal-bound measured PCM usage", () => {
    expect(lc4DevRetainedUsageMatchesProviderBoundary({
      provider: "openai",
      usage: [providerReported],
      terminal_observation_sha256: terminal,
      provider_usage_observed_on_wire: true,
    })).toBe(true);
    expect(lc4DevRetainedUsageMatchesProviderBoundary({
      provider: "xai",
      usage: [clientMeasured],
      terminal_observation_sha256: terminal,
      provider_usage_observed_on_wire: false,
    })).toBe(true);
  });

  it("rejects cross-provider, unbound, duplicated, and contradictory usage", () => {
    for (const candidate of [
      { provider: "gemini" as const, usage: [clientMeasured], terminal_observation_sha256: terminal, provider_usage_observed_on_wire: false },
      { provider: "xai" as const, usage: [clientMeasured], terminal_observation_sha256: "c".repeat(64), provider_usage_observed_on_wire: false },
      { provider: "xai" as const, usage: [clientMeasured, clientMeasured], terminal_observation_sha256: terminal, provider_usage_observed_on_wire: false },
      { provider: "xai" as const, usage: [clientMeasured], terminal_observation_sha256: terminal, provider_usage_observed_on_wire: true },
      { provider: "openai" as const, usage: [providerReported], terminal_observation_sha256: terminal, provider_usage_observed_on_wire: false },
      { provider: "openai" as const, usage: [{ ...providerReported, provider_usage_observation_sha256: null }], terminal_observation_sha256: terminal, provider_usage_observed_on_wire: true },
      { provider: "openai" as const, usage: [{ ...providerReported, source: "unknown" }], terminal_observation_sha256: terminal, provider_usage_observed_on_wire: true },
    ]) {
      expect(lc4DevRetainedUsageMatchesProviderBoundary(candidate)).toBe(false);
    }
  });
});
