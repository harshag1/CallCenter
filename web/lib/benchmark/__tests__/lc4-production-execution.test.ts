import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_EXECUTION_AUTHORIZATION_VERSION,
  LC4_PAID_PROVIDER_EXECUTION_BUILD_FROZEN,
  appendLc4ExecutionLedgerEvent,
  appendLc4ExecutionLedgerStore,
  assertLc4ExecutionAuthorization,
  assertLc4ExecutionLedger,
  createLc4ExecutionLedger,
  createLc4ExecutionPreflight,
  createLc4FilesystemReservationVerification,
  executeLc4AuthorizedProductionEpisode,
  initializeLc4ExecutionLedgerStore,
  lc4ExecutionAuthorizationArtifactSha256,
  lc4ExecutionAuthorizationSigningBytes,
  retainLc4ImmutableArtifact,
  withLc4StrictTimeout,
  type Lc4ExecutionAuthorizationArtifact,
  type Lc4ExecutionAuthorizationBody,
} from "../lc4-production-execution";
import {
  initializeFilesystemBudgetLedger,
  reserveFilesystemBudget,
  type BudgetCostEnvelope,
} from "../filesystem-budget-ledger";
import type { Lc4FrozenProductionRealtimeAdapter } from "../lc4-production-provider-adapter";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "../lc4-provider-profiles";
import {
  compileLc4ProductionScheduleShape,
  createLc4EpisodeManifest,
  createLc4QualificationGateReceipt,
  type Lc4EpisodeManifest,
  type Lc4OpportunityBinding,
} from "../lc4-production-runner-foundation";

const NOW = new Date("2026-07-21T20:10:00.000Z");
const COMMIT = "b".repeat(40);
const HASH = "a".repeat(64);
const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function opportunities(): readonly Lc4OpportunityBinding[] {
  return Object.freeze(Array.from({ length: 60 }, (_, index) => {
    const pcm = new Uint8Array([index + 1, 7, 11, 13]);
    return Object.freeze({
      ordinal: index + 1,
      opportunity_id: `op-${String(index + 1).padStart(2, "0")}`,
      segment_ordinal: Math.ceil((index + 1) / 20) as 1 | 2 | 3,
      caller_pcm_sha256: sha256Hex(pcm),
      caller_pcm_byte_length: pcm.byteLength,
      opportunity_contract_sha256: sha256Hex(`contract-${index + 1}`),
    });
  }));
}

function manifest(reservationOverride?: Lc4EpisodeManifest["budget_reservation"]): Lc4EpisodeManifest {
  const schedule = compileLc4ProductionScheduleShape();
  const episode = schedule.episode_shapes[0];
  const reservation = {
    reservation_id: "reservation-1",
    run_id: episode.run_id,
    provider: episode.provider,
    model: episode.provider_profile.model,
    maximum_micro_usd: episode.maximum_reservation_micro_usd,
    status: "reserved" as const,
    ledger_head_sha256: "1".repeat(64),
  };
  return createLc4EpisodeManifest({
    schedule,
    run_id: episode.run_id,
    source_commit: COMMIT,
    source_tree_sha256: "2".repeat(64),
    preregistration_sha256: "3".repeat(64),
    heldout_commitment_sha256: "4".repeat(64),
    template_commitment_sha256: "5".repeat(64),
    opportunity_manifest_sha256: "6".repeat(64),
    caller_fixture_manifest_sha256: "7".repeat(64),
    condition_suite_sha256: "8".repeat(64),
    parity_manifest_sha256: "9".repeat(64),
    generator_schedule_join_sha256: "0".repeat(64),
    qualification: createLc4QualificationGateReceipt({
      plan_sha256: HASH,
      source_commit: COMMIT,
      configuration_matrix_sha256: "c".repeat(64),
      credential_set_sha256: "d".repeat(64),
      handshake: { status: "conditional", artifact_sha256: "e".repeat(64), completed_at: "2026-07-21T20:00:00.000Z" },
      response_tool_canary: {
        status: "passed",
        artifact_sha256: "f".repeat(64),
        completed_at: "2026-07-21T20:01:00.000Z",
        caller_audio_bytes: 0,
        providers_verified: ["openai", "gemini", "xai"],
      },
    }),
    budget_reservation: reservationOverride ?? { ...reservation, reservation_sha256: sha256Hex(JSON.stringify(reservation)) },
    opportunities: opportunities(),
  });
}

