/**
 * Deployment environment provider credentials are a shared billing authority.
 *
 * The public application does not yet have a tenant-scoped BYOK read path or a
 * durable, provider-enforced budget reservation for builder inference and
 * browser realtime sessions. Keep both routes unavailable in production until
 * one of those authorities exists. This local-development escape hatch is for
 * a developer spending their own key on their own machine; production ignores
 * it even when the variable is accidentally copied into a deployment.
 */
export function allowsLocalDevelopmentFundedAi(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (
    env.NODE_ENV === "production"
    || env.ALLOW_DEV_DEPLOYMENT_FUNDED_AI !== "true"
  ) return false;
  try {
    const origin = new URL(env.PUBLIC_ORIGIN ?? "");
    return origin.protocol === "http:"
      && (origin.hostname === "localhost"
        || origin.hostname === "127.0.0.1"
        || origin.hostname === "[::1]");
  } catch {
    return false;
  }
}
