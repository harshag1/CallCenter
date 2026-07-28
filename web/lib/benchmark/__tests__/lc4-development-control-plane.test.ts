import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import { createBenchmarkKernelAttestationSigner } from "../kernel-attestation";
import {
  LC4_DEV_PINNED_VOICE,
  materializeLc4DevelopmentAudio,
  type Lc4DevAudioRenderer,
} from "../lc4-development-audio-materializer";
import {
  appendLc4DevNativeGatewayContract,
  renderLc4DevHaccResponsePlan,
} from "../lc4-development-gateway-bridge";
import {
  LC4_DEV_DURABLE_WORKER_PLAN_SHA256,
  LC4_DEV_MUNICIPAL_CONDITION_SUITE,
  LC4_DEV_MUNICIPAL_FLOW,
  LC4_DEV_MUNICIPAL_SCENARIO,
  createLc4DevMunicipalControlPlane,
} from "../lc4-development-control-plane";
import { assertHaccResponsePlan } from "../response-plan";
import type { Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import {
  createLc4DevCallerBranchAuthority,
  createLc4DevCallerBranchMatrixArtifact,
  lc4DevBranchedOpportunity,
} from "../lc4-development-caller-branch";

let root = "";
let artifacts: Awaited<ReturnType<typeof materializeLc4DevelopmentAudio>>;

function pcm(sampleRate: 16_000 | 24_000 | 48_000, seed: number): Uint8Array {
  const samples = Math.floor(sampleRate * 0.12);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin((index + seed) / 11) * 7_000), true);
  }
  return bytes;
}

function renderer(): Lc4DevAudioRenderer {
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
      return Object.freeze({ master48k: pcm(48_000, seed), pcm16k: pcm(16_000, seed), pcm24k: pcm(24_000, seed) });
    },
  });
}

