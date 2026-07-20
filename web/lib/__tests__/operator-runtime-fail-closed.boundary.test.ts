import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  getPool: vi.fn(),
  fetch: vi.fn(),
  originateCall: vi.fn(),
  purchaseNumber: vi.fn(),
  sendAgentEmail: vi.fn(),
  sendSms: vi.fn(),
  research: vi.fn(),
  integrationStatuses: vi.fn(() => []),
}));

vi.mock("../db", () => ({
  q: mocks.q,
  qOne: mocks.qOne,
  getPool: mocks.getPool,
}));
vi.mock("../telephony", () => ({
  originateCall: mocks.originateCall,
  purchaseNumber: mocks.purchaseNumber,
}));
vi.mock("../email", () => ({ sendAgentEmail: mocks.sendAgentEmail }));
vi.mock("../sms", () => ({ sendSms: mocks.sendSms }));
vi.mock("../xai", () => ({ research: mocks.research }));
vi.mock("../integrations", () => ({ integrationStatuses: mocks.integrationStatuses }));

import { manageTable, queryData } from "../agent/tools/data";
import { runJs } from "../agent/tools/files-tools";
import { webSearch } from "../agent/tools/research";
import { sendSmsTool } from "../agent/tools/comms";
import { placeCall, scheduleCall } from "../agent/tools/telephony";
import {
  byName as compatibilityByName,
  OPERATOR_TOOLS,
  operatorToolCatalog,
} from "../agent/tools";
import { FUNDED_OPERATOR_CAPABILITIES } from "../agent/tools/operator-capability-policy";

const ctx = Object.freeze({
  orgId: "00000000-0000-4000-8000-000000000001",
  email: "member@example.test",
  agentId: null,
  origin: "https://app.example.test",
});

async function productionTypeScriptFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === ".next") {
      return [];
    }
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return productionTypeScriptFiles(url);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [url] : [];
  }));
  return files.flat();
}