async function executionFixture() {
  const initial = manifest();
  const root = await mkdtemp(join(tmpdir(), "lc4-budget-execution-"));
  temporaryPaths.push(root);
  const ledgerPath = join(root, "budget.jsonl");
  await initializeFilesystemBudgetLedger({
    ledgerPath,
    ledgerId: "lc4-production-test-ledger",
    operationId: "initialize-lc4-production-test-ledger",
    now: () => new Date("2026-07-21T20:08:00.000Z"),
  });
  const maximum = initial.episode_shape.maximum_reservation_micro_usd;
  const envelope: BudgetCostEnvelope = Object.freeze({
    schema_version: 1,
    kind: "hacc_provider_gate1_cost_envelope",
    pricing_snapshot_sha256: "a".repeat(64),
    provider_hard_session_caps_sha256: "b".repeat(64),
    runner_config_sha256: "c".repeat(64),
    formula_sha256: "d".repeat(64),
    components: Object.freeze([Object.freeze({ name: "frozen-episode-envelope", upper_bound_micro_usd: maximum })]),
    safety_margin_micro_usd: 0,
  });
  const reserved = await reserveFilesystemBudget({
    ledgerPath,
    operationId: "reserve-lc4-run",
    reservationId: "reservation-1",
    runId: initial.run_id,
    provider: initial.episode_shape.provider,
    model: initial.episode_shape.provider_profile.model,
    condition: initial.episode_shape.arm,
    expiresAt: "2026-07-21T21:30:00.000Z",
    costEnvelope: envelope,
    now: () => new Date("2026-07-21T20:09:00.000Z"),
  });
  const reservationBody = {
    reservation_id: "reservation-1",
    run_id: initial.run_id,
    provider: initial.episode_shape.provider,
    model: initial.episode_shape.provider_profile.model,
    maximum_micro_usd: maximum,
    status: "reserved" as const,
    ledger_head_sha256: reserved.snapshot.head_sha256,
  };
  const value = manifest({
    ...reservationBody,
    reservation_sha256: sha256Hex(`lc4-test-reservation\n${canonicalJson(reservationBody)}`),
  });
  const reservationVerification = await createLc4FilesystemReservationVerification({ ledgerPath, manifest: value, checkedAt: NOW });
  return Object.freeze({ value, reservationVerification });
}

function authorization(value: Lc4EpisodeManifest): Readonly<{
  artifact: Lc4ExecutionAuthorizationArtifact;
  fingerprint: string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ format: "der", type: "spki" });
  const fingerprint = sha256Hex(publicKeyBytes);
  const body: Lc4ExecutionAuthorizationBody = Object.freeze({
    schema_version: 1,
    authorization_version: LC4_EXECUTION_AUTHORIZATION_VERSION,
    execution_id: "execution-1",
    authorization_nonce_sha256: "a".repeat(64),
    protocol_id: "HACC-LC4-v1",
    schedule_sha256: value.schedule_sha256,
    source_commit: value.source_commit,
    source_tree_sha256: value.source_tree_sha256,
    preregistration_sha256: value.preregistration_sha256,
    heldout_commitment_sha256: value.heldout_commitment_sha256,
    generator_schedule_join_sha256: value.generator_schedule_join_sha256,
    qualification_gate_sha256: value.qualification.gate_sha256,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    authorized_run_ids: Object.freeze([value.run_id]),
    maximum_total_micro_usd: value.budget_reservation.maximum_micro_usd,
    not_before: "2026-07-21T20:05:00.000Z",
    expires_at: "2026-07-21T20:30:00.000Z",
    purpose: "lc4_confirmatory_provider_execution",
  });
  const unsigned = {
    body,
    authority_public_key_spki_base64: publicKeyBytes.toString("base64"),
    authority_public_key_fingerprint_sha256: fingerprint,
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(null, lc4ExecutionAuthorizationSigningBytes(body), privateKey).toString("base64"),
  };
  return Object.freeze({
    fingerprint,
    artifact: Object.freeze({ ...unsigned, artifact_sha256: lc4ExecutionAuthorizationArtifactSha256(unsigned) }),
  });
}

