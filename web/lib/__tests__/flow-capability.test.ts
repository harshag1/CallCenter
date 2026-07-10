import { describe, expect, it } from "vitest";
import { signFlowCapability, verifyFlowCapability } from "../flow-capability";

const secret = "test-secret-is-deliberately-longer-than-thirty-two-characters";
const subject = {
  callId: "call-1",
  agentId: "agent-1",
  orgId: "org-1",
  runtimeDigest: "a".repeat(64),
  capabilityEpoch: 4,
  step: "support.verify",
  attempt: 2,
  tool: "verify_customer",
};

describe("flow action capabilities", () => {
  it("binds a short-lived lease to the call, runtime, step attempt, epoch, and tool", () => {
    const signed = signFlowCapability(subject, { secret, nowMs: 1_000_000, ttlSeconds: 120, nonce: "nonce-1" });
    expect(verifyFlowCapability(signed.token, subject, { secret, nowMs: 1_060_000 })).toMatchObject({
      claims: { ...subject, typ: "flow-action-lease", v: 1, nonce: "nonce-1" },
    });
    expect(verifyFlowCapability(signed.token, { ...subject, tool: "issue_refund" }, { secret, nowMs: 1_060_000 })).toMatchObject({
      code: "capability_scope_mismatch",
    });
  });

  it("rejects tampering, expiry, and overlong lease lifetimes", () => {
    const signed = signFlowCapability(subject, { secret, nowMs: 1_000_000, ttlSeconds: 1 });
    expect(verifyFlowCapability(`${signed.token}x`, subject, { secret, nowMs: 1_000_000 })).toMatchObject({
      code: "invalid_capability",
    });
    expect(verifyFlowCapability(signed.token, subject, { secret, nowMs: 1_002_000 })).toMatchObject({
      code: "expired_capability",
    });
    expect(() => signFlowCapability(subject, { secret, ttlSeconds: 301 })).toThrow(/between 1 and 300/);
  });
});
