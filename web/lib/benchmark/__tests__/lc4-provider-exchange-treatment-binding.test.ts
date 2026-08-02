import { describe, expect, it } from "vitest";
import { AgentFlowSchema } from "../../flow";
import {
  createFlowExecutionState,
  type FlowExecutionState,
} from "../../flow-runtime";
import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import { compileConditionSuite } from "../condition-compiler";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  createLc4DevProviderConnectionAttestation,
  createLc4DevProviderConnectionScope,
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  LC4_DEV_GATEWAY_BRIDGE_VERSION,
  lc4DevProviderInvocationId,
  renderLc4DevHaccResponsePlan,
} from "../lc4-development-gateway-bridge";
import { LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256 } from "../lc4-provider-session-schedule";
import {
  advanceLc4DevResponsePlanChain,
  assertLc4HaccRotationTreatmentCheckpoint,
  assertLc4ProviderExchangeTreatmentBinding,
  lc4DevResponsePlanChainGenesis,
} from "../lc4-provider-exchange-treatment-binding";
import {
  advanceHaccSpeechGuardrailState,
  createHaccSpeechGuardrailPacket,
  createInitialHaccSpeechGuardrailState,
} from "../speech-guardrail-packet";
import { createHaccResponsePlan } from "../response-plan";
import {
  BenchmarkScenarioSchema,
  type JsonValue as ScenarioJsonValue,
} from "../scenario-schema";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import type { AdmissibilityFrontierEvidence } from "../admissibility-frontier";
import type { ProviderCapabilitySnapshot } from "../capability-gateway";
import { realtimeToolFrontierSha256 } from "../../realtime/client/openai-compatible";

const CONTROL_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n";
const REPAIR_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-repair-decision-receipt/v1\n";
const RECEIPT_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt-set/v3\n";
const AUTHORITY_PROJECTION_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-gateway-authority-projection/v2\n";
const GATEWAY_RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt/v2\n";
const EPISODE = "lc4-treatment-binding-episode";
const OPPORTUNITY = "lc4-dev-op-1";

function providerConnectionScope() {
  const connectionAttestation = createLc4DevProviderConnectionAttestation({
    provider: "openai",
    connection_epoch: 1,
    connection_nonce_sha256: sha256Hex("treatment provider connection nonce"),
    provider_session_id_sha256: sha256Hex("treatment provider session"),
    session_configuration_acknowledgement_sha256:
      sha256Hex("treatment provider configuration acknowledgement"),
    connect_wire_observation_count: 1,
    connect_wire_chain_head_sha256:
      sha256Hex("treatment provider connect wire head"),
  });
  return createLc4DevProviderConnectionScope({
    episode_id: EPISODE,
    provider: "openai",
    arm: "hacc",
    prepare_sha256: sha256Hex("treatment prepare"),
    preflight_sha256: sha256Hex("treatment preflight"),
    execution_id_sha256: sha256Hex("treatment execution"),
    control_plane_manifest_sha256: sha256Hex("treatment control manifest"),
    provider_session_schedule_sha256:
      LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256,
    segment_ordinal: 1,
    session_ordinal: 1,
    opportunity_start: 1,
    opportunity_end: 10,
    connection_epoch: 1,
    previous_rotation_receipt_sha256: null,
    rotation_context_kind: "none",
    rotation_packet_sha256: null,
    rotation_conversation_replay_sha256: null,
    rotation_context_sha256: sha256Hex("treatment empty rotation context"),
    connection_attestation: connectionAttestation,
  });
}

const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const compilerInput = industrialFieldServiceCompilerInput(scenario);
const flow = AgentFlowSchema.parse(compilerInput.flow);
const condition = compileConditionSuite(compilerInput)
  .conditions["host-managed-harness"];
const target = "step:field_service.verify_technician" as const;
const disclosure = condition.disclosures.find((item) => item.target === target)!;
const snapshot: ProviderCapabilitySnapshot = {
  gateway_version: 1,
  scope: target,
  capability_epoch: 7,
  actions: disclosure.visibleCapabilities.map((capability, index) => ({
    name: capability.name,
    description: capability.description,
    input_schema: capability.inputSchema as Record<string, ScenarioJsonValue>,
    semantic_hash: capability.semanticHash,
    capability_grant: `treatment-binding-grant-${index}`,
  })),
};

