import { describe, expect, it } from "vitest";
import { evaluatePostDispatch, evaluatePreDispatch } from "../action-policy-kernel";

const H = (char: string) => char.repeat(64);
const AT = "2026-07-21T12:00:00.000Z";
const policy = {
  schema_version: 1,
  id: "membership.policy",
  version: "1",
  default_decision: "deny",
  actions: [{
    action: "renew_membership",
    effect: "write",
    require_all: [{
      kind: "fact", fact_id: "caller.identity_verified", operator: "equals", value: true,
      authorities: ["tool"], max_age_seconds: 300,
    }],
    deny_if_any: [{ kind: "argument", path: "amount", operator: "not_equals", value: 49 }],
    maximum_calls: 1,
    confirmation: { authorities: ["caller"], max_age_seconds: 60, readback_fields: ["amount"] },
    postconditions: [{ kind: "argument", path: "status", operator: "equals", value: "renewed" }],
    provider_visible_result_fields: ["status", "expires_at"],
  }],
} as const;

function input() {
  return {
    policy,
    action: "renew_membership",
    arguments: { amount: 49 },
    state_head_sha256: H("a"),
    state_revision: 7,
    capability_epoch: 3,
    facts: [{ fact_id: "caller.identity_verified", revision: 1, value: true, authority: "tool" as const,
      observed_at: "2026-07-21T11:59:00.000Z", evidence_sha256: H("b") }],
    receipts: [],
    prior_call_count: 0,
    now: AT,
  };
}

describe("action policy kernel", () => {
  it("fails closed for unknown actions and missing authoritative prerequisites", () => {
    expect(evaluatePreDispatch({ ...input(), action: "unknown_action" })).toMatchObject({
      decision: "deny", reason: "action_not_governed",
    });
    expect(evaluatePreDispatch({ ...input(), facts: [] })).toMatchObject({
      decision: "deny", reason: "required_evidence_missing",
    });
    expect(evaluatePreDispatch({ ...input(), arguments: { amount: 50 } })).toMatchObject({
      decision: "deny", reason: "deny_condition_matched",
    });
  });

  it("binds confirmation to exact arguments, revision, epoch, and fresh authority", () => {
    const challenge = evaluatePreDispatch(input());
    expect(challenge.decision).toBe("require_confirmation");
    const confirmation = {
      proposal_digest: challenge.proposal_digest,
      challenge_digest: challenge.challenge_digest!,
      authority: "caller" as const,
      confirmed_at: "2026-07-21T11:59:30.000Z",
      evidence_sha256: H("c"),
      state_revision: 7,
      capability_epoch: 3,
    };
    expect(evaluatePreDispatch({ ...input(), confirmation })).toMatchObject({ decision: "allow" });
    expect(evaluatePreDispatch({ ...input(), confirmation: {
      ...confirmation, challenge_digest: H("d"),
    } })).toMatchObject({ decision: "require_confirmation" });
    expect(evaluatePreDispatch({ ...input(), confirmation: {
      ...confirmation, confirmed_at: "2026-07-21T12:00:01.000Z",
    } })).toMatchObject({ decision: "require_confirmation" });
    expect(evaluatePreDispatch({ ...input(), state_revision: 8, confirmation })).toMatchObject({
      decision: "require_confirmation",
    });
    expect(evaluatePreDispatch({ ...input(), arguments: { amount: 48 }, confirmation })).toMatchObject({
      decision: "deny",
    });
  });

  it("rechecks authority after execution and never treats uncertain writes as rejected", () => {
    const challenge = evaluatePreDispatch(input());
    const allowed = evaluatePreDispatch({ ...input(), confirmation: {
      proposal_digest: challenge.proposal_digest, challenge_digest: challenge.challenge_digest!,
      authority: "caller", confirmed_at: "2026-07-21T11:59:30.000Z",
      evidence_sha256: H("c"), state_revision: 7, capability_epoch: 3,
    } });
    expect(evaluatePostDispatch({
      policy, pre_dispatch: allowed, current_state_head_sha256: H("d"), current_state_revision: 8,
      current_capability_epoch: 4, result: { status: "renewed", secret: "never disclose" },
    })).toMatchObject({ decision: "quarantine", provider_result: null });
    expect(evaluatePostDispatch({
      policy, pre_dispatch: allowed, current_state_head_sha256: H("a"), current_state_revision: 7,
      current_capability_epoch: 3, result: { status: "failed" },
    })).toMatchObject({ decision: "require_reconciliation", provider_result: null });
    expect(evaluatePostDispatch({
      policy, pre_dispatch: allowed, current_state_head_sha256: H("a"), current_state_revision: 7,
      current_capability_epoch: 3,
      result: { status: "renewed", expires_at: "2027-07-21", secret: "never disclose" },
    })).toMatchObject({
      decision: "accept",
      provider_result: { status: "renewed", expires_at: "2027-07-21" },
    });
    expect(evaluatePostDispatch({
      policy: { ...policy, version: "2" }, pre_dispatch: allowed,
      current_state_head_sha256: H("a"), current_state_revision: 7,
      current_capability_epoch: 3, result: { status: "renewed" },
    })).toMatchObject({ decision: "quarantine", reason: "policy_changed_after_decision" });
  });

  it("rejects future-dated authoritative facts", () => {
    expect(evaluatePreDispatch({
      ...input(),
      facts: [{ ...input().facts[0], observed_at: "2026-07-21T12:00:01.000Z" }],
    })).toMatchObject({ decision: "deny", reason: "required_evidence_missing" });
  });
});
