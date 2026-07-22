import { describe, expect, it } from "vitest";

import { AgentFlowSchema } from "../../flow";
import { createFlowExecutionState } from "../../flow-runtime";
import type { RealtimeWireObservation } from "../../realtime/client/types";
import {
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import type { AdmissibilityFrontierEvidence } from "../admissibility-frontier";
import { canonicalJson, sha256Hex } from "../artifacts";
import type { ProviderCapabilitySnapshot } from "../capability-gateway";
import { compileConditionSuite } from "../condition-compiler";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  assertLc4ControlStressResult,
  claimLc4ControlStressCellBeforeOpen,
  freezeLc4ControlStressPlan,
  lc4ControlStressBudgetConsumptionSha256,
  lc4ControlStressPreOpenClaimSha256,
  retainLc4ControlStressResult,
  sanitizeLc4ControlStressWireObservation,
  verifyLc4ControlStressPlan,
  verifyLc4ControlStressResult,
  type Lc4ControlStressCasReference,
  type Lc4ControlStressOneShotAuthority,
  type Lc4ControlStressSpeechEvaluator,
  type Lc4ControlStressSource,
} from "../lc4-control-stress-diagnostic";
import type {
  Lc4DevReplayArtifactReference,
  Lc4DevReplayCasPort,
  Lc4DevReplayLedgerEvent,
} from "../lc4-development-evidence-retention";
import { createHaccResponsePlan } from "../response-plan";
import { BenchmarkScenarioSchema, type JsonValue } from "../scenario-schema";
import {
  createHaccSpeechGuardrailPacket,
  createInitialHaccSpeechGuardrailState,
} from "../speech-guardrail-packet";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";

const CONTROL_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n";
const PLAN_DOMAIN = "harshas-amazing-call-center/lc4-control-stress-plan/v1\n";
const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-ledger-event/v1\n";

function memoryCas(): Lc4DevReplayCasPort & Readonly<{ bytes: Map<string, Uint8Array> }> {
  const bytes = new Map<string, Uint8Array>();
  return Object.freeze({
    bytes,
    async put(input: Uint8Array) {
      const copy = Uint8Array.from(input);
      const artifactSha256 = sha256Hex(copy);
      bytes.set(artifactSha256, copy);
      return Object.freeze({
        artifact_sha256: artifactSha256,
        byte_length: copy.byteLength,
        receipt_sha256: sha256Hex(`receipt:${artifactSha256}`),
      });
    },
    async get(artifactSha256: string) {
      const value = bytes.get(artifactSha256);
      if (!value) throw Object.assign(new Error("missing CAS object"), { code: "ENOENT" });
      return Uint8Array.from(value);
    },
  });
}

function oneShotAuthority(): Lc4ControlStressOneShotAuthority {
  const consumed = new Set<string>();
  const claims = new Map<string, string>();
  let cumulative = 0;
  return Object.freeze({
    async claimBeforeOpen(input) {
      const key = `${input.plan_sha256}:${input.cell_id}`;
      if (consumed.has(key)) throw new Error("duplicate one-shot control-stress cell consumption");
      consumed.add(key);
      const body = Object.freeze({
        schema_version: 1 as const,
        plan_sha256: input.plan_sha256,
        reservation_binding_sha256: input.reservation_binding_sha256,
        cell_id: input.cell_id,
        attempt_ordinal: 1 as const,
        claimed_ledger_head_sha256: sha256Hex(`claim-ledger:${key}`),
      });
      const claim = Object.freeze({ ...body, claim_sha256: lc4ControlStressPreOpenClaimSha256(body) });
      claims.set(claim.claim_sha256, key);
      return claim;
    },
    async settleAfterUsage(input) {
      const key = `${input.claim.plan_sha256}:${input.claim.cell_id}`;
      if (claims.get(input.claim.claim_sha256) !== key) throw new Error("unknown control-stress pre-open claim");
      claims.delete(input.claim.claim_sha256);
      cumulative += input.settled_micro_usd;
      if (cumulative > input.maximum_total_micro_usd) throw new Error("control-stress budget exhausted");
      const body = Object.freeze({
        schema_version: 1 as const,
        plan_sha256: input.claim.plan_sha256,
        reservation_binding_sha256: input.claim.reservation_binding_sha256,
        cell_id: input.claim.cell_id,
        attempt_ordinal: 1 as const,
        pre_open_claim_sha256: input.claim.claim_sha256,
        usage_evidence_sha256: input.usage_evidence_sha256,
        settled_micro_usd: input.settled_micro_usd,
        cumulative_settled_micro_usd: cumulative,
        final_ledger_head_sha256: sha256Hex(`ledger:${key}:${cumulative}`),
      });
      return Object.freeze({ ...body, consumption_sha256: lc4ControlStressBudgetConsumptionSha256(body) });
    },
  });
}

