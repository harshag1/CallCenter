import { describe, expect, it, vi } from "vitest";

import { createMembershipSummaryTool } from "../../../examples/operator-tools/membership-summary";
import type {
  OperatorTool,
  OperatorToolExtension,
} from "../agent/types";
import {
  admitOperatorToolExtensions,
  isAdmittedOperatorToolExtension,
} from "../agent/tools/extension-contract";

function extension(
  effect: "read" | "internal_write",
): OperatorToolExtension {
  return {
    name: `example_${effect}`,
    description: "Example extension",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    security: {
      effect,
      tenant_scoped: true,
    },
    async execute() {
      return { output: { ok: true } };
    },
  };
}

describe("operator tool extension admission", () => {
  it("admits exactly tenant-scoped read and internal-write extensions", () => {
    const read = extension("read");
    const internalWrite = extension("internal_write");

    expect(admitOperatorToolExtensions([read, internalWrite]))
      .toEqual([read, internalWrite]);
    expect(isAdmittedOperatorToolExtension(read)).toBe(true);
    expect(isAdmittedOperatorToolExtension(internalWrite)).toBe(true);
  });

  it("fails closed when untyped manifests omit or widen security metadata", () => {
    const base = {
      name: "unsafe_extension",
      description: "Unsafe extension",
      parameters: { type: "object" },
      async execute() {
        return { output: null };
      },
    };
    const missing = base as OperatorTool;
    const external = {
      ...base,
      security: { effect: "external_write", tenant_scoped: true },
    } as unknown as OperatorTool;
    const crossTenant = {
      ...base,
      security: { effect: "read", tenant_scoped: false },
    } as unknown as OperatorTool;

    expect(admitOperatorToolExtensions([
      missing,
      external,
      crossTenant,
      null,
      "not a tool",
      { security: { effect: "read", tenant_scoped: true } },
    ]))
      .toEqual([]);
    expect(isAdmittedOperatorToolExtension(missing)).toBe(false);
    expect(isAdmittedOperatorToolExtension(external)).toBe(false);
    expect(isAdmittedOperatorToolExtension(crossTenant)).toBe(false);
  });

  it("keeps the compiling example scoped to the authenticated organization", async () => {
    const findSummary = vi.fn(async () => ({
      membershipId: "member-7",
      plan: "Plus",
      expiresAt: "2027-01-01",
    }));
    const tool = createMembershipSummaryTool({ findSummary });
    const ctx = {
      orgId: "org-from-authentication",
      email: "operator@example.test",
      agentId: null,
      origin: "https://app.example.test",
    };

    expect(isAdmittedOperatorToolExtension(tool)).toBe(true);
    await expect(tool.execute({ membership_id: "member-7" }, ctx))
      .resolves.toEqual({
        output: {
          found: true,
          membership: {
            membershipId: "member-7",
            plan: "Plus",
            expiresAt: "2027-01-01",
          },
        },
      });
    expect(findSummary).toHaveBeenCalledWith({
      orgId: "org-from-authentication",
      membershipId: "member-7",
    });
  });
});