function responsePlan(
  revision = 1,
  previousPlanSha256: string | null = null,
  updatedAt = "2026-07-21T00:00:00.000Z",
) {
  const state: FlowExecutionState = {
    ...createFlowExecutionState("2026-07-21T00:00:00.000Z"),
    status: "active",
    nodeId: "field_service",
    currentStep: "field_service.verify_technician",
    capabilityEpoch: 7,
    actionReceipts: [],
    updatedAt,
  };
  const initial = createInitialHaccSpeechGuardrailState();
  const first = createHaccSpeechGuardrailPacket(initial, null);
  const verified = advanceHaccSpeechGuardrailState(initial, {
    kind: "verification_succeeded",
    evidence_sha256: "d".repeat(64),
  });
  return createHaccResponsePlan({
    flow,
    state,
    conditionSha256: condition.conditionHash,
    target,
    catalogMode: "target",
    snapshot,
    frontierEvidence: {
      evidence_sha256: "a".repeat(64),
    } as AdmissibilityFrontierEvidence,
    quarantines: [],
    speechGuardrailPacket: createHaccSpeechGuardrailPacket(
      verified,
      first.packet_sha256,
    ),
    revision,
    previousPlanSha256,
  });
}

function reboundGatewayReceiptSet(input: Readonly<{
  plan: ReturnType<typeof responsePlan>;
  transition_binding_sha256: string;
}>) {
  const responseControl = {
    kind: "hacc_response_plan",
    plan: input.plan,
    transition_binding_sha256: input.transition_binding_sha256,
  };
  const responseControlSha256 = sha256Hex(canonicalJson(responseControl));
  const providerOutput = { ok: true, stage_completed: true };
  const connectionScope = providerConnectionScope();
  const providerCallId = "provider call";
  const providerInvocationId = lc4DevProviderInvocationId(
    connectionScope,
    providerCallId,
  );
  const authorityBody = {
    schema_version: 2,
    bridge_version: LC4_DEV_GATEWAY_BRIDGE_VERSION,
    redaction: "public_dev_authority_no_raw_provider_ids_or_credentials",
    episode_id: EPISODE,
    opportunity_id: OPPORTUNITY,
    opportunity_index: 1,
    provider: "openai",
    arm: "hacc",
    semantic_intent: "complete_current_stage",
    target_tool: "archive.complete_stage",
    provider_call_id_sha256: sha256Hex(providerCallId),
    provider_invocation_id_sha256: sha256Hex(providerInvocationId),
    provider_connection_scope: connectionScope,
    provider_connection_scope_sha256:
      connectionScope.connection_scope_sha256,
    provider_connection_epoch: connectionScope.connection_epoch,
    provider_session_id_sha256:
      connectionScope.connection_attestation.provider_session_id_sha256,
    provider_response_id_sha256: sha256Hex("provider response"),
    request_sha256: sha256Hex("gateway request"),
    provider_provenance_sha256: sha256Hex("provider provenance"),
    model_arguments: {},
    effective_arguments: { stage_id: "verify_technician" },
    provider_output: providerOutput,
    authoritative_receipt: { ok: true },
    authoritative_tool_world_receipt: { status: "succeeded" },
    post_transition_response_plan: input.plan,
    post_transition_response_control: responseControl,
    post_transition_response_plan_sha256: input.plan.plan_sha256,
    post_transition_response_control_sha256: responseControlSha256,
    authoritative_receipt_sha256: sha256Hex("authority receipt"),
    control_plane_head_sha256: sha256Hex("control plane head"),
    disposition: "executed",
  };
  const authority = {
    ...authorityBody,
    projection_sha256: sha256Hex(
      `${AUTHORITY_PROJECTION_DOMAIN}${canonicalJson(authorityBody)}`,
    ),
  };
  const receiptBody = {
    schema_version: 2,
    bridge_version: LC4_DEV_GATEWAY_BRIDGE_VERSION,
    episode_id: EPISODE,
    opportunity_id: OPPORTUNITY,
    provider: "openai",
    arm: "hacc",
    batch_ordinal: 1,
    call_ordinal: 1,
    semantic_intent: authority.semantic_intent,
    target_tool: authority.target_tool,
    provider_call_id_sha256: authority.provider_call_id_sha256,
    provider_invocation_id_sha256: authority.provider_invocation_id_sha256,
    provider_connection_scope: authority.provider_connection_scope,
    provider_connection_scope_sha256:
      authority.provider_connection_scope_sha256,
    provider_connection_epoch: authority.provider_connection_epoch,
    provider_session_id_sha256: authority.provider_session_id_sha256,
    provider_response_id_sha256: authority.provider_response_id_sha256,
    request_sha256: authority.request_sha256,
    provider_provenance_sha256: authority.provider_provenance_sha256,
    provider_output_sha256: sha256Hex(canonicalJson(providerOutput)),
    post_transition_response_plan_sha256: input.plan.plan_sha256,
    post_transition_response_control_sha256: responseControlSha256,
    authoritative_receipt_sha256: authority.authoritative_receipt_sha256,
    control_plane_head_sha256: authority.control_plane_head_sha256,
    disposition: "executed",
    authority_projection_sha256: authority.projection_sha256,
  };
  const receipt = {
    ...receiptBody,
    receipt_sha256: sha256Hex(
      `${GATEWAY_RECEIPT_DOMAIN}${canonicalJson(receiptBody)}`,
    ),
  };
  const setBody = {
    receipts: [receipt],
    authority_projections: [authority],
    pre_dispatch_rejections: [],
  };
  return {
    ...setBody,
    receipt_set_sha256: sha256Hex(
      `${RECEIPT_SET_DOMAIN}${canonicalJson(setBody)}`,
    ),
  };
}