function speechEvaluator(
  cas: Lc4DevReplayCasPort,
  outcome: "satisfied" | "violated" | "unverifiable",
): Lc4ControlStressSpeechEvaluator {
  const evaluatorManifestSha256 = "f".repeat(64);
  return Object.freeze({
    evaluator_manifest_sha256: evaluatorManifestSha256,
    async evaluate(input) {
      const body = Object.freeze({
        schema_version: 1 as const,
        speech_oracle_sha256: input.speech_oracle_sha256,
        evaluator_manifest_sha256: evaluatorManifestSha256,
        ordered_output_audio_sha256: sha256Hex(canonicalJson(input.ordered_output_audio)),
        wire_chain_head_sha256: input.wire_chain_head_sha256,
        outcome,
      });
      const bytes = Buffer.from(canonicalJson(body), "utf8");
      const retained = await cas.put(bytes, "application/json");
      return Object.freeze({ artifact_sha256: retained.artifact_sha256, byte_length: retained.byte_length, media_type: "application/json" as const });
    },
  });
}

async function pcmReference(cas: Lc4DevReplayCasPort): Promise<Lc4ControlStressCasReference> {
  const pcm = Uint8Array.from({ length: 640 }, (_, index) => index % 251);
  const receipt = await cas.put(pcm, "audio/pcm");
  return Object.freeze({ artifact_sha256: receipt.artifact_sha256, byte_length: receipt.byte_length, media_type: "audio/pcm" });
}

const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const compilerInput = industrialFieldServiceCompilerInput(scenario);
const flow = AgentFlowSchema.parse(compilerInput.flow);
const condition = compileConditionSuite(compilerInput).conditions["host-managed-harness"];
const target = "step:field_service.verify_technician" as const;
const disclosure = condition.disclosures.find((item) => item.target === target);
if (!disclosure) throw new Error("control-stress test disclosure is unavailable");
const targetDisclosure = disclosure;

function haccPlan() {
  const snapshot: ProviderCapabilitySnapshot = {
    gateway_version: 1,
    scope: target,
    capability_epoch: 3,
    actions: targetDisclosure.visibleCapabilities.map((capability, index) => ({
      name: capability.name,
      description: capability.description,
      input_schema: capability.inputSchema as Record<string, JsonValue>,
      semantic_hash: capability.semanticHash,
      capability_grant: `control-stress-test-grant-${index}`,
    })),
  };
  const state = {
    ...createFlowExecutionState("2026-07-22T12:00:00.000Z"),
    status: "active" as const,
    nodeId: "field_service",
    currentStep: "field_service.verify_technician",
    capabilityEpoch: snapshot.capability_epoch,
  };
  return createHaccResponsePlan({
    flow,
    state,
    conditionSha256: condition.conditionHash,
    target,
    catalogMode: "target",
    snapshot,
    frontierEvidence: { evidence_sha256: "a".repeat(64) } as AdmissibilityFrontierEvidence,
    quarantines: [],
    speechGuardrailPacket: createHaccSpeechGuardrailPacket(createInitialHaccSpeechGuardrailState(), null),
    revision: 1,
    previousPlanSha256: null,
  });
}