const frozenAdapter: Lc4FrozenProductionRealtimeAdapter = Object.freeze({
  kind: "production-realtime-frozen" as const,
  async openSegment() { throw new Error("test must never construct a provider session"); },
});

describe("LC4 production execution authorization and preflight", () => {
  it("requires an Ed25519 signature rooted in the separately pinned authority fingerprint", () => {
    const value = manifest();
    const signed = authorization(value);
    expect(() => assertLc4ExecutionAuthorization({
      artifact: signed.artifact,
      expected_authority_public_key_fingerprint_sha256: signed.fingerprint,
      now: NOW,
    })).not.toThrow();
    expect(() => assertLc4ExecutionAuthorization({
      artifact: signed.artifact,
      expected_authority_public_key_fingerprint_sha256: "9".repeat(64),
      now: NOW,
    })).toThrow("pinned trust root");
    expect(() => assertLc4ExecutionAuthorization({
      artifact: { ...signed.artifact, signature_base64: Buffer.alloc(64).toString("base64") },
      expected_authority_public_key_fingerprint_sha256: signed.fingerprint,
      now: NOW,
    })).toThrow("artifact hash mismatch");
  });

  it("binds qualification, reservation, source, corpus, schedule, and exact run before the frozen network boundary", async () => {
    const { value, reservationVerification } = await executionFixture();
    const signed = authorization(value);
    const preflight = createLc4ExecutionPreflight({
      manifest: value,
      authorization: signed.artifact,
      expected_authority_public_key_fingerprint_sha256: signed.fingerprint,
      qualification_binding: {
        plan_sha256: HASH,
        source_commit: COMMIT,
        configuration_matrix_sha256: "c".repeat(64),
        credential_set_sha256: "d".repeat(64),
      },
      adapter: frozenAdapter,
      reservation_verification: reservationVerification,
      now: NOW,
    });
    expect(preflight).toMatchObject({
      run_id: value.run_id,
      cryptographic_authorization_verified: true,
      qualification_verified: true,
      reservation_verified: true,
      provider_calls_authorized: false,
      blocked_reason: "paid_provider_execution_build_frozen",
    });
    expect(LC4_PAID_PROVIDER_EXECUTION_BUILD_FROZEN).toBe(true);
  });

  it("rejects stale qualification and any authorization-to-manifest drift", async () => {
    const { value, reservationVerification } = await executionFixture();
    const signed = authorization(value);
    const base = {
      manifest: value,
      authorization: signed.artifact,
      expected_authority_public_key_fingerprint_sha256: signed.fingerprint,
      qualification_binding: {
        plan_sha256: HASH,
        source_commit: COMMIT,
        configuration_matrix_sha256: "c".repeat(64),
        credential_set_sha256: "d".repeat(64),
      },
      adapter: frozenAdapter,
      reservation_verification: reservationVerification,
    } as const;
    expect(() => createLc4ExecutionPreflight({ ...base, now: new Date("2026-07-21T21:00:00.000Z") })).toThrow("expired");
    const driftedBody = { ...signed.artifact.body, schedule_sha256: "9".repeat(64) };
    expect(() => createLc4ExecutionPreflight({
      ...base,
      authorization: { ...signed.artifact, body: driftedBody },
      now: NOW,
    })).toThrow("artifact hash mismatch");
  });

  it("refuses provider execution after successful cryptographic preflight without touching the adapter", async () => {
    const { value, reservationVerification } = await executionFixture();
    const signed = authorization(value);
    const openSegment = vi.fn(frozenAdapter.openSegment);
    const adapter = { ...frozenAdapter, openSegment };
    const preflight = createLc4ExecutionPreflight({
      manifest: value,
      authorization: signed.artifact,
      expected_authority_public_key_fingerprint_sha256: signed.fingerprint,
      qualification_binding: {
        plan_sha256: HASH,
        source_commit: COMMIT,
        configuration_matrix_sha256: "c".repeat(64),
        credential_set_sha256: "d".repeat(64),
      },
      adapter,
      reservation_verification: reservationVerification,
      now: NOW,
    });
    await expect(executeLc4AuthorizedProductionEpisode({ preflight, adapter })).rejects.toThrow("hard-frozen");
    expect(openSegment).not.toHaveBeenCalled();
  });
});

