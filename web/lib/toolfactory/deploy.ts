// Author: Harsha Gundala
// deploy.ts — isolated Vercel deployments for operator-minted tools.

import { createHash } from "node:crypto";
import { log } from "../log";
import { validateToolEnvironmentNames } from "./template";
import {
  signToolInvocation,
  type SignedToolInvocation,
  type ToolInvocationContext,
  type ToolInvocationSigner,
} from "./invocation";

const API = "https://api.vercel.com";
const L = log("toolfactory/deploy");
const MAX_TOOL_RESPONSE_BYTES = 1_000_000;

function baseProject(): string {
  return (process.env.VERCEL_TOOLS_PROJECT ?? "hacc-tool").toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "hacc-tool";
}

/** Stable but tenant-opaque project name. No two org/tool pairs share runtime env. */
export function isolatedToolProject(orgId: string, slug: string, keyId: string): string {
  if (!orgId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^tik_[A-Za-z0-9_-]{16}$/.test(keyId)) {
    throw new Error("invalid tool deployment identity");
  }
  const digest = createHash("sha256").update(`${orgId}\0${slug}\0${keyId}`, "utf8").digest("hex").slice(0, 20);
  return `${baseProject()}-v2-${digest}`.slice(0, 100);
}

function headers() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is required for generated-tool deployment");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function team(): string {
  return process.env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
}

function apiError(operation: string, response: Response): Error {
  // Provider response bodies can echo submitted env values. Never include them in logs or DB.
  return new Error(`${operation} failed with HTTP ${response.status}`);
}

async function ensureProject(target: string): Promise<void> {
  const get = await fetch(`${API}/v9/projects/${encodeURIComponent(target)}?${team()}`, { headers: headers() });
  if (!get.ok && get.status !== 404) throw apiError("Vercel project lookup", get);
  if (get.status === 404) {
    const res = await fetch(`${API}/v11/projects?${team()}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: target, autoExposeSystemEnvs: false }),
    });
    if (!res.ok) throw apiError("Vercel project create", res);
    L.info("created isolated generated-tool project", { data: { project: target } });
  }
  // Assertions authenticate every request. Deployment protection must not intercept them.
  const patch = await fetch(`${API}/v9/projects/${encodeURIComponent(target)}?${team()}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ ssoProtection: null, autoExposeSystemEnvs: false }),
  });
  if (!patch.ok) throw apiError("Vercel project protection update", patch);
}

async function configureProjectEnvironment(
  target: string,
  environment: Readonly<Record<string, string>>
): Promise<void> {
  if (!Object.keys(environment).length) return;
  const response = await fetch(
    `${API}/v10/projects/${encodeURIComponent(target)}/env?upsert=true&${team()}`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(Object.entries(environment).map(([key, value]) => ({
        key,
        value,
        type: "encrypted",
        target: ["production"],
      }))),
    }
  );
  if (!response.ok) throw apiError("Vercel isolated environment configure", response);
}

export type DeployOutcome = { deploymentId: string; url: string; project: string };

export type DeployToolOptions = {
  project: string;
  /** Exact per-tool allowlist only. Never pass the app process environment. */
  runtimeEnvironment?: Readonly<Record<string, string>>;
};

export type ToolInvocationOutcome =
  | {
      outcome: "succeeded";
      acknowledged: true;
      invocationId: string;
      value: unknown;
    }
  | {
      outcome: "rejected";
      acknowledged: false;
      invocationId: string;
      error: string;
    };

export class ToolInvocationIndeterminateError extends Error {
  readonly outcome = "indeterminate" as const;
  readonly dispatched = true;
  readonly deliveryState = "unknown" as const;
  readonly invocationId: string;

  constructor(invocationId: string) {
    super("generated tool may have executed but did not return an authoritative completion");
    this.name = "ToolInvocationIndeterminateError";
    this.invocationId = invocationId;
  }
}

/** Idempotently removes one revision-isolated project, including its deployments and env. */
export async function cleanupToolProject(project: string): Promise<void> {
  if (!isRevisionIsolatedToolProject(project)) {
    throw new Error("invalid isolated tool project name");
  }
  const response = await fetch(
    `${API}/v9/projects/${encodeURIComponent(project)}?${team()}`,
    { method: "DELETE", headers: headers(), redirect: "error" }
  );
  if (response.ok || response.status === 404) return;
  throw apiError("Vercel isolated project cleanup", response);
}