function episode(arm: "native" | "hacc"): Lc4DevLiveEpisodePlan {
  return Object.freeze({
    episode_id: `lc4-dev-openai-${arm}`,
    pair_id: "lc4-dev-openai",
    pair_position: arm === "native" ? 1 : 2,
    provider: "openai",
    arm,
    model: "gpt-realtime-2.1",
    voice: "marin",
    maximum_micro_usd: 1_000_000,
    opportunity_binding_set_sha256: "b".repeat(64),
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lc4-control-plane-"));
  artifacts = await materializeLc4DevelopmentAudio({ outputRoot: join(root, "audio"), renderer: renderer() });
}, 30_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("LC4-DEV municipal executable control plane", () => {
  it("compiles the exact 60-opportunity corpus into six host-managed Flow stages", () => {
    expect(LC4_DEV_MUNICIPAL_SCENARIO.caller.turns).toHaveLength(60);
    expect(LC4_DEV_MUNICIPAL_FLOW.nodes.find((node) => node.id === "oral_history")?.steps).toHaveLength(6);
    expect(LC4_DEV_MUNICIPAL_CONDITION_SUITE.conditions["host-managed-harness"].behavior.transitionOwnership).toBe("host-managed-linear");
    expect(LC4_DEV_MUNICIPAL_CONDITION_SUITE.conditions["raw-full"].behavior.enforceExactlyOnce).toBe(false);
    expect(LC4_DEV_DURABLE_WORKER_PLAN_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("runs both 60-turn arms with parity-bound public state and real gateway, ToolWorld, worker, fault, reconciliation, and CRP receipts", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createBenchmarkKernelAttestationSigner({
      keyId: "lc4-dev-control-test",
      privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const control = createLc4DevMunicipalControlPlane({
      audio_manifest: artifacts.manifest,
      repair_manifest: artifacts.repairManifest,
      signer,
      now: () => new Date("2026-07-21T22:00:00.000Z"),
    });
    const corpus = createLc4PublicDevelopmentCorpus();
    const nativeContinuity: string[] = [];
    const haccContinuity: string[] = [];
    const gatewayReceipts: string[] = [];
    const gatewayReceiptsByArm = { native: [] as string[], hacc: [] as string[] };
    const landmarkActionsByArm = { native: [] as string[], hacc: [] as string[] };
    const semanticActionsByArm = { native: [] as string[], hacc: [] as string[] };
    let haccAmbiguousPlanSha256: string | null = null;
    for (const arm of ["native", "hacc"] as const) {
      const plan = episode(arm);
      let previous: string | null = null;
      for (const opportunity of corpus.opportunities) {
        const receipt = await control.next({ episode: plan, opportunity, previous_exchange_sha256: previous });
        expect(receipt.control_receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(receipt.response_control.kind).toBe(arm === "hacc" ? "hacc_response_plan" : "native_context");
        let currentPreparation = control.gateway_executor.currentResponsePreparation({
          episode: plan,
          opportunity,
          phase: "canonical",
        });
        expect(currentPreparation.contextSha256).toBe(
          sha256Hex(currentPreparation.additionalInstructions),
        );
        const repairPreparation = control.gateway_executor.currentResponsePreparation({
          episode: plan,
          opportunity,
          phase: "repair",
        });
        expect(repairPreparation.contextSha256).toBe(
          sha256Hex(repairPreparation.additionalInstructions),
        );
        expect(repairPreparation.contextSha256).not.toBe(currentPreparation.contextSha256);
        (arm === "hacc" ? haccContinuity : nativeContinuity).push(receipt.native_continuity_state_sha256);
        let callSequence = 0;
        for (;;) {
          if (callSequence > 32) throw new Error(`gateway drain did not converge: ${plan.arm}:${opportunity.id}`);
          const calls = control.development_pending_calls(plan.episode_id);
          if (calls.length === 0) break;
          for (const call of calls) {
            callSequence += 1;
            expect(call.opportunity_id).toBe(opportunity.id);
            expect(call.target_arguments).toEqual({});
            if ([30, 35, 42, 43].includes(opportunity.index)) {
              const hiddenArgument: Readonly<Record<string, string>> = call.target_tool === "archive.submit_transcript_request"
                ? { request_id: "model-forged-request" }
                : call.target_tool === "archive.reconcile_transcript_request"
                  ? { invocation_id: "model-forged-invocation" }
                  : { model_owned_slot: "forbidden" };
              const rejected = await control.gateway_executor.execute({
                bridge_version: "lc4-dev-gateway-bridge-v2",
                episode_id: plan.episode_id,
                opportunity_id: opportunity.id,
                opportunity_index: opportunity.index,
                provider: plan.provider,
                arm: plan.arm,
                provider_call_id: `test.${plan.arm}.${opportunity.id}.hidden.${callSequence}`,
                provider_response_id: `response.${plan.arm}.${opportunity.id}`,
                semantic_intent: call.semantic_intent,
                target_tool: call.target_tool,
                target_arguments: hiddenArgument,
                request_sha256: sha256Hex(`request:${plan.arm}:${opportunity.id}:hidden:${callSequence}`),
                provider_provenance_sha256: sha256Hex(`provenance:${plan.arm}:${opportunity.id}:hidden:${callSequence}`),
              });
              expect(rejected).toMatchObject({
                disposition: "rejected",
                provider_output: { code: "host_bound_argument_override" },
                authority_projection: { effective_arguments: null },
              });
            }
            const gateway = await control.gateway_executor.execute({
              bridge_version: "lc4-dev-gateway-bridge-v2",
              episode_id: plan.episode_id,
              opportunity_id: opportunity.id,
              opportunity_index: opportunity.index,
              provider: plan.provider,
              arm: plan.arm,
              provider_call_id: `test.${plan.arm}.${opportunity.id}.${callSequence}`,
              provider_response_id: `response.${plan.arm}.${opportunity.id}`,
              semantic_intent: call.semantic_intent,
              target_tool: call.target_tool,
              target_arguments: call.target_arguments,
              request_sha256: sha256Hex(`request:${plan.arm}:${opportunity.id}:${callSequence}`),
              provider_provenance_sha256: sha256Hex(`provenance:${plan.arm}:${opportunity.id}:${callSequence}`),
            });
            const eligible = receipt.response_control.kind === "hacc_response_plan"
              ? receipt.response_control.plan.eligible_actions.join(",")
              : "native-full";
            expect(gateway.disposition, `${plan.arm}:${opportunity.id}:${call.target_tool}:eligible=${eligible}:${JSON.stringify(gateway.provider_output)}`).not.toBe("rejected");
            const reboundPreparation = control.gateway_executor.currentResponsePreparation({
              episode: plan,
              opportunity,
              phase: "canonical",
            });
            expect(reboundPreparation.contextSha256).toBe(
              sha256Hex(reboundPreparation.additionalInstructions),
            );
            if (gateway.authority_projection.post_transition_response_control_sha256 !== null) {
              const providerOutput = gateway.provider_output as Record<string, unknown>;
              const responseControl = providerOutput.response_control as Record<string, unknown>;
              const expectedInstructions = responseControl.kind === "hacc_response_plan"
                ? renderLc4DevHaccResponsePlan(
                    assertHaccResponsePlan(responseControl.plan),
                    "canonical",
                  )
                : appendLc4DevNativeGatewayContract(
                    responseControl.instructions as string,
                    "canonical",
                  );
              expect(reboundPreparation.additionalInstructions).toBe(expectedInstructions);
            }
            currentPreparation = reboundPreparation;
            semanticActionsByArm[arm].push(`${call.semantic_intent}:${call.target_tool}`);
            if ([30, 35, 42, 43].includes(opportunity.index)) {
              landmarkActionsByArm[arm].push(`${opportunity.index}:${call.semantic_intent}:${call.target_tool}`);
              expect(gateway.authority_projection.model_arguments).toEqual({});
              expect(gateway.authority_projection.effective_arguments).not.toEqual({});
              expect(gateway.authority_projection.post_transition_response_plan_sha256).toMatch(/^[a-f0-9]{64}$/u);
              expect(gateway.authority_projection.post_transition_response_control_sha256).toMatch(/^[a-f0-9]{64}$/u);
            }
            if (plan.arm === "hacc" && opportunity.index === 35
              && call.target_tool === "archive.submit_transcript_request") {
              expect(gateway.provider_output).toMatchObject({
                authoritative_outcome: { outcome_classification: "indeterminate_reconciliation_required" },
                speech_directive: "reconcile_before_any_terminal_claim",
                hacc_response_plan: {
                  recovery_state: "ambiguity_quarantine",
                  response_mode: "reconcile",
                  prohibited_claims: expect.arrayContaining([
                    "retry_ambiguous_commit",
                    "terminal_success_while_reconciliation_pending",
                  ]),
                },
              });
              haccAmbiguousPlanSha256 = gateway.authority_projection.post_transition_response_plan_sha256;
            }
            if (plan.arm === "hacc" && opportunity.index === 42
              && call.target_tool === "archive.reconcile_transcript_request") {
              expect(gateway.provider_output).toMatchObject({
                authoritative_outcome: { receipt_status: "succeeded" },
                speech_directive: "confirm_only_from_authoritative_reconciliation_receipt",
                hacc_response_plan: {
                  recovery_state: "none",
                  eligible_actions: expect.arrayContaining([
                    "archive.observe_worker_result",
                    "archive.complete_stage",
                  ]),
                },
              });
              expect(gateway.authority_projection.post_transition_response_plan_sha256).not.toBe(haccAmbiguousPlanSha256);
            }
            if (plan.arm === "native" && call.target_tool === "archive.submit_transcript_request") {
              expect(gateway.provider_output).toMatchObject({
                gateway_result: {
                  ok: false,
                  reconciliation: { required: true, source: "host_bound_from_authoritative_mutation_receipt" },
                },
                authoritative_outcome: { outcome_classification: "indeterminate_reconciliation_required" },
                speech_directive: "reconcile_before_any_terminal_claim",
                response_control: { kind: "native_context" },
              });
            }
            if (plan.arm === "native" && call.target_tool === "archive.reconcile_transcript_request") {
              expect(call.target_arguments).toEqual({});
              expect(gateway.provider_output).toMatchObject({
                authoritative_outcome: { receipt_status: "succeeded" },
                speech_directive: "confirm_only_from_authoritative_reconciliation_receipt",
                response_control: { kind: "native_context" },
              });
            }
            gatewayReceipts.push(gateway.authoritative_receipt_sha256);
            gatewayReceiptsByArm[arm].push(gateway.authoritative_receipt_sha256);
          }
        }
        previous = sha256Hex(`provider-exchange:${plan.episode_id}:${opportunity.id}`);
      }
    }
    expect(haccContinuity).toEqual(nativeContinuity);

    const native = control.snapshot("lc4-dev-openai-native");
    const hacc = control.snapshot("lc4-dev-openai-hacc");
    for (const snapshot of [native, hacc]) {
      expect(snapshot.opportunities).toBe(60);
      expect(snapshot.worker.jobs).toHaveLength(4);
      expect(snapshot.worker.receipts.some((receipt) => receipt.kind === "lineage.rehydrated")).toBe(true);
      expect(snapshot.worker.receipts.some((receipt) => receipt.kind === "result.rejected" && receipt.body.reason === "stale")).toBe(true);
      expect(snapshot.worker.receipts.some((receipt) => receipt.kind === "result.rejected" && receipt.body.reason === "duplicate")).toBe(true);
      expect(snapshot.world.receipts.filter((receipt) => receipt.tool === "archive.submit_transcript_request")).toHaveLength(1);
      expect(snapshot.world.receipts.find((receipt) => receipt.tool === "archive.submit_transcript_request")?.status).toBe("committed_after_error");
      expect(snapshot.caller_branch_prior_receipt).toMatchObject({
        semantic_opportunity_id: "lc4-dev-op-35",
        tool: "archive.submit_transcript_request",
        outcome: "committed_after_error",
        receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      if (snapshot.arm === "native") {
        expect(snapshot.world.receipts.some((receipt) => receipt.tool === "archive.reconcile_transcript_request" && receipt.status === "succeeded")).toBe(true);
      } else {
        // HACC reconciliation is settled inside the ambiguity-quarantine
        // kernel and committed to its signed transcript, not replayed as a
        // second ToolWorld mutation receipt.
        expect(gatewayReceiptsByArm.hacc.length).toBeGreaterThanOrEqual(10);
      }
      expect(snapshot.world.facts.transcript_request_attempts).toBe(1);
      expect(snapshot.world.facts.room_reservation_count).toBe(0);
      expect(snapshot.repair_state.plan_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(snapshot.pending_gateway_actions, JSON.stringify(snapshot.pending_gateway_obligations)).toBe(0);
    }
    expect(native.common_state_sha256).toBe(hacc.common_state_sha256);
    // Quarantine deliberately orders reconciliation before unrelated pending
    // effects. Prove arm-neutral semantics by comparing the complete semantic
    // action multiset, while the equal final authoritative state and equal
    // receipt cardinality below prove no effect was changed, dropped, or
    // duplicated by that safety-preserving reorder.
    expect([...semanticActionsByArm.hacc].sort()).toEqual([...semanticActionsByArm.native].sort());
    expect(landmarkActionsByArm.hacc).toEqual(expect.arrayContaining([
      "30:launch_async_worker:archive.launch_worker",
      "30:complete_current_stage:archive.complete_stage",
      "35:submit_accessible_transcript:archive.submit_transcript_request",
      "42:reconcile_accessible_transcript:archive.reconcile_transcript_request",
      "43:record_async_worker_result:archive.observe_worker_result",
    ]));
    expect(gatewayReceipts.length).toBeGreaterThan(10);
    expect(gatewayReceiptsByArm.hacc.length).toBe(gatewayReceiptsByArm.native.length);
    expect(hacc.world.facts).toEqual(native.world.facts);
    expect(new Set(gatewayReceipts).size).toBe(gatewayReceipts.length);
    expect(native.gateway_transcript_sha256).not.toBe(hacc.gateway_transcript_sha256);
    expect(control.manifest.native_information_parity).toBe("full_equivalent_policy_and_accumulated_public_state");
    expect(control.manifest.manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
  }, 30_000);

  it("keeps running when the model requests reconciliation after omitting the original mutation", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createBenchmarkKernelAttestationSigner({
      keyId: "lc4-dev-missing-mutation-test",
      privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const control = createLc4DevMunicipalControlPlane({
      audio_manifest: artifacts.manifest,
      repair_manifest: artifacts.repairManifest,
      signer,
      now: () => new Date("2026-07-21T22:00:00.000Z"),
    });
    const corpus = createLc4PublicDevelopmentCorpus();
    const plan = episode("hacc");
    let previous: string | null = null;
    let callSequence = 0;
    let rejectedReconciliation: Awaited<ReturnType<typeof control.gateway_executor.execute>> | null = null;
    let rejectedLateMutation: Awaited<ReturnType<typeof control.gateway_executor.execute>> | null = null;

    for (const opportunity of corpus.opportunities) {
      if (opportunity.index === 42) {
        expect(control.callerBranchPriorReceipt(plan.episode_id)).toEqual({
          semantic_opportunity_id: "lc4-dev-op-35",
          tool: "archive.submit_transcript_request",
          outcome: "no_call",
          receipt_sha256: null,
        });
      }
      await control.next({ episode: plan, opportunity, previous_exchange_sha256: previous });

      if (opportunity.events.some((event) => event.kind === "authoritative-reconciliation")) {
        callSequence += 1;
        rejectedLateMutation = await control.gateway_executor.execute({
          bridge_version: "lc4-dev-gateway-bridge-v2",
          episode_id: plan.episode_id,
          opportunity_id: opportunity.id,
          opportunity_index: opportunity.index,
          provider: plan.provider,
          arm: plan.arm,
          provider_call_id: `test.missing-mutation.late-submit.${callSequence}`,
          provider_response_id: `response.missing-mutation.${opportunity.id}`,
          semantic_intent: "submit_accessible_transcript",
          target_tool: "archive.submit_transcript_request",
          target_arguments: {},
          request_sha256: sha256Hex(`request:missing-mutation:late-submit:${callSequence}`),
          provider_provenance_sha256: sha256Hex(`provenance:missing-mutation:late-submit:${callSequence}`),
        });
        callSequence += 1;
        rejectedReconciliation = await control.gateway_executor.execute({
          bridge_version: "lc4-dev-gateway-bridge-v2",
          episode_id: plan.episode_id,
          opportunity_id: opportunity.id,
          opportunity_index: opportunity.index,
          provider: plan.provider,
          arm: plan.arm,
          provider_call_id: `test.missing-mutation.reconcile.${callSequence}`,
          provider_response_id: `response.missing-mutation.${opportunity.id}`,
          semantic_intent: "reconcile_accessible_transcript",
          target_tool: "archive.reconcile_transcript_request",
          target_arguments: {},
          request_sha256: sha256Hex(`request:missing-mutation:reconcile:${callSequence}`),
          provider_provenance_sha256: sha256Hex(`provenance:missing-mutation:reconcile:${callSequence}`),
        });
      }

      for (const call of control.development_pending_calls(plan.episode_id)) {
        // Deliberately model an agent that never issued the original mutation.
        if (call.target_tool === "archive.submit_transcript_request") continue;
        callSequence += 1;
        await control.gateway_executor.execute({
          bridge_version: "lc4-dev-gateway-bridge-v2",
          episode_id: plan.episode_id,
          opportunity_id: opportunity.id,
          opportunity_index: opportunity.index,
          provider: plan.provider,
          arm: plan.arm,
          provider_call_id: `test.missing-mutation.${opportunity.id}.${callSequence}`,
          provider_response_id: `response.missing-mutation.${opportunity.id}`,
          semantic_intent: call.semantic_intent,
          target_tool: call.target_tool,
          target_arguments: call.target_arguments,
          request_sha256: sha256Hex(`request:missing-mutation:${opportunity.id}:${callSequence}`),
          provider_provenance_sha256: sha256Hex(`provenance:missing-mutation:${opportunity.id}:${callSequence}`),
        });
      }
      previous = sha256Hex(`provider-exchange:${plan.episode_id}:${opportunity.id}`);
    }

    expect(rejectedLateMutation).toMatchObject({
      disposition: "rejected",
      provider_output: { ok: false, code: "missed_opportunity_window" },
    });
    expect(rejectedReconciliation).toMatchObject({
      disposition: "rejected",
      provider_output: {
        ok: false,
        code: "reconciliation_source_missing",
      },
    });
    const snapshot = control.snapshot(plan.episode_id);
    expect(snapshot.opportunities).toBe(60);
    expect(snapshot.world.receipts.some((receipt) => receipt.tool === "archive.submit_transcript_request")).toBe(false);
    expect(snapshot.world.receipts.some((receipt) => receipt.tool === "archive.reconcile_transcript_request")).toBe(false);
    expect(snapshot.caller_branch_prior_receipt.outcome).toBe("no_call");
    expect(snapshot.pending_gateway_actions).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("distinguishes a rejected pre-dispatch mutation from no call before opportunity 42", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const control = createLc4DevMunicipalControlPlane({
      audio_manifest: artifacts.manifest,
      repair_manifest: artifacts.repairManifest,
      signer: createBenchmarkKernelAttestationSigner({
        keyId: "lc4-dev-rejected-branch-test",
        privateKeyPem,
      }),
    });
    const plan = episode("hacc");
    const corpus = createLc4PublicDevelopmentCorpus();
    let previous: string | null = null;
    for (const opportunity of corpus.opportunities.slice(0, 41)) {
      await control.next({ episode: plan, opportunity, previous_exchange_sha256: previous });
      if (opportunity.index === 35) {
        const rejected = await control.gateway_executor.execute({
          bridge_version: "lc4-dev-gateway-bridge-v2",
          episode_id: plan.episode_id,
          opportunity_id: opportunity.id,
          opportunity_index: opportunity.index,
          provider: plan.provider,
          arm: plan.arm,
          provider_call_id: "test.rejected-pre-dispatch.op35",
          provider_response_id: "response.rejected-pre-dispatch.op35",
          semantic_intent: "submit_accessible_transcript",
          target_tool: "archive.submit_transcript_request",
          target_arguments: { request_id: "model-must-not-bind-this" },
          request_sha256: sha256Hex("request:rejected-pre-dispatch:op35"),
          provider_provenance_sha256: sha256Hex("provenance:rejected-pre-dispatch:op35"),
        });
        expect(rejected).toMatchObject({ disposition: "rejected", provider_output: { code: "host_bound_argument_override" } });
      }
      previous = sha256Hex(`provider-exchange:${plan.episode_id}:${opportunity.id}`);
    }
    const priorReceipt = control.callerBranchPriorReceipt(plan.episode_id);
    expect(priorReceipt).toMatchObject({
      outcome: "rejected_pre_dispatch",
      receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const identity = Object.freeze({
      key_id: "lc4-dev-rejected-branch-test",
      private_key_pem: privateKeyPem,
      public_key_pem: publicKeyPem,
    });
    const matrix = createLc4DevCallerBranchMatrixArtifact({
      audio_manifest_sha256: artifacts.manifest.manifest_sha256,
      audio_bindings: artifacts.manifest.caller_branch_audio_bindings,
      signing_identity: identity,
    });
    const decision = createLc4DevCallerBranchAuthority({ matrix, signing_identity: identity }).decide({
      episode_id: plan.episode_id,
      provider: plan.provider,
      opportunity: corpus.opportunities[41]!,
      prior_receipt: priorReceipt,
    });
    const projected = lc4DevBranchedOpportunity(corpus.opportunities[41]!, decision);
    expect(projected).toMatchObject({ id: "lc4-dev-op-42", index: 42 });
    expect(projected.events.some((event) => event.kind === "authoritative-reconciliation")).toBe(false);
    await control.next({ episode: plan, opportunity: projected, previous_exchange_sha256: previous });
    expect(control.snapshot(plan.episode_id).pending_gateway_obligations
      .some((obligation) => obligation.target_tool === "archive.reconcile_transcript_request")).toBe(false);
  });
});
