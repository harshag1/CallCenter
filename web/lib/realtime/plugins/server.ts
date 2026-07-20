import "server-only";

import { RealtimeProviderPluginError } from "./registry";

/**
 * Server-only entrypoint for wrappers around the built-in adapters.
 * Keep this separate from `./index` so community browser plugins can import the
 * contract and registry without pulling credential-bearing adapter modules into
 * a client bundle.
 */
export * from "./builtins";

export async function readRealtimeProviderEnvironmentCredential(
  environmentName: string,
): Promise<string> {
  const value = process.env[environmentName]?.trim();
  if (!value) {
    throw new RealtimeProviderPluginError(
      "missing_credential",
      `${environmentName} is required by the realtime provider`,
    );
  }
  return value;
}