describe("LC4 production execution ledger", () => {
  it("separates connection-open from ITT first audio and permanently consumes the run ID at socket open", () => {
    let ledger = createLc4ExecutionLedger({
      execution_id: "execution-1",
      run_id: "run-1",
      preflight_sha256: "a".repeat(64),
      reservation_sha256: "b".repeat(64),
      occurred_at: "2026-07-21T20:10:00.000Z",
    });
    expect(ledger).toMatchObject({ state: "reserved", connection_opened: false, itt_first_audio_consumed: false, run_id_consumed: false });
    ledger = appendLc4ExecutionLedgerEvent(ledger, {
      occurred_at: "2026-07-21T20:10:01.000Z",
      event_kind: "connection.intent",
      payload: {},
    });
    ledger = appendLc4ExecutionLedgerEvent(ledger, {
      occurred_at: "2026-07-21T20:10:02.000Z",
      event_kind: "connection.opened",
      payload: { connection_epoch: 1 },
    });
    expect(ledger).toMatchObject({ state: "connected", connection_opened: true, itt_first_audio_consumed: false, run_id_consumed: true });
    expect(() => appendLc4ExecutionLedgerEvent(ledger, {
      occurred_at: "2026-07-21T20:10:03.000Z",
      event_kind: "connection.intent",
      payload: {},
    })).toThrow("requires a reserved episode");
    ledger = appendLc4ExecutionLedgerEvent(ledger, {
      occurred_at: "2026-07-21T20:10:04.000Z",
      event_kind: "itt.first_audio_consumed",
      payload: { opportunity_id: "op-01" },
    });
    expect(ledger).toMatchObject({ state: "itt_open", itt_first_audio_consumed: true, run_id_consumed: true });
    assertLc4ExecutionLedger(ledger);
  });

  it("allows only a pre-open connection retry and retains one durable run-ID anchor", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-ledger-"));
    temporaryPaths.push(root);
    let ledger = createLc4ExecutionLedger({
      execution_id: "execution-1",
      run_id: "run-1",
      preflight_sha256: "a".repeat(64),
      reservation_sha256: "b".repeat(64),
      occurred_at: "2026-07-21T20:10:00.000Z",
    });
    await expect(initializeLc4ExecutionLedgerStore({ root, ledger })).resolves.toContain("run-");
    await expect(initializeLc4ExecutionLedgerStore({ root, ledger })).rejects.toThrow("already has a durable execution anchor");
    const intent = appendLc4ExecutionLedgerEvent(ledger, {
      occurred_at: "2026-07-21T20:10:01.000Z",
      event_kind: "connection.intent",
      payload: { attempt: 1 },
    });
    await appendLc4ExecutionLedgerStore({ root, previous: ledger, next: intent });
    const preopenFailure = appendLc4ExecutionLedgerEvent(intent, {
      occurred_at: "2026-07-21T20:10:02.000Z",
      event_kind: "connection.preopen_failed",
      payload: { failure_code: "connect_timeout" },
    });
    await appendLc4ExecutionLedgerStore({ root, previous: intent, next: preopenFailure });
    expect(preopenFailure).toMatchObject({ state: "reserved", run_id_consumed: false, preopen_connection_failures: 1 });
    ledger = appendLc4ExecutionLedgerEvent(preopenFailure, {
      occurred_at: "2026-07-21T20:10:03.000Z",
      event_kind: "connection.intent",
      payload: { attempt: 2 },
    });
    expect(ledger.state).toBe("connecting");
  });

  it("captures immutable evidence, usage, terminal outcome, and settled provider cost in the hash chain", () => {
    let ledger = createLc4ExecutionLedger({
      execution_id: "execution-1",
      run_id: "run-1",
      preflight_sha256: "a".repeat(64),
      reservation_sha256: "b".repeat(64),
      occurred_at: "2026-07-21T20:10:00.000Z",
    });
    for (const event of [
      { event_kind: "connection.intent" as const, payload: {} },
      { event_kind: "connection.opened" as const, payload: { connection_epoch: 1 } },
      { event_kind: "itt.first_audio_consumed" as const, payload: { opportunity_id: "op-01" } },
      { event_kind: "artifact.retained" as const, payload: { artifact_sha256: "c".repeat(64), byte_length: 4, kind: "assistant_pcm" } },
      { event_kind: "usage.observed" as const, payload: { input_audio_ms: 1_000, output_audio_ms: 2_000, provider_reported_micro_usd: 1_234 } },
      { event_kind: "episode.terminal" as const, payload: { outcome: "completed" } },
      { event_kind: "cost.settled" as const, payload: { estimated_micro_usd: 1_300, provider_reported_micro_usd: 1_234 } },
    ]) {
      ledger = appendLc4ExecutionLedgerEvent(ledger, {
        occurred_at: `2026-07-21T20:10:${String(ledger.events.length).padStart(2, "0")}.000Z`,
        ...event,
      });
    }
    expect(ledger).toMatchObject({
      state: "settled",
      terminal_outcome: "completed",
      provider_reported_micro_usd: 1_234,
      estimated_micro_usd: 1_300,
      input_audio_ms: 1_000,
      output_audio_ms: 2_000,
      retained_artifact_count: 1,
    });
    expect(() => assertLc4ExecutionLedger({ ...ledger, input_audio_ms: 999 })).toThrow("integrity failed");
  });
});

describe("LC4 production retention and timeouts", () => {
  it("retains content-addressed audio as a private read-only no-clobber artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-retention-"));
    temporaryPaths.push(root);
    const bytes = new Uint8Array([1, 0, 2, 0]);
    const first = await retainLc4ImmutableArtifact({ root, run_id: "run-1", opportunity_id: "op-01", kind: "assistant_pcm", bytes });
    const second = await retainLc4ImmutableArtifact({ root, run_id: "run-1", opportunity_id: "op-01", kind: "assistant_pcm", bytes });
    expect(second).toEqual(first);
    expect(await readFile(join(root, first.relative_path))).toEqual(Buffer.from(bytes));
    expect(first.retention_receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("aborts and runs cleanup on a strict timeout", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const observed: { signal?: AbortSignal } = {};
    const pending = withLc4StrictTimeout({
      label: "connection open",
      timeout_ms: 20,
      operation: async (signal) => {
        observed.signal = signal;
        return await new Promise<never>(() => undefined);
      },
      on_timeout: cleanup,
    });
    const rejection = expect(pending).rejects.toThrow("connection open timed out");
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(observed.signal?.aborted).toBe(true);
  });
});
