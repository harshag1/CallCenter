import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  decryptCredentialSecret: vi.fn(),
  deployTool: vi.fn(),
  invokeTool: vi.fn(),
  isolatedToolProject: vi.fn(),
  generateToolInvocationKeyPair: vi.fn(),
  deriveToolInvocationId: vi.fn(() => "abcdefghijklmnopqrstuvwx"),
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../vault", () => ({ decryptCredentialSecret: mocks.decryptCredentialSecret }));
vi.mock("../toolfactory/deploy", () => ({
  deployTool: mocks.deployTool,
  invokeTool: mocks.invokeTool,
  isolatedToolProject: mocks.isolatedToolProject,
  ToolInvocationIndeterminateError: class ToolInvocationIndeterminateError extends Error {},
}));
vi.mock("../toolfactory/invocation", () => ({
  generateToolInvocationKeyPair: mocks.generateToolInvocationKeyPair,
  deriveToolInvocationId: mocks.deriveToolInvocationId,
}));

import { createTool, listTools, testTool } from "../agent/tools/factory";

const ctx = {
  orgId: "org-1",
  email: "owner@example.test",
  agentId: null,
  origin: "https://app.example.test",
};
const publicKeySpki = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey
  .export({ type: "spki", format: "der" }).toString("base64");

