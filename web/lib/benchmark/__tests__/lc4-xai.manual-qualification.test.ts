import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "../lc4-production-provider-contract";
import {
  LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
  LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
  Lc4XaiFiniteManualGateDClaimedFailureError,
  assertLc4XaiFiniteManualGateDExecutionEvidence,
  assertLc4XaiFiniteManualGateDFailure,
  assertLc4XaiFiniteManualGateDReceipt,
  classifyLc4XaiFiniteManualGateDFailure,
  createLc4XaiFiniteManualGateDAuthorization,
  createLc4XaiFiniteManualGateDPlan,
  createLc4XaiFiniteManualGateDSigner,
  executeLc4XaiFiniteManualGateD,
  lc4XaiFiniteManualGateDExecutionReplaySha256,
  type Lc4XaiFiniteManualGateDExecutionEvidence,
  type Lc4XaiFiniteManualGateDProductionAdapter,
  type Lc4XaiFiniteManualGateDReceipt,
} from "../lc4-xai.manual-qualification";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "../lc4-provider-profiles";
import {
  lc4XaiManualResponseWireIdentitySha256,
  type Lc4SanitizedWireObservation,
} from "../lc4-xai-manual-turn-causality";

const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_TREE = sha256Hex("gate-d-source-tree");
const PROVIDER_IDENTITY_SHA256 = sha256Hex("synthetic-provider-identity");
const NOW = new Date("2026-07-28T23:00:00.000Z");
const MANUAL_CAUSALITY_DOMAIN =
  "harshas-amazing-call-center/lc4-xai-manual-turn-causality/v1\n";
const RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-receipt/v2\n";
const roots: string[] = [];

function withoutReceiptHash<T extends { receipt_sha256: string }>(
  value: T,
): Omit<T, "receipt_sha256"> {
  const { receipt_sha256: claimedReceiptSha256, ...copy } = value;
  void claimedReceiptSha256;
  return copy;
}