function nativeInstructions(opportunityIndex: number, meaningfulBytes: number): string {
  const facts: string[] = [];
  for (let index = 0; Buffer.byteLength(facts.join("\n"), "utf8") < meaningfulBytes; index += 1) {
    facts.push(`At opportunity ${opportunityIndex}, retained public fact ${index + 1} controls the archive workflow and has a distinct receipt.`);
  }
  return `<lc4_native_equivalent_context>\n${facts.join("\n")}\n</lc4_native_equivalent_context>`;
}

async function controlSource(input: Readonly<{
  cas: Lc4DevReplayCasPort;
  provider: "openai";
  arm: "native" | "hacc";
  opportunityIndex: number;
  instructions?: string;
}>): Promise<Lc4ControlStressSource> {
  const responseControl = input.arm === "native"
    ? {
        kind: "native_context",
        instructions: input.instructions!,
        instructions_sha256: sha256Hex(input.instructions!),
      }
    : { kind: "hacc_response_plan", plan: haccPlan() };
  const body = {
    schema_version: 1,
    manifest_sha256: "1".repeat(64),
    episode_id: `lc4-dev-openai-${input.arm}`,
    arm: input.arm,
    opportunity_id: `lc4-dev-op-${String(input.opportunityIndex).padStart(2, "0")}`,
    opportunity_index: input.opportunityIndex,
    previous_exchange_sha256: input.opportunityIndex === 1 ? null : "2".repeat(64),
    response_control: responseControl,
    flow_state_sha256: "3".repeat(64),
    gateway_transcript_head_sha256: "4".repeat(64),
    tool_world_state_sha256: "5".repeat(64),
    worker_state_sha256: "6".repeat(64),
    repair_state_sha256: "7".repeat(64),
    native_continuity_state_sha256: "8".repeat(64),
  };
  const encoded = Buffer.from(`${CONTROL_RECEIPT_DOMAIN}${canonicalJson(body)}`, "utf8");
  const retained = await input.cas.put(encoded, "application/octet-stream");
  const reference: Lc4DevReplayArtifactReference = Object.freeze({
    schema_version: 1,
    retention_version: "lc4-dev-replay-evidence-v1",
    kind: "control_authority",
    evidence_sha256: retained.artifact_sha256,
    byte_length: retained.byte_length,
    content_encoding: "domain-prefixed-canonical-json",
    domain_prefix: CONTROL_RECEIPT_DOMAIN,
  });
  return Object.freeze({
    provider: input.provider,
    model: "gpt-realtime-2.1",
    arm: input.arm,
    episode_id: body.episode_id,
    opportunity_index: input.opportunityIndex,
    control_authority: reference,
  });
}

async function retainedPayload(cas: Lc4DevReplayCasPort, payload: JsonValue): Promise<Lc4DevReplayArtifactReference> {
  const bytes = Buffer.from(canonicalJson(payload), "utf8");
  const receipt = await cas.put(bytes, "application/json");
  return Object.freeze({
    schema_version: 1,
    retention_version: "lc4-dev-replay-evidence-v1",
    kind: "ledger_payload",
    evidence_sha256: receipt.artifact_sha256,
    byte_length: receipt.byte_length,
    content_encoding: "canonical-json",
    domain_prefix: "",
  });
}