function emptyGatewayReceiptSet() {
  const body = {
    receipts: [],
    authority_projections: [],
    pre_dispatch_rejections: [],
  };
  return {
    ...body,
    receipt_set_sha256: sha256Hex(
      `${RECEIPT_SET_DOMAIN}${canonicalJson(body)}`,
    ),
  };
}

function authority(plan = responsePlan()) {
  const body = {
    schema_version: 1,
    manifest_sha256: sha256Hex("treatment manifest"),
    episode_id: EPISODE,
    arm: "hacc",
    opportunity_id: OPPORTUNITY,
    opportunity_index: 1,
    previous_exchange_sha256: null,
    response_control: {
      kind: "hacc_response_plan",
      plan,
    },
    flow_state_sha256: plan.state_sha256,
    gateway_transcript_head_sha256: sha256Hex("gateway transcript"),
    tool_world_state_sha256: sha256Hex("tool world"),
    worker_state_sha256: sha256Hex("worker state"),
    repair_state_sha256: sha256Hex("repair state"),
    native_continuity_state_sha256: sha256Hex("native continuity"),
  };
  return {
    body,
    receipt: sha256Hex(`${CONTROL_DOMAIN}${canonicalJson(body)}`),
  };
}

function projection(plan = responsePlan(), playback: "canonical" | "repair" = "canonical") {
  const rendered = renderLc4DevHaccResponsePlan(plan, playback);
  return {
    schema_version: 5,
    run_id: EPISODE,
    opportunity_id: OPPORTUNITY,
    playback_kind: playback,
    response_control_kind: "hacc_response_plan",
    response_plan_sha256: plan.plan_sha256,
    response_plan_body: plan,
    terminal_response_plan_sha256: plan.plan_sha256,
    terminal_response_control_sha256: plan.plan_sha256,
    rendered_control_context: rendered,
    response_plan_delivery_sha256: sha256Hex(rendered),
    tool_frontier_sha256: realtimeToolFrontierSha256([
      LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
    ]),
    repair_decision_receipt_sha256: null,
    dev_gateway_receipt_set: emptyGatewayReceiptSet(),
  } as unknown as JsonValue;
}

