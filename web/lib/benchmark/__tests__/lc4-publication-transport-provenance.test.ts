import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
} from "../lc4-development-qualification-v3";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "../lc4-provider-profiles";
import {
  assertLc4PublicationTransportProvenance,
  verifyLc4PublicationTransportProvenance,
} from "../lc4-publication-transport-provenance";
import {
  assertLc4PublicationTransportReplay,
  createLc4PublicationTransportReplay,
} from "../lc4-publication-transport-replay";
import {
  createLc4ProviderExecutionProfile,
} from "../lc4-production-runner-foundation";
import {
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "../lc4-production-provider-contract";
import {
  LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
  LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
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
  createLc4XaiManualTurnCausality,
  lc4XaiManualResponseWireIdentitySha256,
  type Lc4SanitizedWireObservation,
} from "../lc4-xai-manual-turn-causality";

const H = (value: string | Uint8Array) => sha256Hex(value);
const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_TREE = H("publication-source-tree");
const NOW = new Date("2026-07-28T23:30:00.000Z");
const roots: string[] = [];

function transportReplay() {
  return createLc4PublicationTransportReplay({
    run_sha256: H("publication-run"),
    provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    audio_delivery_profile_sha256: H("publication-audio-delivery"),
    listener_authority_trust_root_sha256:
      H("publication-listener-authority-root"),
    canonical_provider_exchange_count: 360,
    repair_provider_exchange_count: 0,
    total_response_generation_count: 360,
    episodes: (["openai", "gemini", "xai"] as const).flatMap((provider) => {
      const profile = createLc4ProviderExecutionProfile(provider);
      return (["native", "hacc"] as const).map((arm) => ({
        episode_id: `${provider}-${arm}`,
        provider,
        arm,
        model: profile.model,
        transport_purpose: provider === "xai"
          ? "finite_prerecorded_efficacy" as const
          : null,
        transport_mode: "manual_commit" as const,
        transport_profile_sha256:
          profile.transport_profile_sha256 ?? profile.provider_profile_sha256,
        output_audio_lineage_scope: provider === "gemini"
          ? "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable" as const
          : "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact" as const,
        canonical_provider_exchange_count: 60 as const,
        provider_session_count: 6 as const,
        provider_session_replay_set_sha256:
          H(`${provider}-${arm}-provider-session-replay-set`),
        repair_provider_exchange_count: 0,
        total_response_generation_count: 60,
        canonical_exchange_replay_set_sha256:
          H(`${provider}-${arm}-canonical-exchange-replay-set`),
        response_generation_replay_set_sha256:
          H(`${provider}-${arm}-response-generation-replay-set`),
        listener_authority_replay_set_sha256:
          H(`${provider}-${arm}-listener-authority-replay-set`),
        listener_invocation_replay_set_sha256:
          H(`${provider}-${arm}-listener-invocation-replay-set`),
      }));
    }),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
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
  const rootResponseIdSha256 =
    lc4XaiManualResponseWireIdentitySha256("response-id");
  const postToolResponseIdSha256 =
    lc4XaiManualResponseWireIdentitySha256("post-tool-response-id");
  const callIdSha256 = H("publication-call-id");
  let previous: string | null = null;
  return roles.map(([direction, wireType], index) => {
    const sequence = index + 1;
    const payload = H(`payload:${sequence}`);
    const observation = H(canonicalJson({
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
      projection_sha256: H(`projection:${sequence}`),
      observation_sha256: observation,
      previous_observation_sha256: previous,
      identity_hashes: {
        ...([4, 5, 6, 7].includes(sequence)
          ? { responseIdSha256: rootResponseIdSha256 }
          : {}),
        ...([10, 11, 12].includes(sequence)
          ? { responseIdSha256: postToolResponseIdSha256 }
          : {}),
        ...([6, 7, 8].includes(sequence)
          ? { callIdSha256 }
          : {}),
      },
    });
    previous = observation;
    return value;
  });
}

function executionEvidence(
  callerPcm: Uint8Array,
): Lc4XaiFiniteManualGateDExecutionEvidence {
  const observations = wireObservations();
  const withoutReplay = Object.freeze({
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
    caller_pcm_sha256: H(callerPcm),
    caller_pcm_byte_length: callerPcm.byteLength,
    caller_pcm_appended_sha256: H(callerPcm),
    caller_pcm_appended_byte_length: callerPcm.byteLength,
    provider_sessions_opened: 1 as const,
    generation_phases: 2 as const,
    capability_gateway_tool_roundtrips: 1 as const,
    retries: 0 as const,
    reconnects: 0 as const,
    fallbacks: 0 as const,
    operation_order: LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
    manual_turn_causality: createLc4XaiManualTurnCausality({
      schema_version: 1,
      connection_epoch: 1,
      commit_observation_sha256: observations[0]!.observation_sha256,
      commit_sequence: 1,
      commit_ack_observation_sha256: observations[1]!.observation_sha256,
      commit_ack_sequence: 2,
      response_create_observation_sha256:
        observations[2]!.observation_sha256,
      response_create_sequence: 3,
      response_start_observation_sha256:
        observations[3]!.observation_sha256,
      response_start_sequence: 4,
      response_id_sha256:
        lc4XaiManualResponseWireIdentitySha256("response-id"),
    }, observations),
    wire_observations: observations,
    initial_assistant_pcm_sha256: H("initial-output"),
    initial_assistant_pcm_byte_length: 4,
    initial_assistant_pcm_observation_sha256:
      observations[4]!.observation_sha256,
    capability_gateway_tool_call_sha256: H("tool-call"),
    capability_gateway_tool_call_observation_sha256:
      observations[6]!.observation_sha256,
    capability_gateway_tool_result_sha256: H("tool-result"),
    capability_gateway_tool_result_observation_sha256:
      observations[7]!.observation_sha256,
    post_tool_continuation_sha256: H("continuation"),
    post_tool_continuation_observation_sha256:
      observations[8]!.observation_sha256,
    post_tool_response_start_observation_sha256:
      observations[9]!.observation_sha256,
    post_tool_assistant_pcm_sha256: H("continued-output"),
    post_tool_assistant_pcm_byte_length: 4,
    post_tool_assistant_pcm_observation_sha256:
      observations[10]!.observation_sha256,
    capability_gateway_call_id_sha256: H("publication-call-id"),
    post_tool_continuation_origin_response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("response-id"),
    post_tool_response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("post-tool-response-id"),
    terminal_observation_sha256: observations[11]!.observation_sha256,
  });
  return Object.freeze({
    ...withoutReplay,
    replay_sha256:
      lc4XaiFiniteManualGateDExecutionReplaySha256(withoutReplay),
  });
}

async function signedReceipt(): Promise<Readonly<{
  receipt: Lc4XaiFiniteManualGateDReceipt;
  trustRoot: string;
  invocationMarkerPath: string;
}>> {
  const root = await mkdtemp(resolve(tmpdir(), "hacc-publication-gate-d-run-"));
  roots.push(root);
  const authority = signer();
  const terminal = signer();
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  const plan = createLc4XaiFiniteManualGateDPlan({
    gate_id: "publication-gate-d",
    prepared_at: NOW.toISOString(),
    source_commit: SOURCE_COMMIT,
    source_tree_sha256: SOURCE_TREE,
    harmless_clip_pcm: pcm,
    signer: authority,
  });
  const authorization = createLc4XaiFiniteManualGateDAuthorization({
    plan,
    plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
    authorization_id: "publication-gate-d-auth",
    authorization_nonce_sha256: H("publication-nonce"),
    credential_identity_sha256: H("publication-credential"),
    terminal_signer: terminal,
    not_before: new Date(NOW.getTime() - 1_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    authority_signer: authority,
  });
  const invocationMarkerPath = resolve(root, "invocation-claim.json");
  const receipt = await executeLc4XaiFiniteManualGateD({
    plan,
    authorization,
    terminal_signer: terminal,
    credential_identity_sha256: H("publication-credential"),
    caller_pcm: pcm,
    inspected_source: {
      source_commit: SOURCE_COMMIT,
      source_tree_sha256: SOURCE_TREE,
      worktree_clean: true,
    },
    now: NOW,
    completion_clock: () => new Date(NOW.getTime() + 1),
    expected_plan_trust_root_sha256:
      authority.public_key_fingerprint_sha256,
    invocation_marker_path: invocationMarkerPath,
    construct_production_adapter: async () => ({
      [LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY]: true as const,
      kind: [
        "lc4-production-provider-adapter/",
        "xai",
        "-finite-manual-gate-d-v1",
      ].join("") as Lc4XaiFiniteManualGateDProductionAdapter["kind"],
      production_adapter_binding_sha256:
        LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
      execute: async ({ caller_pcm }) => executionEvidence(caller_pcm),
    }),
  });
  return {
    receipt,
    trustRoot: authority.public_key_fingerprint_sha256,
    invocationMarkerPath,
  };
}

function custody(
  receipt: Lc4XaiFiniteManualGateDReceipt,
  trustRoot: string,
) {
  const prepare = {
    source_commit: SOURCE_COMMIT,
    source_tree_sha256: SOURCE_TREE,
    provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    qualification_transport_scope_sha256:
      LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    qualification_claim_boundary:
      "retained_gate_b_transports_only_xai_finite_manual_not_qualified",
    xai_finite_manual_transport_qualification:
      "receipt_bound_pending_preflight_replay",
    xai_finite_manual_gate_d: {
      receipt_sha256: receipt.receipt_sha256,
      plan_authority_trust_root_sha256: trustRoot,
      transport_profile_sha256: receipt.transport_profile_sha256,
    },
    audio_delivery_profile_sha256: H("publication-audio-delivery"),
  };
  const setupResults = [
    {
      provider: "openai",
      model: LC4_PROVIDER_PROFILE_MANIFEST.providers.openai.model,
      status: "passed",
      code: "configuration_echo_verified",
    },
    {
      provider: "gemini",
      model: LC4_PROVIDER_PROFILE_MANIFEST.providers.gemini.model,
      status: "passed",
      code: "setup_accepted_without_field_echo",
    },
    {
      provider: "xai",
      model: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model,
      status: "passed",
      code: "configuration_accepted_partial_echo",
      configurationEvidence: { fields: { model: { status: "verified" } } },
    },
  ];
  const preflight = {
    authority_trust_root_sha256:
      H("publication-listener-authority-root"),
    provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    qualification_transport_scope_sha256:
      LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    qualification_claim_boundary:
      "retained_gate_b_transports_only_xai_finite_manual_not_qualified",
    qualification_scope_verified: true,
    all_episode_transports_qualified: true,
    xai_finite_manual_transport_qualification: "verified",
    xai_finite_manual_gate_d_receipt_sha256: receipt.receipt_sha256,
    xai_finite_manual_gate_d_transport_profile_sha256:
      receipt.transport_profile_sha256,
    xai_finite_manual_gate_d_claim_boundary:
      "transport_qualification_only_not_efficacy_evidence",
    xai_finite_manual_gate_d: receipt,
    qualification: {
      receipt_sha256: H("retained-gate-b"),
      setup_qualification: { results: setupResults },
      spoken_gate_evidence: [
        {
          provider: "openai",
          model: LC4_PROVIDER_PROFILE_MANIFEST.providers.openai.model,
          turn_boundary_mode: "manual_commit",
          replay_sha256: H("openai-retained-spoken-replay"),
        },
        {
          provider: "gemini",
          model: LC4_PROVIDER_PROFILE_MANIFEST.providers.gemini.model,
          turn_boundary_mode: "provider_activity_markers",
          replay_sha256: H("gemini-retained-spoken-replay"),
        },
      ],
    },
  };
  return { prepare, preflight };
}

describe("LC4 publication transport provenance custody", () => {
  it("replays one signed exact-source Gate D receipt and derives public cells", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "hacc-publication-gate-d-"));
    roots.push(root);
    const { receipt, trustRoot, invocationMarkerPath } = await signedReceipt();
    const receiptPath = resolve(root, "receipt.json");
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`, { mode: 0o444 });
    const { prepare, preflight } = custody(receipt, trustRoot);
    const provenance = await verifyLc4PublicationTransportProvenance({
      prepare: prepare as never,
      preflight: preflight as never,
      run_sha256: H("publication-run"),
      authority_trust_root_sha256:
        H("publication-listener-authority-root"),
      transport_replay: transportReplay(),
      gate_d: {
        receipt_path: receiptPath,
        invocation_marker_path: invocationMarkerPath,
        plan_trust_root_sha256: trustRoot,
      },
    });
    expect(provenance).toMatchObject({
      schema_version: 5,
      retained_gate_b_receipt_sha256: H("retained-gate-b"),
      xai_finite_manual_transport_qualification: "verified",
      xai_finite_manual_gate_d_receipt_sha256: receipt.receipt_sha256,
      opportunity_accounting: {
        calls: 6,
        opportunities_per_call: 60,
        repeated_opportunity_observations: 360,
        opportunities_are_independent_trials: false,
      },
      semantic_accounting: {
        semantic_acts_per_call: 3,
        opportunities_per_semantic_act: 20,
      },
      transport_accounting: {
        provider_sessions_per_call: 6,
        provider_sessions: 36,
        planned_provider_session_transitions_per_call: 5,
        planned_provider_session_transitions: 30,
        opportunities_per_provider_session: 10,
        unplanned_reconnects: 0,
      },
      provider_session_count: 36,
    });
    expect(provenance.provider_session_replay_set_sha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.cells).toHaveLength(6);
    expect(provenance.cells.find((cell) =>
      cell.provider === "gemini" && cell.arm === "native"))
      .toMatchObject({
        transport_purpose: null,
        turn_boundary_control: "client_explicit",
        wire_turn_boundary: "activityStart_audio_activityEnd",
        semantic_act_count: 3,
        opportunities_per_semantic_act: 20,
        provider_session_count: 6,
        planned_provider_session_transition_count: 5,
        opportunities_per_provider_session: 10,
        unplanned_reconnect_count: 0,
        provider_session_replay_set_sha256:
          H("gemini-native-provider-session-replay-set"),
        model_identity_verification: "request_only",
        qualification_scope:
          "retained_gate_b_provider_setup_and_spoken_roundtrip",
        qualification_replay_sha256:
          H("gemini-retained-spoken-replay"),
      });
    expect(provenance.canonical_provider_exchange_count).toBe(360);
    for (const provider of ["openai", "gemini", "xai"] as const) {
      const profile = createLc4ProviderExecutionProfile(provider);
      const cells = provenance.cells.filter((cell) =>
        cell.provider === provider);
      expect(cells).toHaveLength(2);
      expect(cells.every((cell) =>
        cell.transport_profile_sha256
          === (profile.transport_profile_sha256
            ?? profile.provider_profile_sha256))).toBe(true);
      expect(cells.every((cell) =>
        cell.turn_boundary_control === "client_explicit"
        && cell.wire_turn_boundary === profile.turn_boundary)).toBe(true);
    }

    const callsDrift = structuredClone(provenance);
    (callsDrift.opportunity_accounting as { calls: number }).calls = 24;
    expect(() => assertLc4PublicationTransportProvenance(callsDrift))
      .toThrow(/incomplete or inconsistent/u);

    const sessionDrift = structuredClone(provenance);
    (sessionDrift.transport_accounting as {
      provider_sessions: number;
    }).provider_sessions = 30;
    expect(() => assertLc4PublicationTransportProvenance(sessionDrift))
      .toThrow(/incomplete or inconsistent/u);

    const cellSessionDrift = structuredClone(provenance);
    (cellSessionDrift.cells[0] as {
      provider_session_count: number;
    }).provider_session_count = 5;
    expect(() => assertLc4PublicationTransportProvenance(cellSessionDrift))
      .toThrow(/incomplete or inconsistent/u);

    const sessionReplayDrift = structuredClone(provenance);
    (sessionReplayDrift.cells[0] as {
      provider_session_replay_set_sha256: string;
    }).provider_session_replay_set_sha256 =
      H("substituted-provider-session-replay-set");
    expect(() => assertLc4PublicationTransportProvenance(sessionReplayDrift))
      .toThrow(/incomplete or inconsistent/u);
  });

  it("rejects an operator-supplied listener authority root that differs from retained custody", async () => {
    const root = await mkdtemp(resolve(
      tmpdir(),
      "hacc-publication-authority-root-",
    ));
    roots.push(root);
    const { receipt, trustRoot, invocationMarkerPath } = await signedReceipt();
    const receiptPath = resolve(root, "receipt.json");
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`, {
      mode: 0o444,
    });
    const { prepare, preflight } = custody(receipt, trustRoot);
    await expect(verifyLc4PublicationTransportProvenance({
      prepare: prepare as never,
      preflight: preflight as never,
      run_sha256: H("publication-run"),
      authority_trust_root_sha256:
        H("substituted-listener-authority-root"),
      transport_replay: transportReplay(),
      gate_d: {
        receipt_path: receiptPath,
        invocation_marker_path: invocationMarkerPath,
        plan_trust_root_sha256: trustRoot,
      },
    })).rejects.toThrow(/listener authority|qualification scope/u);
  });

  it("rejects copied, linked, symlinked, mode-changed, and tampered invocation markers", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "hacc-publication-gate-d-"));
    roots.push(root);
    const { receipt, trustRoot, invocationMarkerPath } = await signedReceipt();
    const receiptPath = resolve(root, "receipt.json");
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`, { mode: 0o444 });
    const { prepare, preflight } = custody(receipt, trustRoot);
    const verify = (invocation_marker_path: string) =>
      verifyLc4PublicationTransportProvenance({
        prepare: prepare as never,
        preflight: preflight as never,
        run_sha256: H("publication-run"),
        authority_trust_root_sha256:
          H("publication-listener-authority-root"),
        transport_replay: transportReplay(),
        gate_d: {
          receipt_path: receiptPath,
          invocation_marker_path,
          plan_trust_root_sha256: trustRoot,
        },
      });
    const exactCopyPath = resolve(root, "copied-invocation-marker.json");
    const originalBytes = await readFile(invocationMarkerPath);
    await writeFile(exactCopyPath, originalBytes, { mode: 0o400 });
    await expect(verify(exactCopyPath)).rejects.toThrow(
      /invocation marker differs from the signed one-shot package/u,
    );

    const symlinkPath = resolve(root, "symlinked-invocation-marker.json");
    await symlink(invocationMarkerPath, symlinkPath);
    await expect(verify(symlinkPath)).rejects.toThrow(
      /private bounded regular, non-linked file/u,
    );

    const hardlinkPath = resolve(root, "hardlinked-invocation-marker.json");
    await link(invocationMarkerPath, hardlinkPath);
    await expect(verify(invocationMarkerPath)).rejects.toThrow(
      /private bounded regular, non-linked file/u,
    );
    await unlink(hardlinkPath);

    await chmod(invocationMarkerPath, 0o600);
    await expect(verify(invocationMarkerPath)).rejects.toThrow(
      /invocation marker differs from the signed one-shot package/u,
    );
    await chmod(invocationMarkerPath, 0o400);

    await chmod(invocationMarkerPath, 0o600);
    await writeFile(
      invocationMarkerPath,
      Buffer.concat([originalBytes, Buffer.from(" ", "utf8")]),
    );
    await chmod(invocationMarkerPath, 0o400);
    await expect(verify(invocationMarkerPath)).rejects.toThrow(
      /invocation marker differs from the signed one-shot package/u,
    );
  });

  it("rejects a freshly self-hashed alternate profile and per-cell replay substitution", async () => {
    const validReplay = transportReplay();
    const replaySessionCountDrift = structuredClone(validReplay);
    (replaySessionCountDrift.episodes[0] as {
      provider_session_count: number;
    }).provider_session_count = 5;
    expect(() =>
      assertLc4PublicationTransportReplay(replaySessionCountDrift as never))
      .toThrow(/incomplete, substituted/u);

    const replaySessionRootDrift = structuredClone(validReplay);
    (replaySessionRootDrift.episodes[0] as {
      provider_session_replay_set_sha256: string;
    }).provider_session_replay_set_sha256 =
      H("substituted-provider-session-replay-set");
    expect(() =>
      assertLc4PublicationTransportReplay(replaySessionRootDrift))
      .toThrow(/incomplete, substituted/u);
    const alternateEpisodes = structuredClone(validReplay.episodes) as Array<{
      transport_profile_sha256: string;
    } & (typeof validReplay.episodes)[number]>;
    alternateEpisodes[0]!.transport_profile_sha256 =
      H("alternate-self-hashed-profile");
    expect(() => createLc4PublicationTransportReplay({
      run_sha256: validReplay.run_sha256,
      provider_profile_manifest_sha256:
        validReplay.provider_profile_manifest_sha256,
      audio_delivery_profile_sha256:
        validReplay.audio_delivery_profile_sha256,
      listener_authority_trust_root_sha256:
        validReplay.listener_authority_trust_root_sha256,
      canonical_provider_exchange_count: 360,
      repair_provider_exchange_count:
        validReplay.repair_provider_exchange_count,
      total_response_generation_count:
        validReplay.total_response_generation_count,
      episodes: alternateEpisodes,
    })).toThrow(/alternate profile/u);

    const root = await mkdtemp(resolve(tmpdir(), "hacc-publication-gate-d-"));
    roots.push(root);
    const { receipt, trustRoot, invocationMarkerPath } = await signedReceipt();
    const receiptPath = resolve(root, "receipt.json");
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`, { mode: 0o444 });
    const { prepare, preflight } = custody(receipt, trustRoot);
    const provenance = await verifyLc4PublicationTransportProvenance({
      prepare: prepare as never,
      preflight: preflight as never,
      run_sha256: H("publication-run"),
      authority_trust_root_sha256:
        H("publication-listener-authority-root"),
      transport_replay: validReplay,
      gate_d: {
        receipt_path: receiptPath,
        invocation_marker_path: invocationMarkerPath,
        plan_trust_root_sha256: trustRoot,
      },
    });
    const substituted = structuredClone(provenance) as unknown as {
      cells: Array<{ canonical_exchange_replay_set_sha256: string }>;
    } & typeof provenance;
    substituted.cells[0]!.canonical_exchange_replay_set_sha256 =
      H("substituted-canonical-exchange-set");
    expect(() => assertLc4PublicationTransportProvenance(substituted))
      .toThrow(/incomplete or inconsistent/u);
  });

  it("rejects source, tree, trust, profile, and preflight receipt substitution", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "hacc-publication-gate-d-"));
    roots.push(root);
    const { receipt, trustRoot, invocationMarkerPath } = await signedReceipt();
    const receiptPath = resolve(root, "receipt.json");
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`, { mode: 0o444 });
    const base = custody(receipt, trustRoot);
    const attempts = [
      {
        ...base,
        prepare: { ...base.prepare, source_commit: "b".repeat(40) },
        trustRoot,
      },
      {
        ...base,
        prepare: { ...base.prepare, source_tree_sha256: H("different-tree") },
        trustRoot,
      },
      {
        ...base,
        trustRoot: H("different-trust-root"),
      },
      {
        ...base,
        prepare: {
          ...base.prepare,
          xai_finite_manual_gate_d: {
            ...base.prepare.xai_finite_manual_gate_d,
            transport_profile_sha256: H("different-profile"),
          },
        },
        trustRoot,
      },
      {
        ...base,
        preflight: {
          ...base.preflight,
          xai_finite_manual_gate_d_receipt_sha256:
            H("different-preflight-receipt"),
        },
        trustRoot,
      },
    ];
    for (const attempt of attempts) {
      await expect(verifyLc4PublicationTransportProvenance({
        prepare: attempt.prepare as never,
        preflight: attempt.preflight as never,
        run_sha256: H("publication-run"),
        authority_trust_root_sha256:
          H("publication-listener-authority-root"),
        transport_replay: transportReplay(),
        gate_d: {
          receipt_path: receiptPath,
          invocation_marker_path: invocationMarkerPath,
          plan_trust_root_sha256: attempt.trustRoot,
        },
      })).rejects.toThrow();
    }
  });
});
