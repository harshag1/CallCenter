// Author: Harsha Gundala
// deploy.ts — autonomous Vercel deploys for operator-minted edge tools.

import { log } from "../log";

const API = "https://api.vercel.com";
const PROJECT = "callcenter-tools";
const L = log("toolfactory/deploy");

function headers() {
  return { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, "Content-Type": "application/json" };
}

function team(): string {
  return process.env.VERCEL_TEAM_ID ? `teamId=${process.env.VERCEL_TEAM_ID}` : "";
}

async function ensureProject(): Promise<void> {
  const get = await fetch(`${API}/v9/projects/${PROJECT}?${team()}`, { headers: headers() });
  if (!get.ok) {
    const res = await fetch(`${API}/v11/projects?${team()}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: PROJECT }),
    });
    if (!res.ok) throw new Error(`vercel project create ${res.status}: ${(await res.text()).slice(0, 300)}`);
    L.info("created tools project");
  }
  // Tools are called by xAI/our gateway, not browsers — auth is our bearer secret,
  // so Vercel's SSO deployment protection must be off or every call 401s.
  await fetch(`${API}/v9/projects/${PROJECT}?${team()}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ ssoProtection: null }),
  }).catch(() => {});
}

/** Upserts env vars on the tools project (encrypted at Vercel, production target). */
export async function pushToolEnv(vars: Record<string, string>): Promise<void> {
  await ensureProject();
  const body = Object.entries(vars).map(([key, value]) => ({
    key, value, type: "encrypted", target: ["production"],
  }));
  const res = await fetch(`${API}/v10/projects/${PROJECT}/env?upsert=true&${team()}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`vercel env ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export type DeployOutcome = { deploymentId: string; url: string };

/** Deploys one edge function as its own production deployment; returns its stable alias URL. */
export async function deployTool(slug: string, wrappedSource: string): Promise<DeployOutcome> {
  await ensureProject();
  const res = await fetch(`${API}/v13/deployments?${team()}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: PROJECT,
      project: PROJECT,
      target: "production",
      files: [
        { file: `api/${slug}.js`, data: wrappedSource },
        { file: "package.json", data: JSON.stringify({ name: PROJECT, private: true }) },
      ],
      projectSettings: { framework: null },
    }),
  });
  if (!res.ok) throw new Error(`vercel deploy ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const dep = await res.json();

  // Poll until the deployment is READY (edge functions build fast; cap at ~90s).
  const deadline = Date.now() + 90_000;
  let state = dep.readyState ?? dep.status;
  while (state !== "READY" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`${API}/v13/deployments/${dep.id}?${team()}`, { headers: headers() });
    if (!poll.ok) continue;
    state = (await poll.json()).readyState;
    if (state === "ERROR" || state === "CANCELED") throw new Error(`deployment ${state}`);
  }
  if (state !== "READY") throw new Error("deployment timed out");
  L.info("tool deployed", { slug, url: dep.url });
  return { deploymentId: dep.id, url: `https://${dep.url}/api/${slug}` };
}

/** Invokes a deployed tool the same way the MCP gateway does. */
export async function invokeTool(endpointUrl: string, input: unknown): Promise<unknown> {
  const res = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MCP_GATEWAY_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(25_000),
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return json.ok ? json.output : { error: json.error ?? `HTTP ${res.status}` };
}