/** Deploys one tool into its own project with deployment-scoped environment values. */
export async function deployTool(
  slug: string,
  wrappedSource: string,
  options: DeployToolOptions
): Promise<DeployOutcome> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    throw new Error("invalid generated tool slug");
  }
  if (options.project !== isolatedToolProjectFromTrustedName(options.project)) {
    throw new Error("invalid isolated tool project name");
  }
  const environment = options.runtimeEnvironment ?? {};
  const environmentNames = validateToolEnvironmentNames(Object.keys(environment));
  if (environmentNames.some((name) => typeof environment[name] !== "string") ||
      Buffer.byteLength(JSON.stringify(environment), "utf8") > 1024 * 1024) {
    throw new Error("generated tool environment is invalid or exceeds 1MB");
  }
  await ensureProject(options.project);
  // Each revision has a fresh project, so this documented project-env API cannot race with or
  // inherit another tool/revision. Vercel applies the encrypted values only to new deployments.
  await configureProjectEnvironment(options.project, environment);
  const res = await fetch(`${API}/v13/deployments?${team()}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: options.project,
      project: options.project,
      target: "production",
      files: [
        { file: `api/${slug}.js`, data: wrappedSource },
        { file: "package.json", data: JSON.stringify({ name: options.project, private: true }) },
      ],
      projectSettings: { framework: null },
    }),
  });
  if (!res.ok) throw apiError("Vercel deployment", res);
  const dep = await res.json() as { id?: string; url?: string; readyState?: string; status?: string };
  if (!dep.id || !dep.url) throw new Error("Vercel deployment returned an incomplete response");

  const deadline = Date.now() + 90_000;
  let state = dep.readyState ?? dep.status;
  while (state !== "READY" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const poll = await fetch(`${API}/v13/deployments/${encodeURIComponent(dep.id)}?${team()}`, { headers: headers() });
    if (!poll.ok) continue;
    state = ((await poll.json()) as { readyState?: string }).readyState;
    if (state === "ERROR" || state === "CANCELED") throw new Error(`Vercel deployment ended in ${state}`);
  }
  if (state !== "READY") throw new Error("Vercel deployment timed out");
  L.info("tool deployed", { data: { slug, project: options.project, deploymentId: dep.id } });
  return {
    deploymentId: dep.id,
    url: `https://${dep.url}/api/${slug}`,
    project: options.project,
  };
}

function isolatedToolProjectFromTrustedName(value: string): string {
  const prefix = `${baseProject()}-v2-`;
  return value.startsWith(prefix) &&
    new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{20}$`).test(value)
    ? value
    : "";
}

/** Stable validation for persisted v2 projects; it deliberately ignores today's base prefix. */
function isRevisionIsolatedToolProject(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?-v2-[a-f0-9]{20}$/.test(value);
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_TOOL_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("generated tool response exceeds the safe limit");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function validatedToolEndpoint(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.endsWith(".vercel.app") ||
    url.search ||
    url.hash
  ) {
    throw new Error("generated tool endpoint is not an approved Vercel deployment URL");
  }
  return url.toString();
}

export type PreparedToolInvocation = Readonly<{
  endpointUrl: string;
  signed: SignedToolInvocation;
  binding: Readonly<{
    toolId: string;
    slug: string;
    invocationId: string;
  }>;
}>;

const livePreparedInvocations = new WeakSet<object>();

/**
 * Completes every local failure-prone step before a durable dispatch marker: endpoint
 * validation, context validation, encrypted-key decryption, exact body construction, and
 * assertion signing. No network request is made until executePreparedToolInvocation.
 */
export function prepareToolInvocation(
  endpointUrl: string,
  input: unknown,
  signer: ToolInvocationSigner | undefined,
  context?: ToolInvocationContext
): PreparedToolInvocation {
  if (!signer) throw new Error("generated tool invocation credential is missing; redeploy this legacy tool");
  if (!context) throw new Error("generated tool invocation context is required");
  const prepared = Object.freeze({
    endpointUrl: validatedToolEndpoint(endpointUrl),
    signed: signToolInvocation(input, signer, context),
    binding: Object.freeze({
      toolId: context.toolId,
      slug: signer.slug,
      invocationId: context.invocationId,
    }),
  });
  livePreparedInvocations.add(prepared);
  return prepared;
}

/** Consumes one host-prepared invocation exactly once and crosses the network boundary. */
export async function executePreparedToolInvocation(
  prepared: PreparedToolInvocation
): Promise<ToolInvocationOutcome> {
  if (!livePreparedInvocations.delete(prepared)) {
    throw new Error("generated tool invocation was not prepared here or was already consumed");
  }
  const signed = prepared.signed;
  let res: Response;
  try {
    res = await fetch(prepared.endpointUrl, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new ToolInvocationIndeterminateError(signed.claims.jti);
  }
  if ([401, 405, 413, 415].includes(res.status)) {
    return {
      outcome: "rejected",
      acknowledged: false,
      invocationId: signed.claims.jti,
      error: "generated tool rejected the invocation before execution",
    };
  }
  let text: string;
  try {
    text = await readBoundedResponse(res);
  } catch {
    throw new ToolInvocationIndeterminateError(signed.claims.jti);
  }
  if (!res.ok) throw new ToolInvocationIndeterminateError(signed.claims.jti);
  let json: { ok?: boolean; output?: unknown; error?: unknown };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new ToolInvocationIndeterminateError(signed.claims.jti);
  }
  if (json.ok !== true) throw new ToolInvocationIndeterminateError(signed.claims.jti);
  return {
    outcome: "succeeded",
    acknowledged: true,
    invocationId: signed.claims.jti,
    value: json.output,
  };
}

/** Invokes a generated tool with a short-lived, exact-body-bound assertion. */
export async function invokeTool(
  endpointUrl: string,
  input: unknown,
  signer: ToolInvocationSigner | undefined,
  context?: ToolInvocationContext
): Promise<ToolInvocationOutcome> {
  return executePreparedToolInvocation(prepareToolInvocation(endpointUrl, input, signer, context));
}
