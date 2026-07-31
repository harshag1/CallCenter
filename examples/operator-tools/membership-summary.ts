import type {
  OperatorToolExtension,
  ToolCtx,
} from "../../web/lib/agent/types";

export type MembershipSummary = Readonly<{
  membershipId: string;
  plan: string;
  expiresAt: string;
}>;

/** Keep persistence behind an injected, tenant-aware interface. The extension
 * never receives a caller-supplied organization ID. */
export type MembershipReader = Readonly<{
  findSummary(input: Readonly<{
    orgId: string;
    membershipId: string;
  }>): Promise<MembershipSummary | null>;
}>;

export function createMembershipSummaryTool(
  memberships: MembershipReader,
): OperatorToolExtension {
  return {
    name: "lookup_membership_summary",
    description: "Look up a membership plan and expiration date in this organization.",
    parameters: {
      type: "object",
      properties: {
        membership_id: {
          type: "string",
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ["membership_id"],
      additionalProperties: false,
    },
    security: {
      effect: "read",
      tenant_scoped: true,
    },
    async execute(args: Record<string, unknown>, ctx: ToolCtx) {
      const membershipId = args.membership_id;
      if (typeof membershipId !== "string" || membershipId.length === 0) {
        return { output: { error: "membership_id is required" } };
      }

      const membership = await memberships.findSummary({
        orgId: ctx.orgId,
        membershipId,
      });
      return {
        output: membership
          ? { found: true, membership }
          : { found: false },
      };
    },
  };
}
