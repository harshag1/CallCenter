import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  assertProductionTurnContract,
  canonicalRuntimeControlJson,
  createProductionTurnContract,
  runtimeControlSha256,
  turnContractCanonicalPayloadBytes,
  type TurnContractFreshness,
  type TurnContractSource,
} from "../index";

const hash = (label: string) => runtimeControlSha256("test/turn-contract/v1\n", label);

function source(): TurnContractSource {
  return {
    conversation: {
      conversation_id: "conversation.public-1",
      revision: 41,
      head_sha256: hash("conversation-head-41"),
    },
    public_identifier_registry_sha256: hash("public-registry-v1"),
    control_plane: {
      mode: "unified",
      flow: { revision: 17, capability_epoch: 9, state_sha256: hash("flow-17") },
      mission: { revision: 23, capability_epoch: 9, state_sha256: hash("mission-23") },
    },
    capability_epoch: 9,
    frontier: {
      eligible_intents: ["return.route", "return.lookup"],
      eligible_actions: [
        { action_id: "return.lookup", effect: "read", purpose: "reconciliation", policy_sha256: hash("return.lookup.policy"), semantic_sha256: hash("return.lookup.v1") },
        { action_id: "return.submit", effect: "write", purpose: "operation", policy_sha256: hash("return.submit.policy"), semantic_sha256: hash("return.submit.v1") },
      ],
    },
    required_slots: [
      { slot_id: "order_id", status: "present" },
      { slot_id: "return_reason", status: "missing" },
    ],
    claims: {
      allowed: [
        { claim_id: "return.lookup.complete", claim_class: "effect_success", supporting_receipt_id: "receipt.lookup", supporting_action_id: "return.lookup", claim_semantic_sha256: hash("claim.return.lookup.complete") },
        { claim_id: "return.reason.ask", claim_class: "clarification", supporting_receipt_id: null, supporting_action_id: null, claim_semantic_sha256: hash("claim.return.reason.ask") },
      ],
      prohibited: [
        { claim_id: "return.submit.complete", claim_class: "terminal_success", reason_code: "missing_authoritative_receipt" },
        { claim_id: "verification.repeat", claim_class: "private_value", reason_code: "private_value_never_provider_visible" },
      ],
    },
    receipts: [{
      receipt_id: "receipt.lookup",
      action_id: "return.lookup",
      action_semantic_sha256: hash("return.lookup.v1"),
      capability_epoch: 9,
      status: "succeeded",
      settled_revision: 40,
      receipt_sha256: hash("receipt.lookup"),
    }],
    workers: [{
      worker_id: "worker.policy",
      goal_id: "goal.return",
      generation: 1,
      status: "succeeded",
      authority_revision: 39,
      capability_epoch: 9,
      authority_sha256: hash("worker.policy.authority"),
    }],
    ambiguities: [],
    lifecycle: { status: "active", refresh_required: false, preferred_response_mode: "act" },
  };
}

function freshness(value = source()): TurnContractFreshness {
  return {
    conversation_id: value.conversation.conversation_id,
    conversation_revision: value.conversation.revision,
    conversation_head_sha256: value.conversation.head_sha256,
    flow_revision: value.control_plane.flow?.revision ?? null,
    flow_state_sha256: value.control_plane.flow?.state_sha256 ?? null,
    mission_revision: value.control_plane.mission?.revision ?? null,
    mission_state_sha256: value.control_plane.mission?.state_sha256 ?? null,
    capability_epoch: value.capability_epoch,
    public_identifier_registry_sha256: value.public_identifier_registry_sha256,
  };
}

function expectation(contract: { contract_sha256: string }, value = source()) {
  return { ...freshness(value), expected_contract_sha256: contract.contract_sha256 };
}

function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const output = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target]!, output[index]!];
  }
  return output;
}

