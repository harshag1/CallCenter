import "server-only";

import { allowsLocalDevelopmentFundedAi } from "../deployment-funded-ai";
import type {
  LocalDeploymentBrowserFundingAuthority,
  VoiceProviderId,
} from "./types";

type ProviderEnvironmentName =
  | "XAI_API_KEY"
  | "OPENAI_API_KEY"
  | "GEMINI_API_KEY";

const PROVIDER_ENVIRONMENT_NAME: Readonly<Record<
  VoiceProviderId,
  ProviderEnvironmentName
>> = Object.freeze({
  xai: "XAI_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
});

const LOCAL_BROWSER_FUNDING_AUTHORITIES = new WeakMap<
  object,
  Readonly<{
    provider: VoiceProviderId;
    deploymentEnvironmentName: ProviderEnvironmentName;
    root: string;
  }>
>();
const BUILT_IN_PROVIDERS = new Set<VoiceProviderId>([
  "xai",
  "openai",
  "gemini",
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MIN_ROOT_LENGTH = 16;
const MAX_ROOT_LENGTH = 4 * 1024;

/**
 * Mint a process-local capability only after the shared deployment key is
 * independently authorized for plain-HTTP loopback development.
 *
 * The marker is deliberately tracked by object identity. Reconstructing its
 * enumerable fields, copying it, or casting a lookalike cannot create funding
 * authority at runtime.
 */
export function authorizeLocalDeploymentBrowserFunding<
  Id extends VoiceProviderId,
>(provider: Id): LocalDeploymentBrowserFundingAuthority<Id> | null {
  if (!BUILT_IN_PROVIDERS.has(provider) || !allowsLocalDevelopmentFundedAi()) {
    return null;
  }
  const deploymentEnvironmentName = PROVIDER_ENVIRONMENT_NAME[provider];
  const root = process.env[deploymentEnvironmentName];
  if (!isValidProviderRoot(root)) return null;
  const authority = Object.freeze({
    source: "local_deployment_authorized" as const,
    provider,
  }) as LocalDeploymentBrowserFundingAuthority<Id>;
  LOCAL_BROWSER_FUNDING_AUTHORITIES.set(authority, Object.freeze({
    provider,
    deploymentEnvironmentName,
    root,
  }));
  return authority;
}

export function isAuthorizedLocalDeploymentBrowserFunding<
  Id extends VoiceProviderId,
>(
  value: unknown,
  provider: Id,
): value is LocalDeploymentBrowserFundingAuthority<Id> {
  const record = value && typeof value === "object"
    ? LOCAL_BROWSER_FUNDING_AUTHORITIES.get(value as object)
    : undefined;
  return Boolean(
    record
    && (value as { source?: unknown }).source === "local_deployment_authorized"
    && (value as { provider?: unknown }).provider === provider
    && record.provider === provider,
  );
}

function isValidProviderRoot(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)
  ) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= MIN_ROOT_LENGTH && bytes <= MAX_ROOT_LENGTH;
}

export type BrowserFundingAuthorityKind =
  | "tenant_byok"
  | "local_deployment_authorized";

export function browserFundingAuthorityKind(
  value: unknown,
  provider: VoiceProviderId,
): BrowserFundingAuthorityKind | null {
  if (
    value
    && typeof value === "object"
    && (value as { source?: unknown }).source === "tenant_byok"
  ) {
    const candidate = value as {
      provider?: unknown;
      apiKey?: unknown;
    };
    return provider !== "gemini"
      && candidate.provider === provider
      && isValidProviderRoot(candidate.apiKey)
      ? "tenant_byok"
      : null;
  }
  return isAuthorizedLocalDeploymentBrowserFunding(value, provider)
    ? "local_deployment_authorized"
    : null;
}

/**
 * Resolve the root only inside a built-in provider's ephemeral-token mint.
 * The root is never attached to the authority marker or returned connection.
 */
export function browserProviderRootFromFundingAuthority(
  value: unknown,
  provider: VoiceProviderId,
  deploymentEnvironmentName: ProviderEnvironmentName,
): string {
  const kind = browserFundingAuthorityKind(value, provider);
  if (kind === "tenant_byok") {
    return (value as { apiKey: string }).apiKey;
  }
  if (kind !== "local_deployment_authorized") {
    throw new Error(`invalid ${provider} browser funding authority`);
  }
  const record = LOCAL_BROWSER_FUNDING_AUTHORITIES.get(value as object);
  if (
    !record
    || record.deploymentEnvironmentName !== deploymentEnvironmentName
  ) {
    throw new Error(`invalid ${provider} browser funding authority`);
  }
  return record.root;
}
