import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  LC4_DEV_BUDGET_MAXIMUM_MICRO_USD,
  LC4_DEV_MAXIMUM_RUN_DURATION_MS,
  Lc4DevBudgetLifecycle,
  assertLc4DevRunLease,
  finalizeLc4DevRunBudget,
  replayLc4DevBudgetEvidence,
  reserveLc4DevRunBudget,
  type Lc4DevBudgetBinding,
} from "../lc4-development-budget";
import type { Lc4DevLiveRunArtifact } from "../lc4-development-live-runner";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function binding(expiresAt = "2026-07-23T01:00:00.000Z"): Lc4DevBudgetBinding {
  const providers = ["openai", "gemini", "xai"] as const;
  const episodes = providers.flatMap((provider) => (["native", "hacc"] as const).map((arm, armIndex) => ({
    episode_id: `lc4-dev-${provider}-${arm}`,
    pair_id: `lc4-dev-${provider}`,
    pair_position: armIndex + 1,
    provider,
    arm,
    model: `${provider}-realtime-model`,
    voice: `${provider}-voice`,
    maximum_micro_usd: 2_499_999,
    opportunity_binding_set_sha256: sha256Hex(`bindings:${provider}`),
  })));
  return {
    prepare: {
      execution_id: "lc4-dev-budget-test",
      prepare_sha256: "a".repeat(64),
      source_commit: "b".repeat(40),
      source_tree_sha256: "c".repeat(64),
      provider_profile_manifest_sha256: "d".repeat(64),
      audio_manifest_sha256: "e".repeat(64),
      maximum_total_micro_usd: LC4_DEV_BUDGET_MAXIMUM_MICRO_USD,
      episodes,
    } as unknown as Lc4DevBudgetBinding["prepare"],
    preflight: {
      execution_id: "lc4-dev-budget-test",
      prepare_sha256: "a".repeat(64),
      preflight_sha256: "f".repeat(64),
      expires_at: expiresAt,
      provider_calls_authorized: true,
      authorization_verified: true,
      authorization_artifact_sha256: "1".repeat(64),
      credential_identity_set_sha256: "2".repeat(64),
      qualification: { receipt_sha256: "3".repeat(64) },
    } as Lc4DevBudgetBinding["preflight"],
  };
}

function runFixture(bindingValue: Lc4DevBudgetBinding, status: "completed" | "failed" = "failed"): Lc4DevLiveRunArtifact {
  const body = {
    schema_version: 1 as const,
    execution_id: bindingValue.prepare.execution_id,
    prepare_sha256: bindingValue.prepare.prepare_sha256,
    preflight_sha256: bindingValue.preflight.preflight_sha256,
    started_at: "2026-07-22T23:00:01.000Z",
    completed_at: "2026-07-22T23:01:00.000Z",
    status,
    episodes_started: 1,
    episodes_completed: status === "completed" ? 6 : 0,
    opportunities_submitted: 1,
    opportunities_completed: status === "completed" ? 360 : 0,
    response_generations_requested: 1,
    provider_calls_started: 1,
    response_generations_completed: 0,
    provider_calls_made: 1,
    repair_playbacks: 0,
    total_response_generations: 1,
    paid_retry_count: 0 as const,
    maximum_total_micro_usd: LC4_DEV_BUDGET_MAXIMUM_MICRO_USD,
    retained_caller_audio: 1,
    retained_assistant_audio: 0,
    listener_evidence_count: 0,
    mechanism_receipt_count: 1,
    episode_finalization_count: 0,
    replay_evidence_reference_count: 1,
    failure_class: status === "failed" ? "transport" as const : null,
    failure_message_sha256: status === "failed" ? sha256Hex("failure") : null,
    ledger: [{
      sequence: 1,
      observed_at: "2026-07-22T23:00:02.000Z",
      event_type: status === "failed" ? "opportunity_failed" as const : "opportunity_completed" as const,
      episode_id: bindingValue.prepare.episodes[0]!.episode_id,
      opportunity_id: "lc4-dev-op-01",
      payload_sha256: sha256Hex("payload"),
      payload_evidence: { kind: "ledger_payload" as const, evidence_sha256: sha256Hex("payload"), byte_length: 2 },
      evidence_references: [],
      previous_event_sha256: null,
      event_sha256: sha256Hex("event"),
    }],
    ledger_head_sha256: sha256Hex("event"),
  };
  return { ...body, run_sha256: sha256Hex(JSON.stringify(body)) } as unknown as Lc4DevLiveRunArtifact;
}