function rehashReceipt(
  value: Omit<Lc4XaiFiniteManualGateDReceipt, "receipt_sha256">,
): Lc4XaiFiniteManualGateDReceipt {
  return {
    ...value,
    receipt_sha256: sha256Hex(
      `${RECEIPT_DOMAIN}${canonicalJson(value)}`,
    ),
  } as Lc4XaiFiniteManualGateDReceipt;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function signer() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return createLc4XaiFiniteManualGateDSigner(
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
}

function wireObservations(): readonly Lc4SanitizedWireObservation[] {
  const roles = [
    ["outbound", "input_audio_buffer.commit"],
    ["inbound", "input_audio_buffer.committed"],
    ["outbound", "response.create"],
    ["inbound", "response.created"],
    ["inbound", "response.audio.delta"],
    ["inbound", "response.function_call_arguments.done"],
    ["inbound", "response.done"],
    ["outbound", "conversation.item.create"],
    ["outbound", "response.create"],
    ["inbound", "response.created"],
    ["inbound", "response.audio.delta"],
    ["inbound", "response.done"],
  ] as const;
  let previous: string | null = null;
  return roles.map(([direction, wireType], index) => {
    const sequence = index + 1;
    const payload = sha256Hex(`payload:${sequence}`);
    const observation = sha256Hex(canonicalJson({
      provider: "xai",
      direction,
      sequence,
      wireType,
      payload,
      previous,
    }));
    const value = Object.freeze({
      provider: "xai" as const,
      direction,
      connection_epoch: 1,
      sequence,
      wire_type: wireType,
      payload_sha256: payload,
      payload_bytes: 10,
      projection_sha256: sha256Hex(`projection:${sequence}`),
      observation_sha256: observation,
      previous_observation_sha256: previous,
      identity_hashes: {
        ...([4, 5, 6, 7].includes(sequence)
          ? {
              responseIdSha256:
                lc4XaiManualResponseWireIdentitySha256("response-id"),
            }
          : {}),
        ...([10, 11, 12].includes(sequence)
          ? {
              responseIdSha256:
                lc4XaiManualResponseWireIdentitySha256("post-tool-response-id"),
            }
          : {}),
        ...([6, 7, 8].includes(sequence)
          ? { callIdSha256: sha256Hex("capability-gateway-call-id") }
          : {}),
      },
    });
    previous = observation;
    return value;
  });
}

function executionEvidence(
  callerPcm: Uint8Array,
  overrides: Partial<Lc4XaiFiniteManualGateDExecutionEvidence> = {},
): Lc4XaiFiniteManualGateDExecutionEvidence {
  const observations = wireObservations();
  const causalityBody = {
    schema_version: 1 as const,
    connection_epoch: 1,
    commit_observation_sha256: observations[0]!.observation_sha256,
    commit_sequence: 1,
    commit_ack_observation_sha256: observations[1]!.observation_sha256,
    commit_ack_sequence: 2,
    response_create_observation_sha256: observations[2]!.observation_sha256,
    response_create_sequence: 3,
    response_start_observation_sha256: observations[3]!.observation_sha256,
    response_start_sequence: 4,
    response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("response-id"),
  };
  const body = {
    schema_version: 2 as const,
    provider: "xai" as const,
    model: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model,
    voice: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.voice,
    transport_purpose: "finite_prerecorded_efficacy" as const,
    transport_mode: "manual_commit" as const,
    transport_profile_sha256:
      LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    caller_pcm_sha256: sha256Hex(callerPcm),
    caller_pcm_byte_length: callerPcm.byteLength,
    caller_pcm_appended_sha256: sha256Hex(callerPcm),
    caller_pcm_appended_byte_length: callerPcm.byteLength,
    provider_sessions_opened: 1 as const,
    generation_phases: 2 as const,
    capability_gateway_tool_roundtrips: 1 as const,
    retries: 0 as const,
    reconnects: 0 as const,
    fallbacks: 0 as const,
    operation_order: LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
    manual_turn_causality: Object.freeze({
      ...causalityBody,
      causality_sha256: sha256Hex(
        `${MANUAL_CAUSALITY_DOMAIN}${canonicalJson(causalityBody)}`,
      ),
    }),
    wire_observations: observations,
    initial_assistant_pcm_sha256: sha256Hex("initial assistant PCM"),
    initial_assistant_pcm_byte_length: 4,
    initial_assistant_pcm_observation_sha256:
      observations[4]!.observation_sha256,
    capability_gateway_tool_call_sha256: sha256Hex("gateway call"),
    capability_gateway_tool_call_observation_sha256:
      observations[6]!.observation_sha256,
    capability_gateway_tool_result_sha256: sha256Hex("gateway result"),
    capability_gateway_tool_result_observation_sha256:
      observations[7]!.observation_sha256,
    post_tool_continuation_sha256: sha256Hex("continuation"),
    post_tool_continuation_observation_sha256:
      observations[8]!.observation_sha256,
    post_tool_response_start_observation_sha256:
      observations[9]!.observation_sha256,
    post_tool_assistant_pcm_sha256: sha256Hex("post-tool assistant PCM"),
    post_tool_assistant_pcm_byte_length: 4,
    post_tool_assistant_pcm_observation_sha256:
      observations[10]!.observation_sha256,
    capability_gateway_call_id_sha256:
      sha256Hex("capability-gateway-call-id"),
    post_tool_continuation_origin_response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("response-id"),
    post_tool_response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("post-tool-response-id"),
    terminal_observation_sha256: observations[11]!.observation_sha256,
    ...overrides,
  };
  const withoutReplay = body as Omit<
    Lc4XaiFiniteManualGateDExecutionEvidence,
    "replay_sha256"
  >;
  return Object.freeze({
    ...withoutReplay,
    replay_sha256: lc4XaiFiniteManualGateDExecutionReplaySha256(withoutReplay),
  });
}

function productionAdapter(
  execute: Lc4XaiFiniteManualGateDProductionAdapter["execute"],
): Lc4XaiFiniteManualGateDProductionAdapter {
  return Object.freeze({
    [LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY]: true as const,
    kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1",
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    execute,
  });
}

function fixture() {
  const authority = signer();
  const terminal = signer();
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  const plan = createLc4XaiFiniteManualGateDPlan({
    gate_id: "gate-d-test",
    prepared_at: NOW.toISOString(),
    source_commit: SOURCE_COMMIT,
    source_tree_sha256: SOURCE_TREE,
    harmless_clip_pcm: pcm,
    signer: authority,
  });
  const authorization = createLc4XaiFiniteManualGateDAuthorization({
    plan,
    plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
    authorization_id: "gate-d-auth",
    authorization_nonce_sha256: sha256Hex("gate-d-nonce"),
    credential_identity_sha256: PROVIDER_IDENTITY_SHA256,
    terminal_signer: terminal,
    not_before: new Date(NOW.getTime() - 1_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    authority_signer: authority,
  });
  return { authority, terminal, pcm, plan, authorization };
}

async function passingReceipt(
  overrides: Partial<Parameters<typeof executeLc4XaiFiniteManualGateD>[0]> = {},
) {
  const value = fixture();
  const root = await mkdtemp(join(tmpdir(), "hacc-gate-d-pass-"));
  roots.push(root);
  return {
    ...value,
    receipt: await executeLc4XaiFiniteManualGateD({
      plan: value.plan,
      authorization: value.authorization,
      terminal_signer: value.terminal,
      credential_identity_sha256: PROVIDER_IDENTITY_SHA256,
      caller_pcm: value.pcm,
      inspected_source: {
        source_commit: SOURCE_COMMIT,
        source_tree_sha256: SOURCE_TREE,
        worktree_clean: true,
      },
      now: NOW,
      completion_clock: () => new Date(NOW.getTime() + 1_000),
      expected_plan_trust_root_sha256:
        value.authority.public_key_fingerprint_sha256,
      invocation_marker_path: join(root, "invocation.json"),
      construct_production_adapter: () => productionAdapter(
        async ({ caller_pcm }) => executionEvidence(caller_pcm),
      ),
      ...overrides,
    }),
  };
}

describe("LC4 xAI finite-manual Gate D", () => {
  it("separates provider authentication rejection from local preflight errors", () => {
    expect(classifyLc4XaiFiniteManualGateDFailure(
      new Error("Incorrect API key provided"),
    )).toBe("provider_authentication");
    expect(classifyLc4XaiFiniteManualGateDFailure(
      new Error("Gate D credential identity differs from authorization"),
    )).toBe("preflight_contract");
    expect(classifyLc4XaiFiniteManualGateDFailure(
      new Error("tool continuation audio evidence is inconsistent"),
    )).toBe("tool_roundtrip_causality");
  });

  it("produces a replay-verifiable, redacted, non-efficacy receipt", async () => {
    const { receipt, authority } = await passingReceipt();
    expect(receipt).toMatchObject({
      status: "passed",
      transport_purpose: "finite_prerecorded_efficacy",
      transport_mode: "manual_commit",
      provider_sessions_opened: 1,
      retries: 0,
      reconnects: 0,
      fallbacks: 0,
      efficacy_scored: false,
      claim_boundary: "transport_qualification_only_not_efficacy_evidence",
    });
    expect(canonicalJson(receipt)).not.toContain("initial assistant PCM");
    assertLc4XaiFiniteManualGateDReceipt(receipt, {
      expected_plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    });
  });

  it("refuses a stale source before invoking the paid executor", async () => {
    const value = fixture();
    const paid = vi.fn();
    const root = await mkdtemp(join(tmpdir(), "hacc-gate-d-stale-"));
    roots.push(root);
    await expect(executeLc4XaiFiniteManualGateD({
      plan: value.plan,
      authorization: value.authorization,
      terminal_signer: value.terminal,
      credential_identity_sha256: PROVIDER_IDENTITY_SHA256,
      caller_pcm: value.pcm,
      inspected_source: {
        source_commit: "b".repeat(40),
        source_tree_sha256: SOURCE_TREE,
        worktree_clean: true,
      },
      now: NOW,
      completion_clock: () => new Date(NOW.getTime() + 1_000),
      expected_plan_trust_root_sha256:
        value.authority.public_key_fingerprint_sha256,
      invocation_marker_path: join(root, "invocation.json"),
      construct_production_adapter: () => productionAdapter(paid),
    })).rejects.toThrow(/source is stale or dirty/u);
    expect(paid).not.toHaveBeenCalled();
  });

  it("refuses a stale provider-profile expectation", async () => {
    const { receipt, authority } = await passingReceipt();
    expect(() => assertLc4XaiFiniteManualGateDReceipt(receipt, {
      expected_plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256: sha256Hex("stale profile"),
    })).toThrow(/exact finite-manual transport pass/u);
  });

  it("refuses missing manual transport evidence", async () => {
    const value = fixture();
    const root = await mkdtemp(join(tmpdir(), "hacc-gate-d-missing-"));
    roots.push(root);
    const execution = executeLc4XaiFiniteManualGateD({
      plan: value.plan,
      authorization: value.authorization,
      terminal_signer: value.terminal,
      credential_identity_sha256: PROVIDER_IDENTITY_SHA256,
      caller_pcm: value.pcm,
      inspected_source: {
        source_commit: SOURCE_COMMIT,
        source_tree_sha256: SOURCE_TREE,
        worktree_clean: true,
      },
      now: NOW,
      completion_clock: () => new Date(NOW.getTime() + 1_000),
      expected_plan_trust_root_sha256:
        value.authority.public_key_fingerprint_sha256,
      invocation_marker_path: join(root, "invocation.json"),
      construct_production_adapter: () => productionAdapter(async ({ caller_pcm }) => (
        executionEvidence(
          caller_pcm,
          { initial_assistant_pcm_byte_length: 0 },
        )
      )),
    });
    const failure = await execution.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(
      Lc4XaiFiniteManualGateDClaimedFailureError,
    );
    const claimed = failure as Lc4XaiFiniteManualGateDClaimedFailureError;
    expect(claimed.message).not.toContain("PCM");
    expect(claimed.failure.body).toMatchObject({
      status: "failed",
      failure_stage: "execution_evidence_validation",
      failure_class: "audio_output_contract",
      raw_error_retained: false,
      partial_wire_or_execution_evidence_retained: false,
      retry_allowed: false,
    });
    assertLc4XaiFiniteManualGateDFailure(claimed.failure, {
      plan: value.plan,
      authorization: value.authorization,
      invocation_claim: claimed.failure.body.invocation_claim,
      expected_plan_trust_root_sha256:
        value.authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    });
  });

  it("refuses a structurally identical but nominally untrusted adapter", async () => {
    const value = fixture();
    const paid = vi.fn();
    const root = await mkdtemp(join(tmpdir(), "hacc-gate-d-bad-adapter-"));
    roots.push(root);
    const marker = join(root, "invocation.json");
    const construct = vi.fn(() => ({
      kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1",
      production_adapter_binding_sha256:
        LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
      execute: paid,
    } as unknown as Lc4XaiFiniteManualGateDProductionAdapter));
    const execution = executeLc4XaiFiniteManualGateD({
      plan: value.plan,
      authorization: value.authorization,
      terminal_signer: value.terminal,
      credential_identity_sha256: PROVIDER_IDENTITY_SHA256,
      caller_pcm: value.pcm,
      inspected_source: {
        source_commit: SOURCE_COMMIT,
        source_tree_sha256: SOURCE_TREE,
        worktree_clean: true,
      },
      now: NOW,
      completion_clock: () => new Date(NOW.getTime() + 1_000),
      expected_plan_trust_root_sha256:
        value.authority.public_key_fingerprint_sha256,
      invocation_marker_path: marker,
      construct_production_adapter: construct,
    });
    const failure = await execution.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(
      Lc4XaiFiniteManualGateDClaimedFailureError,
    );
    const claimed = failure as Lc4XaiFiniteManualGateDClaimedFailureError;
    expect(claimed.message).not.toContain("provider adapter");
    expect(claimed.failure.body).toMatchObject({
      status: "failed",
      failure_stage: "adapter_construction",
      failure_class: "provider_protocol",
      adapter_construction_sha256: null,
      candidate_pass_receipt_sha256: null,
    });
    expect(construct).toHaveBeenCalledTimes(1);
    expect(await readFile(marker, "utf8"))
      .toContain("claimed_before_provider_adapter_construction");
    expect(paid).not.toHaveBeenCalled();
  });

  it("makes authorization consumption one-shot before provider construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-gate-d-"));
    roots.push(root);
    const marker = join(root, "invocation.json");
    const value = fixture();
    const paid = vi.fn(async ({ caller_pcm }: { caller_pcm: Uint8Array }) => (
      executionEvidence(caller_pcm)
    ));
    const input = {
      plan: value.plan,
      authorization: value.authorization,
      terminal_signer: value.terminal,
      credential_identity_sha256: PROVIDER_IDENTITY_SHA256,
      caller_pcm: value.pcm,
      inspected_source: {
        source_commit: SOURCE_COMMIT,
        source_tree_sha256: SOURCE_TREE,
        worktree_clean: true as const,
      },
      now: NOW,
      completion_clock: () => new Date(NOW.getTime() + 1_000),
      expected_plan_trust_root_sha256:
        value.authority.public_key_fingerprint_sha256,
      invocation_marker_path: marker,
      construct_production_adapter: async () => {
        expect(await readFile(marker, "utf8"))
          .toContain("claimed_before_provider_adapter_construction");
        return productionAdapter(paid);
      },
    };
    await executeLc4XaiFiniteManualGateD(input);
    await expect(executeLc4XaiFiniteManualGateD(input))
      .rejects.toThrow(/already invoked/u);
    expect(paid).toHaveBeenCalledTimes(1);
  });

  it("detects terminal tampering even when the outer receipt hash is recomputed", async () => {
    const { receipt, authority } = await passingReceipt();
    const tamperedBody = {
      ...receipt,
      terminal: {
        ...receipt.terminal,
        body: {
          ...receipt.terminal.body,
          raw_audio_retained: true,
        },
      },
    };
    const withoutHash = withoutReceiptHash(tamperedBody);
    const tampered = {
      ...withoutHash,
      receipt_sha256: sha256Hex(
        `${RECEIPT_DOMAIN}${canonicalJson(withoutHash)}`,
      ),
    } as Lc4XaiFiniteManualGateDReceipt;
    expect(() => assertLc4XaiFiniteManualGateDReceipt(tampered, {
      expected_plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/terminal artifact hash mismatch/u);
  });

  it("cannot substitute a server-VAD receipt for finite-manual Gate D", async () => {
    const { receipt, authority } = await passingReceipt();
    const substitutedBody = {
      ...receipt,
      transport_purpose: "interactive_transport_qualification",
      transport_mode: "provider_native_server_vad",
    };
    const withoutHash = withoutReceiptHash(substitutedBody);
    const substituted = {
      ...withoutHash,
      receipt_sha256: sha256Hex(
        `${RECEIPT_DOMAIN}${canonicalJson(withoutHash)}`,
      ),
    } as unknown as Lc4XaiFiniteManualGateDReceipt;
    expect(() => assertLc4XaiFiniteManualGateDReceipt(substituted, {
      expected_plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/exact finite-manual transport pass/u);
  });

  it("rejects a self-signed package and an arbitrary replay digest", async () => {
    const { receipt, authority } = await passingReceipt();
    const unrelatedAuthority = signer();
    expect(() => assertLc4XaiFiniteManualGateDReceipt(receipt, {
      expected_plan_trust_root_sha256:
        unrelatedAuthority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/trust root mismatch/u);

    const arbitraryReplay = sha256Hex("attacker-chosen-arbitrary-replay");
    const tampered = rehashReceipt({
      ...withoutReceiptHash(receipt),
      execution_replay_sha256: arbitraryReplay,
      execution_evidence: {
        ...receipt.execution_evidence,
        replay_sha256: arbitraryReplay,
      },
    });
    expect(() => assertLc4XaiFiniteManualGateDReceipt(tampered, {
      expected_plan_trust_root_sha256:
        authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/execution replay hash mismatch/u);
  });

  it("rejects a rehashed package with no invocation claim", async () => {
    const { receipt, authority } = await passingReceipt();
    const { invocation_claim: omittedClaim, ...withoutClaim } =
      withoutReceiptHash(receipt);
    void omittedClaim;
    const noClaim = rehashReceipt(
      withoutClaim as Omit<Lc4XaiFiniteManualGateDReceipt, "receipt_sha256">,
    );
    expect(() => assertLc4XaiFiniteManualGateDReceipt(noClaim, {
      expected_plan_trust_root_sha256:
        authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/unexpected or missing fields/u);
  });

  it("rejects one key reused as plan authority and terminal authority", () => {
    const authority = signer();
    const pcm = new Uint8Array([1, 0, 2, 0]);
    const plan = createLc4XaiFiniteManualGateDPlan({
      gate_id: "same-key-rejected",
      prepared_at: NOW.toISOString(),
      source_commit: SOURCE_COMMIT,
      source_tree_sha256: SOURCE_TREE,
      harmless_clip_pcm: pcm,
      signer: authority,
    });
    expect(() => createLc4XaiFiniteManualGateDAuthorization({
      plan,
      plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
      authorization_id: "same-key-auth",
      authorization_nonce_sha256: sha256Hex("same-key-nonce"),
      credential_identity_sha256: PROVIDER_IDENTITY_SHA256,
      terminal_signer: authority,
      not_before: new Date(NOW.getTime() - 1_000).toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      authority_signer: authority,
    })).toThrow(/must be distinct/u);
  });

  it("rejects sanitized execution-preimage and invocation-marker tampering", async () => {
    const { receipt, authority } = await passingReceipt();
    const first = receipt.execution_evidence.wire_observations[0]!;
    const tamperedEvidenceBody = {
      ...receipt.execution_evidence,
      wire_observations: [
        { ...first, payload_bytes: first.payload_bytes + 2 },
        ...receipt.execution_evidence.wire_observations.slice(1),
      ],
    };
    const { replay_sha256: oldReplay, ...withoutReplay } =
      tamperedEvidenceBody;
    void oldReplay;
    const tamperedEvidence = {
      ...withoutReplay,
      replay_sha256:
        lc4XaiFiniteManualGateDExecutionReplaySha256(withoutReplay),
    };
    const preimageTampered = rehashReceipt({
      ...withoutReceiptHash(receipt),
      execution_replay_sha256: tamperedEvidence.replay_sha256,
      execution_evidence: tamperedEvidence,
    });
    expect(() => assertLc4XaiFiniteManualGateDReceipt(preimageTampered, {
      expected_plan_trust_root_sha256:
        authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/exact finite-manual transport pass/u);

    const markerTampered = rehashReceipt({
      ...withoutReceiptHash(receipt),
      invocation_claim: {
        ...receipt.invocation_claim,
        marker_file_sha256: sha256Hex("substituted-marker-file"),
      },
    });
    expect(() => assertLc4XaiFiniteManualGateDReceipt(markerTampered, {
      expected_plan_trust_root_sha256:
        authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/invocation claim hash mismatch|marker file hash mismatch/u);
  });

  it("rejects lifecycle-manifest tampering even after the receipt is rehashed", async () => {
    const { receipt, authority } = await passingReceipt();
    const lifecycleTampered = rehashReceipt({
      ...withoutReceiptHash(receipt),
      package_manifest: {
        ...receipt.package_manifest,
        body: {
          ...receipt.package_manifest.body,
          lifecycle: {
            ...receipt.package_manifest.body.lifecycle,
            provider_execution_sequence: 2,
          } as unknown as typeof receipt.package_manifest.body.lifecycle,
        },
      },
    });
    expect(() => assertLc4XaiFiniteManualGateDReceipt(lifecycleTampered, {
      expected_plan_trust_root_sha256:
        authority.public_key_fingerprint_sha256,
      expected_source_commit: SOURCE_COMMIT,
      expected_source_tree_sha256: SOURCE_TREE,
      expected_provider_profile_manifest_sha256:
        LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    })).toThrow(/package manifest artifact hash mismatch/u);
  });

  it.each([
    ["foreign provider", { provider: "openai" }],
    ["invalid direction", { direction: "sideways" }],
    ["sequence gap", { sequence: 99 }],
    ["connection epoch change", { connection_epoch: 2 }],
    ["predecessor mismatch", {
      previous_observation_sha256: sha256Hex("foreign-predecessor"),
    }],
  ])("rejects an unselected wire-chain %s mutation", (_label, mutation) => {
    const value = fixture();
    const valid = executionEvidence(value.pcm);
    const wire = valid.wire_observations.map((observation, index) => (
      index === 5 ? { ...observation, ...mutation } : observation
    ));
    const {
      replay_sha256: omittedReplay,
      ...validBody
    } = valid;
    void omittedReplay;
    const mutatedBody = {
      ...validBody,
      wire_observations: wire,
    } as unknown as Omit<
      Lc4XaiFiniteManualGateDExecutionEvidence,
      "replay_sha256"
    >;
    const mutated = {
      ...mutatedBody,
      replay_sha256:
        lc4XaiFiniteManualGateDExecutionReplaySha256(mutatedBody),
    };
    expect(() => assertLc4XaiFiniteManualGateDExecutionEvidence({
      evidence: mutated,
      plan: value.plan,
    })).toThrow();
  });
});
