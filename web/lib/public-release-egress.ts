/**
 * Public releases fail closed for optional network egress. Development and
 * tests remain usable without production secrets; production requires both a
 * global acknowledgement and the exact capability flag.
 */
export const PUBLIC_RELEASE_EGRESS_FLAGS = Object.freeze({
  generatedToolDeployment: "HACC_ENABLE_GENERATED_TOOL_DEPLOYMENT_EGRESS",
  generatedToolInvocation: "HACC_ENABLE_GENERATED_TOOL_INVOCATION_EGRESS",
  operatorJsSandbox: "HACC_ENABLE_OPERATOR_JS_EGRESS",
  operatorWebSearch: "HACC_ENABLE_OPERATOR_WEB_SEARCH_EGRESS",
} as const);

export type PublicReleaseEgressCapability = keyof typeof PUBLIC_RELEASE_EGRESS_FLAGS;
export type PublicReleaseEgressEnvironment = Readonly<Record<string, string | undefined>>;

export function publicReleaseEgressEnabled(
  capability: PublicReleaseEgressCapability,
  environment: PublicReleaseEgressEnvironment = process.env
): boolean {
  if (environment.NODE_ENV === "development" || environment.NODE_ENV === "test") return true;
  return environment.HACC_ENABLE_EXTERNAL_EGRESS === "true"
    && environment[PUBLIC_RELEASE_EGRESS_FLAGS[capability]] === "true";
}

export function assertPublicReleaseEgressEnabled(
  capability: PublicReleaseEgressCapability
): void {
  if (!publicReleaseEgressEnabled(capability)) {
    throw new Error(`optional external egress is disabled (${capability})`);
  }
}