describe("LC4-DEV hard aggregate budget authority", () => {
  it("atomically consumes one authority and reserves exactly the six provider-tagged cells", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-budget-"));
    roots.push(root);
    const bindingValue = binding();
    const now = () => new Date("2026-07-22T23:00:00.000Z");
    const lease = await reserveLc4DevRunBudget({ root, binding: bindingValue, now });

    expect(lease.reservations).toHaveLength(6);
    expect(new Set(lease.reservations.map((item) => item.episode_id)).size).toBe(6);
    expect(new Set(lease.reservations.map((item) => item.provider))).toEqual(new Set(["openai", "gemini", "xai"]));
    expect(lease.reservations.reduce((sum, item) => sum + item.maximum_micro_usd, 0)).toBeLessThanOrEqual(15_000_000);
    expect(lease.maximum_retries).toBe(0);
    expect(lease.maximum_reconnects).toBe(0);
    expect(() => assertLc4DevRunLease({ lease, binding: bindingValue, now: now(), admission: true })).not.toThrow();

    await expect(reserveLc4DevRunBudget({ root, binding: bindingValue, now })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("admits before preflight expiry, continues planned cells under the consumed lease, and rejects replay/reconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-budget-"));
    roots.push(root);
    const bindingValue = binding("2026-07-22T23:00:30.000Z");
    let clock = new Date("2026-07-22T23:00:00.000Z");
    const now = () => new Date(clock);
    const lease = await reserveLc4DevRunBudget({ root, binding: bindingValue, now });
    const lifecycle = new Lc4DevBudgetLifecycle({ lease, binding: bindingValue, now });
    lifecycle.assertProviderConstructionAuthorized();

    clock = new Date("2026-07-22T23:00:31.000Z");
    await lifecycle.beforeEpisodeSocketOpen(bindingValue.prepare.episodes[0]!);
    await lifecycle.afterEpisodeSocketOpen(bindingValue.prepare.episodes[0]!);
    await expect(lifecycle.beforeEpisodeSocketOpen(bindingValue.prepare.episodes[0]!)).rejects.toThrow("retry or reconnect authority is zero");
    await expect(lifecycle.beforeEpisodeSocketOpen({
      ...bindingValue.prepare.episodes[1]!,
      episode_id: "lc4-dev-seventh-cell",
    })).rejects.toThrow("unreserved seventh");
    expect(() => lifecycle.assertProviderConstructionAuthorized()).toThrow("after preflight expiry");
  });

  it("refuses start after expiry and enforces the provider-independent hard run deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-budget-"));
    roots.push(root);
    await expect(reserveLc4DevRunBudget({
      root,
      binding: binding("2026-07-22T23:00:00.000Z"),
      now: () => new Date("2026-07-22T23:00:00.000Z"),
    })).rejects.toThrow("after preflight expiry");

    const freshRoot = await mkdtemp(join(tmpdir(), "lc4-dev-budget-"));
    roots.push(freshRoot);
    const bindingValue = binding();
    let clock = new Date("2026-07-22T23:00:00.000Z");
    const now = () => new Date(clock);
    const lease = await reserveLc4DevRunBudget({ root: freshRoot, binding: bindingValue, now });
    const lifecycle = new Lc4DevBudgetLifecycle({ lease, binding: bindingValue, now });
    clock = new Date(Date.parse(lease.admitted_at) + LC4_DEV_MAXIMUM_RUN_DURATION_MS);
    expect(() => lifecycle.assertWithinHardDeadline()).toThrow("hard overall run deadline elapsed");
  });

  it("conservatively settles ambiguous opened liability, cancels never-opened cells, and independently replays", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-budget-"));
    roots.push(root);
    const bindingValue = binding();
    const now = () => new Date("2026-07-22T23:00:00.000Z");
    const lease = await reserveLc4DevRunBudget({ root, binding: bindingValue, now });
    const lifecycle = new Lc4DevBudgetLifecycle({ lease, binding: bindingValue, now });
    await lifecycle.beforeEpisodeSocketOpen(bindingValue.prepare.episodes[0]!);
    // Simulate timeout before provider-open acknowledgement: "opening" is
    // charged at the full pessimistic maximum, never treated as free.
    const run = runFixture(bindingValue);
    const evidence = await finalizeLc4DevRunBudget({ lease, binding: bindingValue, run, now });

    expect(evidence.active_reservations_micro_usd).toBe(0);
    expect(evidence.reservations[0]).toMatchObject({ status: "settled", terminal_outcome: "failed", conservative_settled_micro_usd: 2_499_999 });
    expect(evidence.reservations.slice(1).every((item) => item.status === "cancelled" && item.conservative_settled_micro_usd === 0)).toBe(true);
    await expect(replayLc4DevBudgetEvidence({ lease, binding: bindingValue, evidence, now })).resolves.toBeUndefined();

    const tampered = { ...evidence, conservative_settled_micro_usd: 0 };
    await expect(replayLc4DevBudgetEvidence({ lease, binding: bindingValue, evidence: tampered, now })).rejects.toThrow("evidence hash mismatch");
    const badLease = { ...lease, fully_reserved_head_sha256: "0".repeat(64) };
    expect(() => assertLc4DevRunLease({ lease: badLease, binding: bindingValue, now: now() })).toThrow("lease hash mismatch");
  });

  it("fails independent replay if the signed ledger bytes are tampered", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-budget-"));
    roots.push(root);
    const bindingValue = binding();
    const now = () => new Date("2026-07-22T23:00:00.000Z");
    const lease = await reserveLc4DevRunBudget({ root, binding: bindingValue, now });
    const lifecycle = new Lc4DevBudgetLifecycle({ lease, binding: bindingValue, now });
    await lifecycle.beforeEpisodeSocketOpen(bindingValue.prepare.episodes[0]!);
    const run = runFixture(bindingValue);
    const evidence = await finalizeLc4DevRunBudget({ lease, binding: bindingValue, run, now });
    const bytes = await readFile(lease.ledger_path, "utf8");
    await writeFile(lease.ledger_path, bytes.replace("lc4-dev-openai-native", "lc4-dev-openai-hacked"));
    await expect(replayLc4DevBudgetEvidence({ lease, binding: bindingValue, evidence, now })).rejects.toThrow();
  });
});
