import type { RemoteMcpServer, VoiceSessionSpec } from "../types";
import { experimentalProviderDirectMcpEnabled } from "../client/types";

/**
 * Provider-direct MCP in a browser session is a separate, explicit trust domain.
 * The call-scoped same-origin gateway is always removed before provider minting;
 * only separately configured public HTTPS endpoints may cross that boundary.
 */
export function browserProviderSessionSpec(spec: VoiceSessionSpec): VoiceSessionSpec {
  const external = providerDirectMcpServers(spec);
  return external === undefined ? spec : { ...spec, mcpServers: external };
}

/** Returns undefined outside explicit direct mode; otherwise validates the entire disclosure set. */
export function providerDirectMcpServers(spec: VoiceSessionSpec): RemoteMcpServer[] | undefined {
  if (!experimentalProviderDirectMcpEnabled(spec.settings)) return undefined;
  if (!spec.toolProxyToken) throw new Error("local tool proxy token is required");
  const localGateway = parseHttpsUrl(spec.toolProxyUrl, "local tool proxy");
  const external: RemoteMcpServer[] = [];

  for (const server of spec.mcpServers) {
    const endpoint = parseHttpsUrl(server.serverUrl, `provider-direct MCP server ${server.label}`);
    if (endpoint.origin === localGateway.origin || isLocalHostname(endpoint.hostname)) {
      throw new Error(`provider-direct MCP server ${server.label} must not use a same-origin or local endpoint`);
    }
    if (!server.authorization || /[\u0000-\u001f\u007f]/.test(server.authorization)) {
      throw new Error(`provider-direct MCP server ${server.label} requires a canonical external authorization value`);
    }
    if (server.authorization.includes(spec.toolProxyToken)) {
      throw new Error(`provider-direct MCP server ${server.label} must not reuse the local tool proxy token`);
    }
    external.push(server);
  }

  return external;
}

function parseHttpsUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} URL must be valid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} URL must be credential-free HTTPS without a fragment`);
  }
  return parsed;
}

function isLocalHostname(raw: string): boolean {
  const hostname = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  if (hostname.includes(":")) {
    return hostname === "::"
      || hostname === "::1"
      || hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || /^fe[89ab]/.test(hostname)
      || hostname.startsWith("::ffff:");
  }
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}