async function sourceLedger(
  cas: Lc4DevReplayCasPort,
  sources: readonly Lc4ControlStressSource[],
): Promise<readonly Lc4DevReplayLedgerEvent[]> {
  const events: Lc4DevReplayLedgerEvent[] = [];
  let previous: string | null = null;
  const append = async (
    eventType: string,
    episodeId: string,
    opportunityId: string | null,
    payload: JsonValue,
    evidenceReferences: readonly Lc4DevReplayArtifactReference[],
  ) => {
    const payloadEvidence = await retainedPayload(cas, payload);
    const body = {
      sequence: events.length + 1,
      observed_at: `2026-07-22T12:00:${String(events.length).padStart(2, "0")}.000Z`,
      event_type: eventType,
      episode_id: episodeId,
      opportunity_id: opportunityId,
      payload_sha256: payloadEvidence.evidence_sha256,
      payload_evidence: payloadEvidence,
      evidence_references: evidenceReferences,
      previous_event_sha256: previous,
    };
    const event = Object.freeze({
      ...body,
      event_sha256: sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson(body)}`),
    });
    events.push(event);
    previous = event.event_sha256;
  };
  for (const arm of ["native", "hacc"] as const) {
    const armSources = sources.filter((source) => source.arm === arm);
    if (armSources.length === 0) continue;
    await append("episode_opened", armSources[0]!.episode_id, null, {
      provider: "openai",
      arm,
      model: "gpt-realtime-2.1",
    }, []);
    for (const source of armSources) {
      await append(
        "audio_submitted",
        source.episode_id,
        `lc4-dev-op-${String(source.opportunity_index).padStart(2, "0")}`,
        {
          caller_pcm_sha256: "f".repeat(64),
          control_receipt_sha256: source.control_authority.evidence_sha256,
          caller_branch_decision_sha256: null,
        },
        [source.control_authority],
      );
    }
  }
  return Object.freeze(events);
}

async function fixture() {
  const cas = memoryCas();
  const sources: Lc4ControlStressSource[] = [];
  for (const [opportunityIndex, bytes] of [[1, 7_200], [10, 4_800], [20, 2_600], [40, 1_100], [60, 350]] as const) {
    sources.push(await controlSource({
      cas,
      provider: "openai",
      arm: "native",
      opportunityIndex,
      instructions: nativeInstructions(opportunityIndex, bytes),
    }));
  }
  sources.push(await controlSource({ cas, provider: "openai", arm: "hacc", opportunityIndex: 1 }));
  const ledger = await sourceLedger(cas, sources);
  const probe = {
    probe_id: "control-stress-tool-and-speech-probe-v1",
    caller_pcm: await pcmReference(cas),
    expected_tool_name: "capability_gateway",
    expected_tool_arguments_sha256: sha256Hex("{\"arguments\":{},\"tool_name\":\"archive.lookup\"}"),
    speech_oracle_sha256: "9".repeat(64),
  } as const;
  const plan = await freezeLc4ControlStressPlan({
    run_id: "control-stress-test-run",
    created_at: "2026-07-22T12:00:00.000Z",
    source_commit: "a".repeat(40),
    source_tree_oid: "b".repeat(40),
    source_tree_sha256: "c".repeat(64),
    probe,
    budget: {
      ledger_id: "control-stress-test-ledger",
      reservation_id: "control-stress-test-reservation",
      reservation_binding_sha256: "d".repeat(64),
      initial_ledger_head_sha256: "e".repeat(64),
      maximum_micro_usd: 2_000_000,
      maximum_paid_sessions: 5,
    },
    sources,
    source_ledger: ledger,
    cas,
  });
  return { cas, plan, sources, ledger };
}

function wire(requestSha256: string, requestBytes: number, argumentsSha256: string): readonly RealtimeWireObservation[] {
  const projection1 = Object.freeze({
    dynamicControl: Object.freeze({
      sha256: requestSha256,
      byteLength: requestBytes,
      authority: "advisory_only_gateway_and_speech_gate_enforced",
    }),
    authorization: "Bearer must-never-be-retained",
  });
  const core1 = Object.freeze({
    schemaVersion: 1 as const,
    provider: "openai" as const,
    direction: "outbound" as const,
    connectionEpoch: 1,
    sequence: 1,
    observedAtMs: 10,
    observedAtMonotonicMs: 10,
    wireType: "response.create",
    payloadSha256: "1".repeat(64),
    payloadBytes: 80,
    projectionSha256: realtimeWireProjectionSha256(projection1),
    previousObservationSha256: null,
    identities: Object.freeze({}),
    projection: projection1,
  });
  const first = Object.freeze({ ...core1, observationSha256: realtimeWireObservationSha256(core1) });
  const projection2 = Object.freeze({
    audio: Object.freeze({ validCanonicalBase64: true, sha256: "6".repeat(64), byteLength: 640 }),
  });
  const core2 = Object.freeze({
    schemaVersion: 1 as const,
    provider: "openai" as const,
    direction: "inbound" as const,
    connectionEpoch: 1,
    sequence: 2,
    observedAtMs: 150,
    observedAtMonotonicMs: 150,
    wireType: "response.output_audio.delta",
    payloadSha256: "2".repeat(64),
    payloadBytes: 120,
    projectionSha256: realtimeWireProjectionSha256(projection2),
    previousObservationSha256: first.observationSha256,
    identities: Object.freeze({ responseIdSha256: "4".repeat(64) }),
    projection: projection2,
  });
  const second = Object.freeze({ ...core2, observationSha256: realtimeWireObservationSha256(core2) });
  const projection3 = Object.freeze({
    gatewayCalls: Object.freeze([{
      gateway: "capability_gateway",
      argumentsSha256,
      argumentsBytes: 46,
    }]),
    usage: Object.freeze({ inputTextTokens: 321, outputAudioTokens: 18, totalTokens: 339 }),
    terminal: Object.freeze({ status: "completed" }),
    transcript: "private provider text",
  });
  const core3 = Object.freeze({
    schemaVersion: 1 as const,
    provider: "openai" as const,
    direction: "inbound" as const,
    connectionEpoch: 1,
    sequence: 3,
    observedAtMs: 400,
    observedAtMonotonicMs: 400,
    wireType: "response.done",
    payloadSha256: "3".repeat(64),
    payloadBytes: 120,
    projectionSha256: realtimeWireProjectionSha256(projection3),
    previousObservationSha256: second.observationSha256,
    identities: Object.freeze({ responseIdSha256: "4".repeat(64), callIdSha256: "5".repeat(64) }),
    projection: projection3,
  });
  const third = Object.freeze({ ...core3, observationSha256: realtimeWireObservationSha256(core3) });
  return Object.freeze([first, second, third]);
}

describe("LC4 provider-control stress diagnostic", () => {
  it("freezes real retained Native/HACC controls into an unpadded provider-specific ladder", async () => {
    const { cas, plan } = await fixture();
    await expect(verifyLc4ControlStressPlan(plan, cas)).resolves.toBeUndefined();
    expect(plan.execution_policy).toEqual({
      paid_retry_allowed: false,
      maximum_attempts_per_cell: 1,
      maximum_response_generations_per_cell: 1,
      basic_transport_qualification_impact: "none",
      provider_parity_claim_allowed: false,
    });
    const native = plan.cells.filter((cell) => cell.arm === "native");
    expect(native.map((cell) => cell.rung)).toEqual([
      "compact_semantic_baseline", "meaningful_2k", "meaningful_8k", "actual_current_max",
    ]);
    expect(native.every((cell) => cell.request_artifact !== null)).toBe(true);
    expect(native.filter((cell) => cell.disposition === "scheduled")).toHaveLength(4);
    expect(new Set(native.map((cell) => cell.current_checkpoint_control_receipt_sha256))).toHaveLength(1);
    expect(native.every((cell) => cell.source_control_receipt_sha256s.at(-1)
      === cell.current_checkpoint_control_receipt_sha256)).toBe(true);
    const lengths = native.map((cell) => cell.request_artifact!.byte_length);
    expect(lengths[0]).toBeLessThan(lengths[1]!);
    expect(lengths[1]).toBeGreaterThanOrEqual(2 * 1024);
    expect(lengths[2]).toBeGreaterThanOrEqual(8 * 1024);
    expect(lengths[3]).toBeGreaterThan(lengths[2]!);
    const twoK = Buffer.from(await cas.get(native[1]!.request_artifact!.artifact_sha256)).toString("utf8");
    expect(twoK).toContain("retained public fact");
    expect(twoK).not.toMatch(/padding|lorem|dummy/iu);
    expect(plan.cells.filter((cell) => cell.arm === "hacc" && cell.disposition === "scheduled")).toHaveLength(1);
    expect(plan.claim_boundary).toContain("not_cross_provider_parity");
  });

  it("fails closed on missing CAS provenance, plan tamper, budget drift, and an attempted second paid try", async () => {
    const { cas, plan, sources, ledger } = await fixture();
    await expect(freezeLc4ControlStressPlan({
      run_id: "provider-relabel-test",
      created_at: plan.created_at,
      source_commit: plan.source_commit,
      source_tree_oid: plan.source_tree_oid,
      source_tree_sha256: plan.source_tree_sha256,
      probe: plan.probe,
      budget: plan.budget,
      sources: sources.map((source, index) => index === 0 ? { ...source, provider: "gemini" } : source),
      source_ledger: ledger,
      cas,
    })).rejects.toThrow("provider/model/arm labels differ");
    const missing = memoryCas();
    await expect(freezeLc4ControlStressPlan({
      run_id: "missing-source-test",
      created_at: plan.created_at,
      source_commit: plan.source_commit,
      source_tree_oid: plan.source_tree_oid,
      source_tree_sha256: plan.source_tree_sha256,
      probe: plan.probe,
      budget: plan.budget,
      sources,
      source_ledger: ledger,
      cas: missing,
    })).rejects.toThrow();
    const tampered = { ...plan, source_tree_sha256: "f".repeat(64) };
    await expect(verifyLc4ControlStressPlan(tampered, cas)).rejects.toThrow("plan hash mismatch");
    const substitutedBody = {
      ...plan,
      cells: plan.cells.map((cell, index) => index === 0
        ? { ...cell, source_rendered_control_sha256s: ["0".repeat(64)] }
        : cell),
    };
    const { plan_sha256: _discarded, ...substitutedWithoutHash } = substitutedBody;
    expect(_discarded).toBe(plan.plan_sha256);
    const substituted = {
      ...substitutedWithoutHash,
      plan_sha256: sha256Hex(`${PLAN_DOMAIN}${canonicalJson(substitutedWithoutHash)}`),
    };
    await expect(verifyLc4ControlStressPlan(substituted, cas)).rejects.toThrow("cell matrix differs");
    await expect(freezeLc4ControlStressPlan({
      run_id: "budget-drift-test",
      created_at: plan.created_at,
      source_commit: plan.source_commit,
      source_tree_oid: plan.source_tree_oid,
      source_tree_sha256: plan.source_tree_sha256,
      probe: plan.probe,
      budget: { ...plan.budget, maximum_paid_sessions: 6 },
      sources,
      source_ledger: ledger,
      cas,
    })).rejects.toThrow("exactly one session per scheduled cell");
    const scheduledCell = plan.cells.find((cell) => cell.disposition === "scheduled")!;
    const attemptAuthority = oneShotAuthority();
    const attemptClaim = await claimLc4ControlStressCellBeforeOpen({ plan, cell_id: scheduledCell.cell_id, authority: attemptAuthority });
    await expect(retainLc4ControlStressResult({
      plan,
      cell_id: scheduledCell.cell_id,
      cas,
      observed_at: "2026-07-22T12:01:00.000Z",
      attempt_ordinal: 2 as 1,
      acceptance_signal: { kind: "explicit_control_rejection", acknowledged_control_sha256: null, rejection_code_sha256: "a".repeat(64) },
      wire_observations: wire(
        plan.cells.find((candidate) => candidate.disposition === "scheduled")!.request_artifact!.artifact_sha256,
        plan.cells.find((candidate) => candidate.disposition === "scheduled")!.request_artifact!.byte_length,
        plan.probe.expected_tool_arguments_sha256,
      ),
      speech_evaluator: speechEvaluator(cas, "unverifiable"),
      pricing: null,
      authority: attemptAuthority,
      pre_open_claim: attemptClaim,
    })).rejects.toThrow("attempt ordinal 1");
    const emptyAuthority = oneShotAuthority();
    const emptyClaim = await claimLc4ControlStressCellBeforeOpen({ plan, cell_id: scheduledCell.cell_id, authority: emptyAuthority });
    await expect(retainLc4ControlStressResult({
      plan,
      cell_id: scheduledCell.cell_id,
      cas,
      observed_at: "2026-07-22T12:01:01.000Z",
      attempt_ordinal: 1,
      acceptance_signal: { kind: "request_processed_without_exact_ack", acknowledged_control_sha256: null, rejection_code_sha256: null },
      wire_observations: [],
      speech_evaluator: speechEvaluator(cas, "unverifiable"),
      pricing: null,
      authority: emptyAuthority,
      pre_open_claim: emptyClaim,
    })).rejects.toThrow("valid non-empty wire chain");
  });

  it("retains hashed wire, usage, tool, and speech evidence while classifying unverifiable acceptance honestly", async () => {
    const { cas, plan } = await fixture();
    const cell = plan.cells.find((candidate) => candidate.disposition === "scheduled")!;
    const authority = oneShotAuthority();
    const preOpenClaim = await claimLc4ControlStressCellBeforeOpen({ plan, cell_id: cell.cell_id, authority });
    const resultInput = {
      plan,
      cell_id: cell.cell_id,
      cas,
      observed_at: "2026-07-22T12:02:00.000Z",
      attempt_ordinal: 1,
      acceptance_signal: {
        kind: "request_processed_without_exact_ack",
        acknowledged_control_sha256: null,
        rejection_code_sha256: null,
      },
      wire_observations: wire(
        cell.request_artifact!.artifact_sha256,
        cell.request_artifact!.byte_length,
        plan.probe.expected_tool_arguments_sha256,
      ),
      speech_evaluator: speechEvaluator(cas, "satisfied"),
      pricing: {
        pricing_snapshot_sha256: "0".repeat(64),
        formula_sha256: "1".repeat(64),
        computeMicroUsd: () => 1_234,
      },
      authority,
      pre_open_claim: preOpenClaim,
    } as const;
    const result = await retainLc4ControlStressResult(resultInput);
    expect(() => assertLc4ControlStressResult(result, plan)).not.toThrow();
    await expect(verifyLc4ControlStressResult(result, plan, cas)).resolves.toBeUndefined();
    expect(result).toMatchObject({
      control_acceptance: "unverifiable",
      tool_call_outcome: "expected_tool_observed",
      speech_outcome: "speech_observed",
      speech_semantic_outcome: "satisfied",
      usage_totals: { input_text_tokens: 321, output_audio_tokens: 18, total_tokens: 339, usage_event_count: 1 },
      paid_retry_count: 0,
      basic_transport_qualification_impact: "none",
      provider_parity_claim_allowed: false,
    });
    const retainedWire = Buffer.from(await cas.get(result.evidence.wire.artifact_sha256)).toString("utf8");
    for (const forbidden of ["Bearer must-never-be-retained", "private provider text", "raw-call-id", "raw-response-id"]) {
      expect(retainedWire).not.toContain(forbidden);
    }
    expect(canonicalJson(sanitizeLc4ControlStressWireObservation(wire(
      cell.request_artifact!.artifact_sha256,
      cell.request_artifact!.byte_length,
      plan.probe.expected_tool_arguments_sha256,
    )[0]!))).not.toContain("authorization");
    await expect(claimLc4ControlStressCellBeforeOpen({ plan, cell_id: cell.cell_id, authority }))
      .rejects.toThrow("duplicate one-shot");
  });
});