function repairDecision(input: Readonly<{
  controlReceipt: string;
  canonicalExchange: string;
}>) {
  const body = {
    schema_version: 1,
    protocol_id: "HACC-LC4-DEV-v1",
    episode_id: EPISODE,
    canonical_opportunity_id: OPPORTUNITY,
    canonical_ordinal: 1,
    canonical_horizon: 60,
    advances_canonical_horizon: false,
    canonical_control_receipt_sha256: input.controlReceipt,
    canonical_exchange_sha256: input.canonicalExchange,
    canonical_listener_evidence_sha256: sha256Hex("canonical listener"),
    semantic_replay_sha256: sha256Hex("semantic replay"),
    plan_sha256: sha256Hex("repair plan"),
    plan_binding_sha256: sha256Hex("repair plan binding"),
    decision: {
      decision_sha256: sha256Hex("repair decision"),
      selection: { repair_pcm_id: "repair.fixture" },
    },
    state_after_sha256: sha256Hex("repair state after"),
  };
  return {
    body,
    receipt: sha256Hex(`${REPAIR_DOMAIN}${canonicalJson(body)}`),
  };
}

describe("LC4 provider-exchange treatment authority", () => {
  it("derives the exact HACC model-visible control and tool frontier", () => {
    const plan = responsePlan();
    const signed = authority(plan);
    expect(assertLc4ProviderExchangeTreatmentBinding({
      projection: projection(plan),
      control_authority: signed.body as unknown as JsonValue,
      control_receipt_sha256: signed.receipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc",
      playback_kind: "canonical",
      repair_decision: null,
      repair_decision_receipt_sha256: null,
      canonical_provider_exchange_sha256: null,
      expected_previous_provider_exchange_sha256: null,
      expected_previous_hacc_response_plan_sha256: null,
    })).toMatchObject({
      initial_response_plan_sha256: plan.plan_sha256,
      terminal_response_plan_sha256: plan.plan_sha256,
      terminal_response_control_sha256: plan.plan_sha256,
      initial_flow_state_sha256: plan.state_sha256,
      terminal_flow_state_sha256: plan.state_sha256,
    });
  });

  it("rejects a consistently rehashed substituted response plan", () => {
    const signedPlan = responsePlan();
    const substituted = responsePlan(2, signedPlan.plan_sha256);
    const signed = authority(signedPlan);
    expect(() => assertLc4ProviderExchangeTreatmentBinding({
      projection: projection(substituted),
      control_authority: signed.body as unknown as JsonValue,
      control_receipt_sha256: signed.receipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc",
      playback_kind: "canonical",
      repair_decision: null,
      repair_decision_receipt_sha256: null,
      canonical_provider_exchange_sha256: null,
      expected_previous_provider_exchange_sha256: null,
      expected_previous_hacc_response_plan_sha256: null,
    })).toThrow(/signed control authority/u);
  });

  it("rejects rehashed rendered-control, terminal-control, and frontier substitutions", () => {
    const plan = responsePlan();
    const signed = authority(plan);
    const valid = projection(plan) as unknown as Record<string, JsonValue>;
    const mutations = [
      {
        ...valid,
        rendered_control_context: "substituted model-visible context",
        response_plan_delivery_sha256: sha256Hex(
          "substituted model-visible context",
        ),
      },
      {
        ...valid,
        terminal_response_control_sha256: sha256Hex(
          "substituted terminal response control",
        ),
      },
      {
        ...valid,
        tool_frontier_sha256: sha256Hex("substituted tool frontier"),
      },
    ];
    for (const mutation of mutations) {
      expect(() => assertLc4ProviderExchangeTreatmentBinding({
        projection: mutation,
        control_authority: signed.body as unknown as JsonValue,
        control_receipt_sha256: signed.receipt,
        episode_id: EPISODE,
        opportunity_id: OPPORTUNITY,
        opportunity_index: 1,
        arm: "hacc",
        playback_kind: "canonical",
        repair_decision: null,
        repair_decision_receipt_sha256: null,
        canonical_provider_exchange_sha256: null,
        expected_previous_provider_exchange_sha256: null,
        expected_previous_hacc_response_plan_sha256: null,
      })).toThrow();
    }
  });

  it("requires the repair exchange to bind the exact signed decision", () => {
    const plan = responsePlan();
    const signed = authority(plan);
    const canonicalExchange = sha256Hex("canonical provider exchange");
    const decision = repairDecision({
      controlReceipt: signed.receipt,
      canonicalExchange,
    });
    const repairProjection = projection(plan, "repair") as unknown as
      Record<string, JsonValue>;
    repairProjection.repair_decision_receipt_sha256 = decision.receipt;
    expect(assertLc4ProviderExchangeTreatmentBinding({
      projection: repairProjection,
      control_authority: signed.body as unknown as JsonValue,
      control_receipt_sha256: signed.receipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc",
      playback_kind: "repair",
      repair_decision: decision.body as unknown as JsonValue,
      repair_decision_receipt_sha256: decision.receipt,
      canonical_provider_exchange_sha256: canonicalExchange,
      expected_previous_provider_exchange_sha256: null,
      expected_previous_hacc_response_plan_sha256: null,
    })).toMatchObject({
      repair_decision_receipt_sha256: decision.receipt,
    });

    const reboundBody = {
      ...decision.body,
      canonical_control_receipt_sha256: sha256Hex(
        "substituted canonical control",
      ),
    };
    const reboundReceipt = sha256Hex(
      `${REPAIR_DOMAIN}${canonicalJson(reboundBody)}`,
    );
    repairProjection.repair_decision_receipt_sha256 = reboundReceipt;
    expect(() => assertLc4ProviderExchangeTreatmentBinding({
      projection: repairProjection,
      control_authority: signed.body as unknown as JsonValue,
      control_receipt_sha256: signed.receipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc",
      playback_kind: "repair",
      repair_decision: reboundBody as unknown as JsonValue,
      repair_decision_receipt_sha256: reboundReceipt,
      canonical_provider_exchange_sha256: canonicalExchange,
      expected_previous_provider_exchange_sha256: null,
      expected_previous_hacc_response_plan_sha256: null,
    })).toThrow(/canonical control/u);
  });

  it("rejects a consistently rehashed fork from the prior exchange or HACC plan", () => {
    const priorExchange = sha256Hex("prior canonical exchange");
    const priorPlan = sha256Hex("prior terminal HACC plan");
    const plan = responsePlan(2, priorPlan);
    const signed = authority(plan);
    const forkedAuthority = {
      ...signed.body,
      previous_exchange_sha256: priorExchange,
    };
    const forkedReceipt = sha256Hex(
      `${CONTROL_DOMAIN}${canonicalJson(forkedAuthority)}`,
    );
    const valid = {
      projection: projection(plan),
      control_authority: forkedAuthority as unknown as JsonValue,
      control_receipt_sha256: forkedReceipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc" as const,
      playback_kind: "canonical" as const,
      repair_decision: null,
      repair_decision_receipt_sha256: null,
      canonical_provider_exchange_sha256: null,
      expected_previous_provider_exchange_sha256: priorExchange,
      expected_previous_hacc_response_plan_sha256: priorPlan,
    };
    expect(assertLc4ProviderExchangeTreatmentBinding(valid)).toMatchObject({
      previous_provider_exchange_sha256: priorExchange,
      previous_hacc_response_plan_sha256: priorPlan,
    });
    expect(() => assertLc4ProviderExchangeTreatmentBinding({
      ...valid,
      expected_previous_provider_exchange_sha256:
        sha256Hex("substituted prior exchange"),
    })).toThrow(/forks from the prior effective/u);
    expect(() => assertLc4ProviderExchangeTreatmentBinding({
      ...valid,
      expected_previous_hacc_response_plan_sha256:
        sha256Hex("substituted prior plan"),
    })).toThrow(/forks from retained terminal plan/u);
  });

  it("derives post-tool terminal Flow state from the ordered gateway authority", () => {
    const initialPlan = responsePlan();
    const reboundPlan = responsePlan(
      2,
      initialPlan.plan_sha256,
      "2026-07-21T00:00:01.000Z",
    );
    expect(reboundPlan.state_sha256).not.toBe(initialPlan.state_sha256);
    const transitionBinding = sha256Hex("post-tool transition binding");
    const receiptSet = reboundGatewayReceiptSet({
      plan: reboundPlan,
      transition_binding_sha256: transitionBinding,
    });
    const responseControl = receiptSet.authority_projections[0]!
      .post_transition_response_control;
    const signed = authority(initialPlan);
    const reboundProjection = {
      ...(projection(initialPlan) as unknown as Record<string, JsonValue>),
      dev_gateway_receipt_set: receiptSet,
      terminal_response_plan_sha256: reboundPlan.plan_sha256,
      terminal_response_control_sha256:
        sha256Hex(canonicalJson(responseControl)),
    };
    const common = {
      projection: reboundProjection,
      control_authority: signed.body as unknown as JsonValue,
      control_receipt_sha256: signed.receipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc" as const,
      playback_kind: "canonical" as const,
      repair_decision: null,
      repair_decision_receipt_sha256: null,
      canonical_provider_exchange_sha256: null,
      expected_previous_provider_exchange_sha256: null,
      expected_previous_hacc_response_plan_sha256: null,
    };
    expect(assertLc4ProviderExchangeTreatmentBinding(common)).toMatchObject({
      initial_response_plan_sha256: initialPlan.plan_sha256,
      terminal_response_plan_sha256: reboundPlan.plan_sha256,
      initial_flow_state_sha256: initialPlan.state_sha256,
      terminal_flow_state_sha256: reboundPlan.state_sha256,
    });
    expect(() => assertLc4ProviderExchangeTreatmentBinding({
      ...common,
      projection: {
        ...reboundProjection,
        terminal_response_plan_sha256:
          sha256Hex("self-consistent substituted terminal plan"),
      },
    })).toThrow(/derived authority chain/u);
  });

  it("recomputes the runtime response-plan chain and leaves repairs non-advancing", () => {
    const preflight = sha256Hex("treatment preflight");
    const genesis = lc4DevResponsePlanChainGenesis(preflight, EPISODE);
    const canonical = advanceLc4DevResponsePlanChain({
      previous_chain_head_sha256: genesis,
      playback_kind: "canonical",
      control_receipt_sha256: sha256Hex("control receipt"),
      initial_response_plan_sha256: sha256Hex("initial response plan"),
      provider_exchange_sha256: sha256Hex("provider exchange"),
      terminal_response_plan_sha256: sha256Hex("terminal response plan"),
      terminal_response_control_sha256: sha256Hex("terminal control"),
    });
    expect(canonical).not.toBe(genesis);
    expect(advanceLc4DevResponsePlanChain({
      previous_chain_head_sha256: canonical,
      playback_kind: "repair",
      control_receipt_sha256: sha256Hex("control receipt"),
      initial_response_plan_sha256: sha256Hex("initial response plan"),
      provider_exchange_sha256: sha256Hex("repair provider exchange"),
      terminal_response_plan_sha256: sha256Hex("terminal response plan"),
      terminal_response_control_sha256: sha256Hex("terminal control"),
    })).toBe(canonical);
    const terminalFlowState = sha256Hex("terminal flow state");
    const packet = {
      packet_type: "hacc_provider_conversation_plus_structured_state",
      flow_state_sha256: terminalFlowState,
      response_plan_chain_head_sha256: canonical,
    };
    expect(() => assertLc4HaccRotationTreatmentCheckpoint({
      packet: packet as unknown as JsonValue,
      terminal_flow_state_sha256: terminalFlowState,
      response_plan_chain_head_sha256: canonical,
    })).not.toThrow();
    for (const mutation of [
      {
        ...packet,
        flow_state_sha256: sha256Hex("substituted terminal flow state"),
      },
      {
        ...packet,
        response_plan_chain_head_sha256:
          sha256Hex("substituted response-plan chain"),
      },
    ]) {
      expect(() => assertLc4HaccRotationTreatmentCheckpoint({
        packet: mutation as unknown as JsonValue,
        terminal_flow_state_sha256: terminalFlowState,
        response_plan_chain_head_sha256: canonical,
      })).toThrow(/independently replayed treatment chain/u);
    }
  });

  it("keeps the post-tool canonical checkpoint through repair, next control, and rotation", () => {
    const initialPlan = responsePlan();
    const reboundPlan = responsePlan(
      2,
      initialPlan.plan_sha256,
      "2026-07-21T00:00:01.000Z",
    );
    const signed = authority(initialPlan);
    const receiptSet = reboundGatewayReceiptSet({
      plan: reboundPlan,
      transition_binding_sha256: sha256Hex(
        "combined post-tool transition binding",
      ),
    });
    const reboundControl = receiptSet.authority_projections[0]!
      .post_transition_response_control;
    const canonicalProjection = {
      ...(projection(initialPlan) as unknown as Record<string, JsonValue>),
      dev_gateway_receipt_set: receiptSet,
      terminal_response_plan_sha256: reboundPlan.plan_sha256,
      terminal_response_control_sha256:
        sha256Hex(canonicalJson(reboundControl)),
    };
    const canonicalBinding = assertLc4ProviderExchangeTreatmentBinding({
      projection: canonicalProjection,
      control_authority: signed.body as unknown as JsonValue,
      control_receipt_sha256: signed.receipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc",
      playback_kind: "canonical",
      repair_decision: null,
      repair_decision_receipt_sha256: null,
      canonical_provider_exchange_sha256: null,
      expected_previous_provider_exchange_sha256: null,
      expected_previous_hacc_response_plan_sha256: null,
    });
    const canonicalExchange = sha256Hex("combined canonical exchange");
    const decision = repairDecision({
      controlReceipt: signed.receipt,
      canonicalExchange,
    });
    const repairProjection = projection(
      initialPlan,
      "repair",
    ) as unknown as Record<string, JsonValue>;
    repairProjection.repair_decision_receipt_sha256 = decision.receipt;
    const repairBinding = assertLc4ProviderExchangeTreatmentBinding({
      projection: repairProjection,
      control_authority: signed.body as unknown as JsonValue,
      control_receipt_sha256: signed.receipt,
      episode_id: EPISODE,
      opportunity_id: OPPORTUNITY,
      opportunity_index: 1,
      arm: "hacc",
      playback_kind: "repair",
      repair_decision: decision.body as unknown as JsonValue,
      repair_decision_receipt_sha256: decision.receipt,
      canonical_provider_exchange_sha256: canonicalExchange,
      expected_previous_provider_exchange_sha256: null,
      expected_previous_hacc_response_plan_sha256:
        canonicalBinding.previous_hacc_response_plan_sha256,
    });
    expect(repairBinding.terminal_response_plan_sha256)
      .toBe(initialPlan.plan_sha256);
    expect(canonicalBinding.terminal_response_plan_sha256)
      .toBe(reboundPlan.plan_sha256);

    const genesis = lc4DevResponsePlanChainGenesis(
      sha256Hex("combined preflight"),
      EPISODE,
    );
    const canonicalChain = advanceLc4DevResponsePlanChain({
      previous_chain_head_sha256: genesis,
      playback_kind: "canonical",
      control_receipt_sha256: canonicalBinding.control_receipt_sha256,
      initial_response_plan_sha256:
        canonicalBinding.initial_response_plan_sha256,
      provider_exchange_sha256: canonicalExchange,
      terminal_response_plan_sha256:
        canonicalBinding.terminal_response_plan_sha256,
      terminal_response_control_sha256:
        canonicalBinding.terminal_response_control_sha256,
    });
    expect(advanceLc4DevResponsePlanChain({
      previous_chain_head_sha256: canonicalChain,
      playback_kind: "repair",
      control_receipt_sha256: repairBinding.control_receipt_sha256,
      initial_response_plan_sha256:
        repairBinding.initial_response_plan_sha256,
      provider_exchange_sha256: sha256Hex("combined repair exchange"),
      terminal_response_plan_sha256:
        repairBinding.terminal_response_plan_sha256,
      terminal_response_control_sha256:
        repairBinding.terminal_response_control_sha256,
    })).toBe(canonicalChain);

    const nextCallerPlan = responsePlan(
      3,
      canonicalBinding.terminal_response_plan_sha256,
      "2026-07-21T00:00:02.000Z",
    );
    expect(nextCallerPlan.previous_plan_sha256)
      .toBe(canonicalBinding.terminal_response_plan_sha256);
    expect(() => assertLc4HaccRotationTreatmentCheckpoint({
      packet: {
        packet_type: "hacc_provider_conversation_plus_structured_state",
        flow_state_sha256: canonicalBinding.terminal_flow_state_sha256,
        response_plan_chain_head_sha256: canonicalChain,
      } as unknown as JsonValue,
      terminal_flow_state_sha256:
        canonicalBinding.terminal_flow_state_sha256,
      response_plan_chain_head_sha256: canonicalChain,
    })).not.toThrow();
  });
});