describe("operator runtime fail-closed boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPERATOR_JS_SANDBOX_URL", "");
    vi.stubEnv("OPERATOR_JS_SANDBOX_TOKEN", "");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockResolvedValue(null);
    mocks.fetch.mockRejectedValue(new Error("network access is forbidden in this suite"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps query_data SQL fixed and binds tenant and malicious values as parameters", async () => {
    const malicious = "x%' OR 1=1; DROP TABLE calls; --";
    mocks.q.mockResolvedValueOnce([{ id: "call-1" }]).mockResolvedValueOnce([]);

    const first = await queryData.execute({
      resource: "calls",
      id: malicious,
      status: malicious,
      query: malicious,
      limit: 999_999,
    } as never, ctx);
    const second = await queryData.execute({
      resource: "calls",
      id: "different-id",
      status: "completed",
      query: "different search",
      limit: 1,
    } as never, ctx);

    expect(first.output).toEqual({ resource: "calls", rowCount: 1, rows: [{ id: "call-1" }] });
    expect(second.output).toEqual({ resource: "calls", rowCount: 0, rows: [] });
    expect(mocks.q).toHaveBeenCalledTimes(2);

    const [firstSql, firstParams] = mocks.q.mock.calls[0] as [string, unknown[]];
    const [secondSql, secondParams] = mocks.q.mock.calls[1] as [string, unknown[]];
    expect(firstSql).toBe(secondSql);
    expect(firstSql).toContain("FROM calls c JOIN agents a ON a.id = c.agent_id");
    expect(firstSql).toContain("WHERE a.org_id = $1");
    expect(firstSql).toContain("LIMIT $5");
    expect(firstSql).not.toContain(malicious);
    expect(firstParams).toEqual([ctx.orgId, malicious, malicious, malicious, 200]);
    expect(secondParams).toEqual([ctx.orgId, "different-id", "completed", "different search", 1]);
  });

  it("rejects an unknown query_data resource before database access", async () => {
    const result = await queryData.execute({
      resource: "calls; DELETE FROM users",
      query: "anything",
    } as never, ctx);

    expect(result.output).toEqual({ error: "unknown query resource" });
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("rejects non-canonical E.164 destinations before any proposal or provider action", async () => {
    const cases = [
      [sendSmsTool, { to: "+01234567", message: "hello" }],
      [placeCall, { agent_id: "00000000-0000-4000-8000-000000000002", to_number: "+01234567", reason: "test" }],
      [scheduleCall, {
        agent_id: "00000000-0000-4000-8000-000000000002",
        to_number: "+01234567",
        run_at: "2026-07-16T21:00:00.000Z",
      }],
    ] as const;

    for (const [tool, args] of cases) {
      const result = await tool.execute(args as never, ctx);
      expect(result.output).toMatchObject({ error: expect.stringContaining("E.164") });
    }
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.originateCall).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("keeps manage_table disabled without consulting the database", async () => {
    const result = await manageTable.execute({
      sql: "DROP TABLE users;",
      operation: "create",
    } as never, ctx);

    expect(result.output).toEqual({
      error: "raw SQL storage is disabled; use the tenant-scoped dataset tools",
    });
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("omits run_js and fails its direct compatibility export closed without a sandbox", async () => {
    const catalog = await operatorToolCatalog(ctx);
    const direct = await runJs.execute({
      code: "return fetch('https://attacker.example/');",
    } as never, ctx);

    expect(catalog.byName.has("run_js")).toBe(false);
    expect(catalog.tools.some((tool) => tool.function.name === "run_js")).toBe(false);
    expect(direct.output).toEqual({ error: "external JavaScript sandbox is not configured" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("rejects a sandbox URL containing query credentials or a control-character token", async () => {
    vi.stubEnv("OPERATOR_JS_SANDBOX_URL", "https://sandbox.example.test/run?secret=leaked");
    vi.stubEnv("OPERATOR_JS_SANDBOX_TOKEN", "x".repeat(64));

    let catalog = await operatorToolCatalog(ctx);
    expect(catalog.byName.has("run_js")).toBe(false);
    expect((await runJs.execute({ code: "return 4" } as never, ctx)).output)
      .toEqual({ error: "external JavaScript sandbox is not configured" });

    vi.stubEnv("OPERATOR_JS_SANDBOX_URL", "https://sandbox.example.test/run");
    vi.stubEnv("OPERATOR_JS_SANDBOX_TOKEN", `${"x".repeat(40)}\nheader-injection`);
    catalog = await operatorToolCatalog(ctx);
    expect(catalog.byName.has("run_js")).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("runs configured JavaScript only through the bounded external isolation service", async () => {
    vi.stubEnv("OPERATOR_JS_SANDBOX_URL", "https://sandbox.example.test/v1/execute");
    vi.stubEnv("OPERATOR_JS_SANDBOX_TOKEN", "sandbox-token-".repeat(4));
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      result: { answer: 4 },
      logs: ["isolated"],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const catalog = await operatorToolCatalog(ctx);
    const result = await runJs.execute({ code: "return 2 + 2" } as never, ctx);

    expect(catalog.byName.has("run_js")).toBe(true);
    expect(result.output).toEqual({ result: { answer: 4 }, logs: ["isolated"] });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith("https://sandbox.example.test/v1/execute", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${"sandbox-token-".repeat(4)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        code: "return 2 + 2",
        input: null,
        timeout_ms: 5_000,
      }),
    }));
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("hides every optional egress tool in production unless its exact release gates are enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HACC_ENABLE_EXTERNAL_EGRESS", "");
    vi.stubEnv("HACC_ENABLE_OPERATOR_JS_EGRESS", "");
    vi.stubEnv("HACC_ENABLE_OPERATOR_WEB_SEARCH_EGRESS", "");
    vi.stubEnv("OPERATOR_JS_SANDBOX_URL", "https://sandbox.example.test/v1/execute");
    vi.stubEnv("OPERATOR_JS_SANDBOX_TOKEN", "sandbox-token-".repeat(4));

    const catalog = await operatorToolCatalog(ctx);
    expect(catalog.byName.has("create_tool")).toBe(false);
    expect(catalog.byName.has("run_js")).toBe(false);
    expect(catalog.byName.has("web_search")).toBe(false);
    expect((await runJs.execute({ code: "return 4" } as never, ctx)).output)
      .toEqual({ error: "external JavaScript sandbox egress is disabled" });
    expect((await webSearch.execute({ query: "provider docs" } as never, ctx)).output)
      .toEqual({ error: "operator web-search egress is disabled" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.research).not.toHaveBeenCalled();
  });

  it("does not expose model-callable deployment even when legacy factory flags are configured", async () => {
    vi.stubEnv("ENABLE_TOOL_FACTORY", "true");
    vi.stubEnv("VERCEL_TOKEN", "configured-but-not-model-authority");
    const catalog = await operatorToolCatalog(ctx);

    expect(catalog.byName.has("create_tool")).toBe(false);
    expect(catalog.tools.some((tool) => tool.function.name === "create_tool")).toBe(false);
    expect(OPERATOR_TOOLS.some((tool) => tool.name === "create_tool")).toBe(false);
  });

  it.each([
    ["basic membership", [{ operator_role: "basic", capability: "place_call" }]],
    ["missing capability rows", []],
  ])("hides every funded tool for %s while retaining query_data", async (_case, rows) => {
    mocks.q.mockResolvedValueOnce(rows);

    const catalog = await operatorToolCatalog(ctx);
    const names = new Set(catalog.tools.map((tool) => tool.function.name));

    expect(names.has("query_data")).toBe(true);
    expect(catalog.byName.has("query_data")).toBe(true);
    for (const capability of FUNDED_OPERATOR_CAPABILITIES) {
      expect(names.has(capability)).toBe(false);
      expect(catalog.byName.has(capability)).toBe(false);
    }
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("JOIN operator_action_policies"),
      [ctx.email, ctx.orgId],
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.originateCall).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.sendAgentEmail).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(mocks.research).not.toHaveBeenCalled();
  });

  it("keeps every context-free compatibility export at least authority", () => {
    const exported = new Set(OPERATOR_TOOLS.map((tool) => tool.name));
    expect(exported.has("run_js")).toBe(false);
    expect("set" in compatibilityByName).toBe(false);
    for (const capability of FUNDED_OPERATOR_CAPABILITIES) {
      expect(exported.has(capability)).toBe(false);
      expect(compatibilityByName.has(capability)).toBe(false);
    }
  });

  it("keeps every irreversible operator-funded provider call behind the approval dispatcher", async () => {
    const webRoot = new URL("../../", import.meta.url);
    const files = await productionTypeScriptFiles(webRoot);
    const callSites = new Map<string, Set<string>>();
    for (const name of [
      "sendAgentEmail",
      "sendSms",
      "originateCall",
      "purchaseNumber",
      "launchCampaign",
      "kickCampaign",
    ]) callSites.set(name, new Set());

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const relative = decodeURIComponent(file.href.slice(webRoot.href.length));
      for (const [name, sites] of callSites) {
        if (new RegExp(`\\b${name}\\s*\\(`).test(source)) sites.add(relative);
      }
    }

    expect([...callSites.get("sendAgentEmail")!].sort()).toEqual([
      "lib/agent/operator-action-dispatch.ts",
      "lib/email.ts",
    ]);
    expect([...callSites.get("sendSms")!].sort()).toEqual([
      "lib/agent/operator-action-dispatch.ts",
      "lib/sms.ts",
    ]);
    expect([...callSites.get("originateCall")!].sort()).toEqual([
      "lib/agent/operator-action-dispatch.ts",
      "lib/campaigns.ts",
      "lib/telephony.ts",
    ]);
    expect([...callSites.get("purchaseNumber")!].sort()).toEqual([
      "lib/agent/operator-action-dispatch.ts",
      "lib/telephony.ts",
    ]);
    expect([...callSites.get("launchCampaign")!].sort()).toEqual([
      "lib/agent/operator-action-dispatch.ts",
      "lib/campaigns.ts",
    ]);
    expect([...callSites.get("kickCampaign")!].sort()).toEqual([
      "lib/agent/operator-action-dispatch.ts",
      "lib/campaigns.ts",
    ]);
  });

  it("exposes only the exact funded capability returned by privileged policy discovery", async () => {
    mocks.q.mockResolvedValueOnce([
      { operator_role: "operator", capability: "send_email" },
      { operator_role: "operator", capability: "not_a_real_capability" },
    ]);

    const catalog = await operatorToolCatalog(ctx);
    expect(catalog.byName.has("send_email")).toBe(true);
    expect("set" in catalog.byName).toBe(false);
    for (const capability of FUNDED_OPERATOR_CAPABILITIES) {
      if (capability !== "send_email") expect(catalog.byName.has(capability)).toBe(false);
    }

    const email = catalog.byName.get("send_email");
    expect(email).toBeDefined();
    const invalid = await email!.execute({
      to: "person@example.test",
      subject: "Hello",
      message: "Body",
      confirmation_token: "x".repeat(40),
      idempotency_key: "send-email-0001",
      unregistered_override: true,
    } as never, ctx);
    expect(invalid.output).toEqual({ error: "tool arguments do not match the registered schema" });
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.sendAgentEmail).not.toHaveBeenCalled();
  });
});