describe("operator generated-tool boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_TOOL_FACTORY = "true";
    delete process.env.GENERATED_TOOL_SECRET_POLICY;
    delete process.env.GENERATED_TOOL_SECRET_APPROVALS;
    process.env.MCP_GATEWAY_SECRET = "framework-root-never-forward";
    process.env.TOOL_SHARED_SECRET = "legacy-root-never-forward";
    mocks.decryptCredentialSecret.mockReturnValue("org-scoped-crm-secret");
    mocks.isolatedToolProject.mockReturnValue("hacc-tool-v2-aaaaaaaaaaaaaaaaaaaa");
    mocks.generateToolInvocationKeyPair.mockReturnValue({
      keyId: "tik_abcdefghijklmnop",
      publicKeySpki,
      privateKeyPkcs8Encrypted: "encrypted-private-key",
    });
    mocks.deployTool.mockResolvedValue({
      deploymentId: "dpl_1",
      url: "https://dpl-1.vercel.app/api/lookup-customer",
      project: "hacc-tool-v2-aaaaaaaaaaaaaaaaaaaa",
    });
    mocks.q.mockImplementation(async (sql: string) =>
      sql.includes("SELECT name, value_encrypted")
        ? [{
            name: "CRM_API_KEY",
            value_encrypted: "encrypted-org-secret",
            value_encryption_slot_id: "00000000-0000-4000-8000-000000000001",
          }]
        : []
    );
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO tools")) return { id: "tool-1", invocation_key_id: null };
      if (sql.includes("WITH locked_tool AS")) return { id: "tool-1" };
      return null;
    });
  });

  it("deploys only declared org secrets and never a framework or wrapper root", async () => {
    const request = {
      slug: "lookup-customer",
      description: "Lookup a customer.",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return { id: input.id, configured: Boolean(env.CRM_API_KEY) }; }",
      env_var_names: ["CRM_API_KEY"],
    };
    const gated = await createTool.execute(request as never, ctx);
    expect(gated.output).toMatchObject({
      error: expect.stringMatching(/exact human-reviewed source approval/),
      approval_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    process.env.GENERATED_TOOL_SECRET_APPROVALS = String(
      (gated.output as { approval_sha256: string }).approval_sha256
    );

    const result = await createTool.execute(request as never, ctx);

    expect(result.output).toMatchObject({ ok: true, slug: "lookup-customer" });
    expect(mocks.deployTool).toHaveBeenCalledOnce();
    const [slug, wrappedSource, deployOptions] = mocks.deployTool.mock.calls[0];
    expect(slug).toBe("lookup-customer");
    expect(deployOptions).toEqual({
      project: "hacc-tool-v2-aaaaaaaaaaaaaaaaaaaa",
      runtimeEnvironment: { CRM_API_KEY: "org-scoped-crm-secret" },
    });
    expect(mocks.decryptCredentialSecret).toHaveBeenCalledWith(
      "encrypted-org-secret",
      {
        orgId: "org-1",
        sinkKind: "env_var",
        sinkId: "CRM_API_KEY",
        slotId: "00000000-0000-4000-8000-000000000001",
      }
    );
    expect(wrappedSource).not.toContain("MCP_GATEWAY_SECRET");
    expect(wrappedSource).not.toContain("TOOL_SHARED_SECRET");
    expect(wrappedSource).not.toContain("framework-root-never-forward");
    expect(wrappedSource).not.toContain("legacy-root-never-forward");

    const persisted = JSON.stringify([...mocks.q.mock.calls, ...mocks.qOne.mock.calls]);
    expect(persisted).not.toContain("framework-root-never-forward");
    expect(persisted).not.toContain("legacy-root-never-forward");
    expect(persisted).not.toContain("org-scoped-crm-secret");
    expect(persisted).not.toContain("invocation_private_key_encrypted =");
    expect(persisted).not.toContain("invocation_public_key =");
  });

  it("fails closed before deploy when a vault env lacks context-bound slot authority", async () => {
    const request = {
      slug: "lookup-customer",
      description: "Lookup a customer.",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return Boolean(env.CRM_API_KEY); }",
      env_var_names: ["CRM_API_KEY"],
    };
    const gated = await createTool.execute(request as never, ctx);
    process.env.GENERATED_TOOL_SECRET_APPROVALS = String(
      (gated.output as { approval_sha256: string }).approval_sha256
    );
    mocks.q.mockImplementation(async (sql: string) =>
      sql.includes("SELECT name, value_encrypted")
        ? [{
            name: "CRM_API_KEY",
            value_encrypted: "legacy-unbound-secret",
            value_encryption_slot_id: null,
          }]
        : []
    );

    const result = await createTool.execute(request as never, ctx);

    expect(result.output).toEqual({
      error: "vault env vars require secure re-entry: CRM_API_KEY",
      code: "credential_reentry_required",
    });
    expect(mocks.decryptCredentialSecret).not.toHaveBeenCalled();
    expect(mocks.deployTool).not.toHaveBeenCalled();
    expect(mocks.q.mock.calls.some(([sql]) =>
      String(sql).includes("tool_invocation_revisions SET status = 'failed'")))
      .toBe(true);
  });

  it("refuses a secretless webhook-capable test before database or network access", async () => {
    const result = await testTool.execute({
      slug: "public-webhook",
      input: { url: "https://public.example.test/mutate" },
    } as never, ctx);
    expect(result.output).toEqual({
      error: "direct generated-tool tests are disabled; grant the tool in a Flow v2 step with an explicit non-none idempotency policy",
      code: "generated_tool_test_requires_receipt_backed_flow",
    });
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects ambient source access before writing any database row", async () => {
    const result = await createTool.execute({
      slug: "steal-env",
      description: "unsafe",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return globalThis.process.env; }",
    } as never, ctx);
    expect(result.output).toMatchObject({ error: expect.stringMatching(/ambient runtime/) });
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.deployTool).not.toHaveBeenCalled();
  });

  it("keeps generated code secretless unless the exact source manifest is approved", async () => {
    const result = await createTool.execute({
      slug: "secret-tool",
      description: "needs a secret",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return Boolean(env.CRM_API_KEY); }",
      env_var_names: ["CRM_API_KEY"],
    } as never, ctx);
    expect(result.output).toMatchObject({
      error: expect.stringMatching(/exact human-reviewed source approval/),
      approval_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.deployTool).not.toHaveBeenCalled();
  });

  it("stages an update without replacing the live pointer when deployment fails", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, invocation_key_id FROM tools")) {
        return { id: "tool-1", invocation_key_id: "tik_oldoldoldoldold1" };
      }
      return null;
    });
    mocks.deployTool.mockRejectedValueOnce(new Error("safe provider failure"));

    const result = await createTool.execute({
      slug: "lookup-customer",
      description: "Replacement description.",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return input; }",
    } as never, ctx);

    expect(result.output).toMatchObject({
      error: "generated tool deployment failed",
      code: "generated_tool_deploy_failed",
    });
    expect(mocks.qOne.mock.calls.some(([sql]) => String(sql).includes("WITH locked_tool AS"))).toBe(false);
    const writes = mocks.q.mock.calls.map(([sql]) => String(sql));
    expect(writes.some((sql) => /UPDATE tools/i.test(sql))).toBe(false);
    expect(writes.some((sql) => sql.includes("tool_invocation_revisions SET status = 'failed'"))).toBe(true);
    const persisted = JSON.stringify([...mocks.q.mock.calls, ...mocks.qOne.mock.calls, result]);
    expect(persisted).not.toContain("safe provider failure");
  });

  it("rejects lossy slugs, invalid schemas, and computed ambient escapes before persistence", async () => {
    const base = {
      description: "Safe description.",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return input; }",
    };
    expect((await createTool.execute({ ...base, slug: "Existing/Tool" } as never, ctx)).output)
      .toMatchObject({ error: expect.stringMatching(/kebab-case/) });
    expect((await createTool.execute({ ...base, slug: "bad-schema", input_schema: {} } as never, ctx)).output)
      .toMatchObject({ error: expect.stringMatching(/type "object"/) });
    expect((await createTool.execute({
      ...base,
      slug: "external-ref",
      input_schema: { type: "object", properties: { id: { $ref: "https://example.test/x" } } },
    } as never, ctx)).output).toMatchObject({ error: expect.stringMatching(/non-portable/) });
    expect((await createTool.execute({
      ...base,
      slug: "computed-escape",
      source: `async function run(input, env) {
        return ({})["con" + "structor"]["con" + "structor"]("return this")();
      }`,
    } as never, ctx)).output).toMatchObject({ error: expect.stringMatching(/computed properties/) });
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.deployTool).not.toHaveBeenCalled();
  });

  it("publishes the pointer, revision, and READY record through one activation-gated statement", async () => {
    const result = await createTool.execute({
      slug: "lookup-customer",
      description: "Lookup a customer.",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return input; }",
    } as never, ctx);
    expect(result.output).toMatchObject({ ok: true });

    const publication = mocks.qOne.mock.calls.find(([sql]) => String(sql).includes("WITH locked_tool AS"));
    expect(publication).toBeDefined();
    const sql = String(publication![0]).replace(/\s+/g, " ");
    expect(sql).toMatch(/locked_tool AS MATERIALIZED .* FOR UPDATE/);
    expect(sql).toMatch(/activated AS \( UPDATE tool_invocation_revisions .* status = 'deploying' .* EXISTS \(SELECT 1 FROM locked_tool\)/);
    expect(sql).toMatch(/protected_cleanup AS \( UPDATE hacc_private\.generated_tool_cleanup_jobs .* status = 'protected'/);
    expect(sql).toMatch(/deployment_recorded AS \( INSERT INTO tool_deployments .* SELECT \$1, \$11, 'READY' FROM activated JOIN protected_cleanup/);
    expect(sql).toMatch(/published AS \( UPDATE tools .* EXISTS \(SELECT 1 FROM deployment_recorded\)/);
    expect(sql).toMatch(/retired_cleanup AS \( UPDATE hacc_private\.generated_tool_cleanup_jobs .* reason_code = 'retired'.* interval '24 hours'/);
    expect(publication![1]).toEqual(expect.arrayContaining(["dpl_1"]));
    expect(mocks.q.mock.calls.some(([query]) => (
      String(query).includes("tool_deployments") && String(query).includes("'READY'")
    ))).toBe(false);
  });

  it("cannot move the mutable pointer when this revision loses the activation race", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, invocation_key_id FROM tools")) {
        return { id: "tool-1", invocation_key_id: "tik_oldoldoldoldold1" };
      }
      if (sql.includes("WITH locked_tool AS")) return null;
      return null;
    });

    const result = await createTool.execute({
      slug: "lookup-customer",
      description: "Concurrent replacement.",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return input; }",
    } as never, ctx);

    expect(result.output).toEqual({
      error: "generated tool deployment was superseded by a newer revision",
      code: "generated_tool_deploy_superseded",
    });
    const retirement = mocks.q.mock.calls.find(([sql]) => String(sql).includes("SET status = 'retired'"));
    expect(retirement).toBeDefined();
    expect(String(retirement![0])).toContain("status = 'deploying'");
    expect(retirement![1]).toEqual(["tik_abcdefghijklmnop", "tool-1"]);
    const cleanup = mocks.q.mock.calls.find(([sql]) => String(sql).includes("reason_code = 'superseded'"));
    expect(cleanup?.[1]).toEqual(["tik_abcdefghijklmnop", "org-1"]);
    expect(String(cleanup?.[0])).toContain("LEAST(next_attempt_at, now())");
    expect(mocks.q.mock.calls.some(([sql]) => /UPDATE tools/i.test(String(sql)))).toBe(false);
  });

  it("fails closed when the atomic READY publication statement errors", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO tools")) return { id: "tool-1", invocation_key_id: null };
      if (sql.includes("WITH locked_tool AS")) throw new Error("READY ledger unavailable");
      return null;
    });
    // Even failure telemetry is best effort and must not replace the stable result.
    mocks.q.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO tool_deployments") && sql.includes("'ERROR'")) {
        throw new Error("telemetry unavailable");
      }
      return [];
    });

    const result = await createTool.execute({
      slug: "lookup-customer",
      description: "Lookup a customer.",
      input_schema: { type: "object" },
      source: "async function run(input, env) { return input; }",
    } as never, ctx);

    expect(result.output).toEqual({
      error: "generated tool deployment failed",
      code: "generated_tool_deploy_failed",
    });
    expect(mocks.q.mock.calls.some(([sql]) => (
      String(sql).includes("SET status = 'failed'") && String(sql).includes("status = 'deploying'")
    ))).toBe(true);
    expect(mocks.q.mock.calls.some(([sql]) => (
      String(sql).includes("reason_code = 'deploy_failed'") && String(sql).includes("cleanup_required")
    ))).toBe(true);
    expect(mocks.q.mock.calls.some(([sql]) => (
      String(sql).includes("tool_deployments") && String(sql).includes("'READY'")
    ))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ledger unavailable");
  });

  it("does not look up or expose secret-bearing generated-tool state to the builder model", async () => {
    const result = await testTool.execute({ slug: "lookup-customer", input: {} } as never, ctx);
    expect(result.output).toMatchObject({ code: "generated_tool_test_requires_receipt_backed_flow" });
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.invokeTool).not.toHaveBeenCalled();
  });

  it("keeps repeated builder attempts outside the generated invocation boundary", async () => {
    await testTool.execute({ slug: "lookup-customer", input: { id: "C-1" } } as never, ctx);
    await testTool.execute({ slug: "lookup-customer", input: { id: "C-1" } } as never, ctx);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.invokeTool).not.toHaveBeenCalled();
  });

  it("surfaces current revision cleanup state through an org-bound operator query", async () => {
    const rows = [{
      id: "tool-1",
      slug: "cleanup-needed",
      cleanup_status: "cleanup_required",
      cleanup_attempts: 8,
      cleanup_error_code: "provider_cleanup_failed",
    }];
    mocks.q.mockResolvedValueOnce(rows);

    await expect(listTools.execute({} as never, ctx)).resolves.toEqual({ output: rows });
    const [sql, parameters] = mocks.q.mock.calls[0];
    const compactSql = String(sql).replace(/\s+/g, " ");
    expect(compactSql).toContain("LEFT JOIN hacc_private.generated_tool_cleanup_jobs AS cleanup");
    expect(compactSql).toContain("cleanup.org_id = tools.org_id");
    expect(compactSql).toContain("WHERE tools.org_id = $1");
    expect(compactSql).toContain("cleanup.status AS cleanup_status");
    expect(compactSql).toContain("cleanup.attempts AS cleanup_attempts");
    expect(parameters).toEqual(["org-1"]);
  });
});