describe("production state-derived Turn Contract", () => {
  it("binds every authority plane and exposes only public identifiers, statuses, and digests", () => {
    const contract = createProductionTurnContract(source(), freshness());
    expect(contract).toMatchObject({
      conversation: { revision: 41, head_sha256: hash("conversation-head-41") },
      control_plane: {
        mode: "unified",
        flow: { revision: 17, capability_epoch: 9 },
        mission: { revision: 23, capability_epoch: 9 },
      },
      capability_epoch: 9,
      eligible_intents: ["return.lookup", "return.route"],
      eligible_actions: [
        { action_id: "return.lookup", semantic_sha256: hash("return.lookup.v1") },
        { action_id: "return.submit", semantic_sha256: hash("return.submit.v1") },
      ],
      required_slots: [
        { slot_id: "order_id", status: "present" },
        { slot_id: "return_reason", status: "missing" },
      ],
      response_mode: "act",
      canonical_payload_encoding: "utf8_canonical_json",
    });
    expect(contract.prohibited_claims).toContainEqual({
      claim_id: "system.private_value.repeat",
      claim_class: "private_value",
      reason_code: "runtime_values_are_not_provider_context",
    });
    const bytes = turnContractCanonicalPayloadBytes(contract);
    expect(bytes.byteLength).toBe(contract.canonical_payload_byte_length);
    expect(Buffer.from(bytes).toString("utf8")).not.toContain("canonical_payload_byte_length");
    expect(assertProductionTurnContract(structuredClone(contract), expectation(contract))).toEqual(contract);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.control_plane)).toBe(true);
  });

  it("rejects stale conversation, Flow, Mission, and capability bindings independently", () => {
    const current = source();
    const expected = freshness(current);
    for (const stale of [
      { ...expected, conversation_revision: expected.conversation_revision + 1 },
      { ...expected, conversation_head_sha256: hash("different-head") },
      { ...expected, flow_revision: (expected.flow_revision ?? 0) + 1 },
      { ...expected, mission_revision: (expected.mission_revision ?? 0) + 1 },
      { ...expected, capability_epoch: expected.capability_epoch + 1 },
    ]) {
      expect(() => createProductionTurnContract(current, stale)).toThrowError(
        expect.objectContaining({ code: "turn_contract_stale" }),
      );
    }
    expect(() => createProductionTurnContract({
      ...current,
      control_plane: {
        ...current.control_plane,
        flow: { ...current.control_plane.flow!, capability_epoch: 8 },
      },
    }, expected)).toThrow(/capability epochs disagree/);
  });

  it("fails closed to only designated reconciliation actions and suppresses success claims", () => {
    const current = source();
    const ambiguous: TurnContractSource = {
      ...current,
      receipts: [...current.receipts, {
        receipt_id: "receipt.submit",
        action_id: "return.submit",
        action_semantic_sha256: hash("return.submit.v1"),
        capability_epoch: 9,
        status: "indeterminate",
        settled_revision: 41,
        receipt_sha256: hash("receipt.submit.indeterminate"),
      }],
      ambiguities: [{
        ambiguity_id: "ambiguity.submit",
        reason_code: "connection_lost_after_dispatch",
        receipt_id: "receipt.submit",
        designated_reconciliation_actions: ["return.lookup"],
      }],
    };
    const contract = createProductionTurnContract(ambiguous, freshness(ambiguous));
    expect(contract.response_mode).toBe("reconcile");
    expect(contract.eligible_actions.map((action) => action.action_id)).toEqual(["return.lookup"]);
    expect(contract.allowed_claims).toEqual([
      { claim_id: "return.reason.ask", claim_class: "clarification", supporting_receipt_id: null, supporting_action_id: null, claim_semantic_sha256: hash("claim.return.reason.ask") },
    ]);

    const noRepair: TurnContractSource = {
      ...ambiguous,
      ambiguities: [{ ...ambiguous.ambiguities[0]!, designated_reconciliation_actions: [] }],
    };
    const closed = createProductionTurnContract(noRepair, freshness(noRepair));
    expect(closed.response_mode).toBe("fail_closed");
    expect(closed.eligible_actions).toEqual([]);
  });

  it("rejects unquarantined indeterminate effects and unsupported success claims", () => {
    const current = source();
    expect(() => createProductionTurnContract({
      ...current,
      receipts: [{ ...current.receipts[0]!, status: "indeterminate" }],
      claims: {
        ...current.claims,
        allowed: [{ claim_id: "return.reason.ask", claim_class: "clarification", supporting_receipt_id: null, supporting_action_id: null, claim_semantic_sha256: hash("claim.return.reason.ask") }],
      },
    }, freshness(current))).toThrow(/lacks an ambiguity quarantine/);
    expect(() => createProductionTurnContract({
      ...current,
      claims: {
        ...current.claims,
        allowed: [{ claim_id: "return.done", claim_class: "terminal_success", supporting_receipt_id: null, supporting_action_id: null, claim_semantic_sha256: hash("claim.return.done") }],
      },
    }, freshness(current))).toThrow(/success claims require an authoritative settled receipt/);

    expect(() => createProductionTurnContract({
      ...current,
      claims: { ...current.claims, allowed: [{
        ...current.claims.allowed[0]!,
        supporting_action_id: "return.submit",
      }] },
    }, freshness(current))).toThrow(/belongs to a different action/);
    expect(() => createProductionTurnContract({
      ...current,
      receipts: [{ ...current.receipts[0]!, status: "compensated" }],
    }, freshness(current))).toThrow(/success claims require an authoritative settled receipt/);
  });

  it("rejects mutating reconciliation capabilities and epoch-stale receipts or workers", () => {
    const current = source();
    const ambiguousReceipt = {
      receipt_id: "receipt.submit",
      action_id: "return.submit",
      action_semantic_sha256: hash("return.submit.v1"),
      capability_epoch: 9,
      status: "indeterminate" as const,
      settled_revision: 41,
      receipt_sha256: hash("receipt.submit.indeterminate"),
    };
    expect(() => createProductionTurnContract({
      ...current,
      receipts: [...current.receipts, ambiguousReceipt],
      ambiguities: [{
        ambiguity_id: "ambiguity.submit", reason_code: "lost_after_dispatch",
        receipt_id: "receipt.submit", designated_reconciliation_actions: ["return.submit"],
      }],
    }, freshness(current))).toThrow(/not a read-only repair capability/);
    expect(() => createProductionTurnContract({
      ...current,
      receipts: [{ ...current.receipts[0]!, capability_epoch: 8 }],
    }, freshness(current))).toThrow(/receipt belongs to a stale capability epoch/);
    expect(() => createProductionTurnContract({
      ...current,
      workers: [{ ...current.workers[0]!, capability_epoch: 8 }],
    }, freshness(current))).toThrow(/worker authority/);
  });

  it("refuses terminal contracts with unresolved effects or workers", () => {
    const current = source();
    const terminal: TurnContractSource = {
      ...current,
      lifecycle: { status: "completed", refresh_required: false, preferred_response_mode: "terminal" },
      workers: [{ ...current.workers[0]!, status: "running" }],
    };
    expect(() => createProductionTurnContract(terminal, freshness(terminal))).toThrow(/terminal state retains unresolved/);
  });

  it("derives recover and terminal modes from bound lifecycle state rather than provider preference", () => {
    const current = source();
    const refreshing: TurnContractSource = {
      ...current,
      lifecycle: { ...current.lifecycle, refresh_required: true },
    };
    const recovery = createProductionTurnContract(refreshing, freshness(refreshing));
    expect(recovery.response_mode).toBe("recover");
    expect(recovery.eligible_actions).toEqual([]);
    expect(recovery.allowed_claims).toEqual([
      { claim_id: "return.reason.ask", claim_class: "clarification", supporting_receipt_id: null, supporting_action_id: null, claim_semantic_sha256: hash("claim.return.reason.ask") },
    ]);
    expect(recovery.prohibited_claims).toContainEqual(expect.objectContaining({
      claim_id: "system.effect_success.stale_authority",
    }));

    const terminal: TurnContractSource = {
      ...current,
      lifecycle: { status: "completed", refresh_required: false, preferred_response_mode: "terminal" },
      claims: {
        ...current.claims,
        allowed: [{
          claim_id: "return.complete",
          claim_class: "terminal_success",
          supporting_receipt_id: "receipt.lookup",
          supporting_action_id: "return.lookup",
          claim_semantic_sha256: hash("claim.return.complete"),
        }],
      },
    };
    const completed = createProductionTurnContract(terminal, freshness(terminal));
    expect(completed.response_mode).toBe("terminal");
    expect(completed.eligible_actions).toEqual([]);
    expect(completed.eligible_intents).toEqual([]);
    expect(assertProductionTurnContract(completed, expectation(completed, terminal))).toEqual(completed);
  });

  it("cannot serialize future or private fixture values because all value-bearing fields are absent and strict", () => {
    const privateMarker = "PRIVATE-MEMBER-777";
    const futureMarker = "FUTURE-ANSWER-DO-NOT-EXPOSE";
    const current = source() as unknown as Record<string, unknown>;
    current.private_value = privateMarker;
    expect(() => createProductionTurnContract(current, freshness())).toThrow(/source is invalid/);

    const withSlotValue = source() as unknown as { required_slots: Array<Record<string, unknown>> };
    withSlotValue.required_slots[0]!.value = futureMarker;
    expect(() => createProductionTurnContract(withSlotValue, freshness())).toThrow(/source is invalid/);

    const serialized = JSON.stringify(createProductionTurnContract(source(), freshness()));
    expect(serialized).not.toContain(privateMarker);
    expect(serialized).not.toContain(futureMarker);
    expect(serialized).not.toMatch(/"(?:value|arguments|result|prompt|description|transcript)"/);
  });

  it("is deterministic over 500 seeded permutations and changes commitment for every authority mutation", () => {
    const baseline = source();
    const baselineContract = createProductionTurnContract(baseline, freshness(baseline));
    for (let seed = 1; seed <= 500; seed += 1) {
      const permuted: TurnContractSource = {
        ...baseline,
        frontier: {
          eligible_intents: seededShuffle(baseline.frontier.eligible_intents, seed),
          eligible_actions: seededShuffle(baseline.frontier.eligible_actions, seed ^ 0x55aa),
        },
        required_slots: seededShuffle(baseline.required_slots, seed ^ 0xaa55),
        claims: {
          allowed: seededShuffle(baseline.claims.allowed, seed ^ 0x1234),
          prohibited: seededShuffle(baseline.claims.prohibited, seed ^ 0x5678),
        },
        receipts: seededShuffle(baseline.receipts, seed ^ 0x9abc),
        workers: seededShuffle(baseline.workers, seed ^ 0xdef0),
      };
      expect(createProductionTurnContract(permuted, freshness(permuted)).contract_sha256)
        .toBe(baselineContract.contract_sha256);
    }

    const mutations: TurnContractSource[] = [
      { ...baseline, conversation: { ...baseline.conversation, head_sha256: hash("mutated-head") } },
      { ...baseline, control_plane: { ...baseline.control_plane, flow: { ...baseline.control_plane.flow!, revision: 18 } } },
      { ...baseline, control_plane: { ...baseline.control_plane, mission: { ...baseline.control_plane.mission!, revision: 24 } } },
      { ...baseline, capability_epoch: 10, control_plane: {
        ...baseline.control_plane,
        flow: { ...baseline.control_plane.flow!, capability_epoch: 10 },
        mission: { ...baseline.control_plane.mission!, capability_epoch: 10 },
      }, receipts: baseline.receipts.map((receipt) => ({ ...receipt, capability_epoch: 10 })),
      workers: baseline.workers.map((worker) => ({ ...worker, capability_epoch: 10 })) },
      { ...baseline, required_slots: [{ slot_id: "order_id", status: "missing" }, baseline.required_slots[1]!] },
      { ...baseline, workers: [{ ...baseline.workers[0]!, generation: 2 }] },
    ];
    for (const mutation of mutations) {
      expect(createProductionTurnContract(mutation, freshness(mutation)).contract_sha256)
        .not.toBe(baselineContract.contract_sha256);
    }
  });

  it("detects tampering even when the modified object remains schema-valid", () => {
    const contract = createProductionTurnContract(source(), freshness());
    const tampered = structuredClone(contract);
    tampered.required_slots[0] = { ...tampered.required_slots[0]!, status: "missing" };
    expect(() => assertProductionTurnContract(tampered, expectation(contract))).toThrow(/hash mismatch/);

    const forged = structuredClone(contract);
    forged.eligible_actions[1] = { ...forged.eligible_actions[1]!, action_id: "return.erase" };
    const forgedBytes = turnContractCanonicalPayloadBytes(forged);
    forged.canonical_payload_byte_length = forgedBytes.byteLength;
    forged.contract_sha256 = runtimeControlSha256(
      "harshas-amazing-call-center/runtime-control/turn-contract/v1\n",
      forgedBytes,
    );
    expect(() => assertProductionTurnContract(forged, expectation(contract)))
      .toThrow(/differs from the host-retained commitment/);
  });

  it("rejects ambiguous control planes and duplicate authority identities", () => {
    const current = source();
    expect(() => createProductionTurnContract({
      ...current,
      control_plane: { ...current.control_plane, mode: "flow", mission: current.control_plane.mission },
    }, freshness(current))).toThrow(/control-plane mode is ambiguous/);
    expect(() => createProductionTurnContract({
      ...current,
      frontier: { ...current.frontier, eligible_intents: ["return.route", "return.route"] },
    }, freshness(current))).toThrow(/duplicate identities/);
    expect(() => createProductionTurnContract({
      ...current,
      required_slots: [{ slot_id: "PRIVATE-MEMBER-777", status: "present" }],
    }, freshness(current))).toThrow(/source is invalid/);
    expect(() => createProductionTurnContract(current, {
      ...freshness(current),
      flow_state_sha256: hash("different-flow-state"),
    })).toThrow(/authority snapshot is stale/);
  });

  it("canonicalization rejects accessors, custom prototypes, cycles, and non-JSON values", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "executed";
      },
    });
    expect(() => canonicalRuntimeControlJson(accessor)).toThrow(/accessors/);
    expect(getterCalls).toBe(0);
    const hostileSource = Object.defineProperty(source(), "conversation", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return source().conversation;
      },
    });
    expect(() => createProductionTurnContract(hostileSource, freshness())).toThrow(/not inert JSON/);
    expect(getterCalls).toBe(0);
    expect(() => canonicalRuntimeControlJson(Object.create({ inherited: true }))).toThrow(/custom prototypes/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalRuntimeControlJson(cycle)).toThrow(/cycles/);
    expect(() => canonicalRuntimeControlJson({ bad: Number.NaN })).toThrow(/non-finite/);
  });

  it("keeps production contract compilation p95 below five milliseconds", () => {
    const current = source();
    const expected = freshness(current);
    for (let index = 0; index < 100; index += 1) createProductionTurnContract(current, expected);
    const durations: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const started = performance.now();
      createProductionTurnContract(current, expected);
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(5);
  });
});
