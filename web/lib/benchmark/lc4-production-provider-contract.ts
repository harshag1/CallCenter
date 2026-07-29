/**
 * Dependency-neutral identity for the provider adapter implementation.
 *
 * This constant lives outside both the DEV runner and provider adapter so
 * signed qualification bindings cannot create an import cycle between them.
 */
export const LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION =
  "lc4-production-provider-adapter-v4" as const;

/**
 * Runtime-nominal capability carried only by the concrete production adapter
 * and explicit in-process test doubles. Plain structural lookalikes cannot
 * enter the paid Gate D seam by copying its public kind and digest.
 */
export const LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY:
  unique symbol = Symbol("hacc.lc4.xai-gate-d.production-adapter");
