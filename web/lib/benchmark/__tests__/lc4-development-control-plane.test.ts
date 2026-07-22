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
  LC4_DEV_DURABLE_WORKER_PLAN_SHA256,
  LC4_DEV_MUNICIPAL_CONDITION_SUITE,
  LC4_DEV_MUNICIPAL_FLOW,
  LC4_DEV_MUNICIPAL_SCENARIO,
  createLc4DevMunicipalControlPlane,
} from "../lc4-development-control-plane";
import type { Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

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
    for (const arm of ["native", "hacc"] as const) {
      const plan = episode(arm);
      let previous: string | null = null;
      for (const opportunity of corpus.opportunities) {
        const receipt = await control.next({ episode: plan, opportunity, previous_exchange_sha256: previous });
        expect(receipt.control_receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(receipt.response_control.kind).toBe(arm === "hacc" ? "hacc_response_plan" : "native_context");
        (arm === "hacc" ? haccContinuity : nativeContinuity).push(receipt.native_continuity_state_sha256);
        let callSequence = 0;
        for (;;) {
          if (callSequence > 32) throw new Error(`gateway drain did not converge: ${plan.arm}:${opportunity.id}`);
          const calls = control.development_pending_calls(plan.episode_id);
          if (calls.length === 0) break;
          for (const call of calls) {
            callSequence += 1;
            expect(call.opportunity_id).toBe(opportunity.id);
            const gateway = await control.gateway_executor.execute({
              bridge_version: "lc4-dev-gateway-bridge-v1",
              episode_id: plan.episode_id,
              opportunity_id: opportunity.id,
              opportunity_index: opportunity.index,
              provider: plan.provider,
              arm: plan.arm,
              provider_call_id: `test.${plan.arm}.${opportunity.id}.${callSequence}`,
              provider_response_id: `response.${plan.arm}.${opportunity.id}`,
              target_tool: call.target_tool,
              target_arguments: call.target_arguments,
              request_sha256: sha256Hex(`request:${plan.arm}:${opportunity.id}:${callSequence}`),
              provider_provenance_sha256: sha256Hex(`provenance:${plan.arm}:${opportunity.id}:${callSequence}`),
            });
            const eligible = receipt.response_control.kind === "hacc_response_plan"
              ? receipt.response_control.plan.eligible_actions.join(",")
              : "native-full";
            expect(gateway.disposition, `${plan.arm}:${opportunity.id}:${call.target_tool}:eligible=${eligible}:${JSON.stringify(gateway.provider_output)}`).not.toBe("rejected");
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
      expect(snapshot.pending_gateway_actions).toBe(0);
    }
    expect(native.common_state_sha256).toBe(hacc.common_state_sha256);
    expect(gatewayReceipts.length).toBeGreaterThan(10);
    // HACC performs one additional authoritative flow.get_state read after
    // ambiguity reconciliation; native receives equivalent state inline.
    expect(gatewayReceiptsByArm.hacc.length).toBe(gatewayReceiptsByArm.native.length + 1);
    expect(new Set(gatewayReceipts).size).toBe(gatewayReceipts.length);
    expect(native.gateway_transcript_sha256).not.toBe(hacc.gateway_transcript_sha256);
    expect(control.manifest.native_information_parity).toBe("full_equivalent_policy_and_accumulated_public_state");
    expect(control.manifest.manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
  }, 30_000);
});
