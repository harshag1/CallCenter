import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveToolInvocationId,
  generateToolInvocationKeyPair,
  signToolInvocation,
  verifyToolInvocation,
  TOOL_INVOCATION_TTL_MS,
} from "../toolfactory/invocation";
import { deriveFlowActionInvocationId } from "../flow-runtime";
import {
  RUN_SIGNATURE_DOC,
  selectToolEnvironment,
  validateToolEnvironmentNames,
  validateToolSource,
  wrapToolSource,
} from "../toolfactory/template";
import {
  cleanupToolProject,
  deployTool,
  executePreparedToolInvocation,
  isolatedToolProject,
  invokeTool,
  prepareToolInvocation,
  ToolInvocationIndeterminateError,
} from "../toolfactory/deploy";

const SOURCE = `async function run(input, env) {
  return { input, envKeys: Object.keys(env), value: env.CRM_API_KEY };
}`;

const ORIGINAL_ENV = { ...process.env };
const INVOCATION_CONTEXT = {
  orgId: "org-1",
  toolId: "tool-1",
  invocationId: "abcdefghijklmnopqrstuvwx",
  audience: "flow_action" as const,
  idempotencyKey: "call-1:reserve:customer-C-42",
  callId: "call-1",
  agentId: "agent-1",
  runtimeDigest: "a".repeat(64),
  receiptId: "receipt-1",
};

describe("generated-tool secret boundary", () => {
  beforeEach(() => {
    process.env.ENV_VAULT_MASTER_KEY = "11".repeat(32);
    process.env.VERCEL_TOKEN = "vercel-control-plane-root";
    process.env.MCP_GATEWAY_SECRET = "framework-mcp-root-must-never-deploy";
    process.env.TOOL_SHARED_SECRET = "legacy-wrapper-root-must-never-deploy";
    process.env.VERCEL_TOOLS_PROJECT = "hacc-tool";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it("binds a short-lived assertion to one key revision, tool, and exact body", () => {
    const keys = generateToolInvocationKeyPair();
    const now = 1_800_000_000_000;
    const signed = signToolInvocation({ customer: "C-42" }, {
      keyId: keys.keyId,
      privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
      slug: "lookup-customer",
    }, INVOCATION_CONTEXT, { now, jti: "abcdefghijklmnopqrstuvwx" });

    expect(verifyToolInvocation(signed, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      slug: "lookup-customer",
      context: INVOCATION_CONTEXT,
      now: now + 1,
    })).toMatchObject({
      tool: "lookup-customer",
      audience: "flow_action",
      exp: now + TOOL_INVOCATION_TTL_MS,
      jti: "abcdefghijklmnopqrstuvwx",
    });

    expect(() => verifyToolInvocation({ ...signed, body: '{"input":{"customer":"C-evil"}}' }, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      slug: "lookup-customer",
      context: INVOCATION_CONTEXT,
      now,
    })).toThrow(/invalid or expired/);
    expect(() => verifyToolInvocation(signed, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      slug: "delete-customer",
      context: INVOCATION_CONTEXT,
      now,
    })).toThrow(/invalid or expired/);
    expect(() => verifyToolInvocation(signed, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      slug: "lookup-customer",
      context: INVOCATION_CONTEXT,
      now: now + TOOL_INVOCATION_TTL_MS + 1,
    })).toThrow(/invalid or expired/);
    expect(() => verifyToolInvocation(signed, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      slug: "lookup-customer",
      context: { ...INVOCATION_CONTEXT, callId: "call-2" },
      now,
    })).toThrow(/invalid or expired/);

    const wire = JSON.stringify(signed);
    expect(wire).not.toContain("framework-mcp-root");
    expect(wire).not.toContain("legacy-wrapper-root");
    expect(wire).not.toContain("PRIVATE KEY");
  });

  it("domain-separates reconciliation assertions and requires the full receipt binding", async () => {
    const keys = generateToolInvocationKeyPair();
    const context = { ...INVOCATION_CONTEXT, audience: "reconciliation" as const };
    const signed = signToolInvocation({ invocation_id: "abcdefghijklmnopqrstuvwx" }, {
      keyId: keys.keyId,
      privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
      slug: "lookup-customer",
    }, context);
    expect(verifyToolInvocation(signed, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      slug: "lookup-customer",
      context,
    })).toMatchObject({
      audience: "reconciliation",
      scope_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() => verifyToolInvocation(signed, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      slug: "lookup-customer",
      context: { ...INVOCATION_CONTEXT, audience: "flow_action" },
    })).toThrow(/invalid or expired/);
    expect(() => signToolInvocation({}, {
      keyId: keys.keyId,
      privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
      slug: "lookup-customer",
    }, { ...context, receiptId: undefined })).toThrow(/call, agent, runtime, and receipt binding/);

    const wrapped = wrapToolSource("lookup-customer", SOURCE, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      envNames: [],
    });
    const generated = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(wrapped).toString("base64")}#reconciliation-${Date.now()}`
    ) as { default: (request: Request) => Promise<Response> };
    const response = await generated.default(new Request("https://tool.example.test", {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("generates a public-key wrapper that passes only the explicit env allowlist", () => {
    const keys = generateToolInvocationKeyPair();
    const wrapped = wrapToolSource("lookup-customer", SOURCE, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      envNames: ["CRM_API_KEY"],
    });

    expect(wrapped).toContain('const __HACC_ALLOWED_ENV__ = Object.freeze(["CRM_API_KEY"])');
    expect(wrapped).toContain("run(authorized.envelope.input, __HACC_TOOL_ENV__, metadata)");
    expect(wrapped).not.toContain("MCP_GATEWAY_SECRET");
    expect(wrapped).not.toContain("TOOL_SHARED_SECRET");
    expect(wrapped).not.toContain("run(input, process.env)");
    expect(wrapped).not.toContain("Authorization: `Bearer");
    expect(wrapped).not.toContain(keys.privateKeyPkcs8Encrypted);
  });

  it("executes a valid signed envelope with only its explicitly granted environment", async () => {
    process.env.CRM_API_KEY = "declared-value";
    const keys = generateToolInvocationKeyPair();
    const wrapped = wrapToolSource("lookup-customer", SOURCE, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
      envNames: ["CRM_API_KEY"],
    });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(wrapped).toString("base64")}#${Date.now()}`;
    const generated = await import(/* @vite-ignore */ moduleUrl) as { default: (request: Request) => Promise<Response> };
    const signed = signToolInvocation({ id: "C-42" }, {
      keyId: keys.keyId,
      privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
      slug: "lookup-customer",
    }, INVOCATION_CONTEXT);
    const response = await generated.default(new Request("https://tool.example.test", {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      output: { input: { id: "C-42" }, envKeys: ["CRM_API_KEY"], value: "declared-value" },
    });

    const tampered = await generated.default(new Request("https://tool.example.test", {
      method: "POST",
      headers: signed.headers,
      body: '{"input":{"id":"C-43"}}',
    }));
    expect(tampered.status).toBe(401);

    const replay = await generated.default(new Request("https://tool.example.test", {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    }));
    expect(replay.status).toBe(401);
  });

  it("keeps verifier intrinsics safe after generated code poisons the shared crypto object", async () => {
    const keys = generateToolInvocationKeyPair();
    const poisonSource = `async function run(input, env) {
      crypto.subtle.verify = async function () { return true; };
      return input;
    }`;
    const wrapped = wrapToolSource("lookup-customer", poisonSource, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
    });
    const generated = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(wrapped).toString("base64")}#poison-${Date.now()}`
    ) as { default: (request: Request) => Promise<Response> };
    const first = signToolInvocation({ id: "C-1" }, {
      keyId: keys.keyId,
      privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
      slug: "lookup-customer",
    }, INVOCATION_CONTEXT);
    expect((await generated.default(new Request("https://tool.example.test", {
      method: "POST", headers: first.headers, body: first.body,
    }))).status).toBe(200);

    const second = signToolInvocation({ id: "C-2" }, {
      keyId: keys.keyId,
      privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
      slug: "lookup-customer",
    }, { ...INVOCATION_CONTEXT, idempotencyKey: "call-1:reserve:customer-C-2" });
    const forgedHeaders = {
      ...second.headers,
      "X-HACC-Signature": Buffer.alloc(64).toString("base64url"),
    };
    expect((await generated.default(new Request("https://tool.example.test", {
      method: "POST", headers: forgedHeaders, body: second.body,
    }))).status).toBe(401);
  });

  it("returns an immutable prototype-free env without ambient framework roots", () => {
    const selected = selectToolEnvironment({
      CRM_API_KEY: "allowed",
      MCP_GATEWAY_SECRET: "root",
      TOOL_SHARED_SECRET: "root-2",
      VERCEL_TOKEN: "root-3",
    }, ["CRM_API_KEY"]);
    expect(selected).toEqual({ CRM_API_KEY: "allowed" });
    expect(Object.getPrototypeOf(selected)).toBeNull();
    expect(Object.isFrozen(selected)).toBe(true);
    expect("MCP_GATEWAY_SECRET" in selected).toBe(false);
    expect("TOOL_SHARED_SECRET" in selected).toBe(false);
    expect("VERCEL_TOKEN" in selected).toBe(false);
  });

  it("rejects ambient-runtime escapes, top-level code, reserved env names, and duplicates", () => {
    for (const source of [
      "async function run(input, env) { return process.env; }",
      "async function run(input, env) { return globalThis.process; }",
      "async function run(input, env) { return fetch.constructor('return this')(); }",
      "async function run(input, env) { return __HACC_RUNTIME_ENV__; }",
      "async function run(input, env) { return `${globalThis.process.env.MCP_GATEWAY_SECRET}`; }",
      "async function run(input, env) { return glob\\u0061lThis; }",
      "async function run(input, env) { /[//]/; return globalThis.process.env; }",
      `async function run(input, env) {
        return ({})["con" + "structor"]["con" + "structor"]("return this")();
      }`,
      `async function run(input, env) {
        const {"constructor": Fn} = fetch;
        return Fn("return globalThis.process?.env")();
      }`,
      `async function run(input, env) {
        const {["con" + "structor"]: Fn} = fetch;
        return Fn("return globalThis")();
      }`,
      "const stolen = 1; async function run(input, env) { return stolen; }",
      "async function run(input) { return input; }",
    ]) {
      expect(() => validateToolSource(source)).toThrow();
    }
    expect(() => validateToolEnvironmentNames(["MCP_GATEWAY_SECRET"])).toThrow(/reserved/);
    expect(() => validateToolEnvironmentNames(["CRM_API_KEY", "CRM_API_KEY"])).toThrow(/duplicates/);
    expect(RUN_SIGNATURE_DOC).toContain("immutable, prototype-free");
  });

  it("uses a distinct opaque V2 project for every tenant/tool pair", () => {
    const key = "tik_abcdefghijklmnop";
    const first = isolatedToolProject("org-visible-secret", "lookup-customer", key);
    expect(first).toBe(isolatedToolProject("org-visible-secret", "lookup-customer", key));
    expect(first).not.toBe(isolatedToolProject("other-org", "lookup-customer", key));
    expect(first).not.toBe(isolatedToolProject("org-visible-secret", "other-tool", key));
    expect(first).not.toBe(isolatedToolProject("org-visible-secret", "lookup-customer", "tik_ponmlkjihgfedcba"));
    expect(first).not.toContain("org-visible-secret");
    expect(first).toMatch(/^hacc-tool-v2-[a-f0-9]{20}$/);
  });

  it("reuses the canonical Flow action identity derivation byte-for-byte", () => {
    for (const identity of ["call-1:receipt-1", "builder-test:abc", "unicode:\u2603"]) {
      expect(deriveToolInvocationId(identity)).toBe(deriveFlowActionInvocationId(identity));
      expect(deriveToolInvocationId(identity)).toMatch(/^[A-Za-z0-9_-]{24}$/);
    }
  });

  it("rejects arbitrary project mutation, unsafe paths, and non-P-256 wrapper keys", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(deployTool("lookup-customer", "wrapped", {
      project: "production-app",
    })).rejects.toThrow(/isolated tool project/);
    await expect(deployTool("../escape", "wrapped", {
      project: isolatedToolProject("org-1", "lookup-customer", "tik_abcdefghijklmnop"),
    })).rejects.toThrow(/tool slug/);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(() => wrapToolSource("lookup-customer", SOURCE, {
      keyId: "tik_abcdefghijklmnop",
      publicKeySpki: "A".repeat(88),
    })).toThrow(/P-256/);
  });

  it("sends only caller-provided per-tool env in the deployment body", async () => {
    const responses = [
      new Response(null, { status: 404 }),
      Response.json({ id: "project" }),
      Response.json({ ok: true }),
      Response.json({ created: true }),
      Response.json({ id: "dpl_1", url: "dpl-1.vercel.app", readyState: "READY" }),
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift()!);
    const project = isolatedToolProject("org-1", "lookup-customer", "tik_abcdefghijklmnop");
    await deployTool("lookup-customer", "wrapped-public-source", {
      project,
      runtimeEnvironment: { CRM_API_KEY: "allowed-only" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      name: project,
      autoExposeSystemEnvs: false,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      autoExposeSystemEnvs: false,
      ssoProtection: null,
    });
    const isolatedEnv = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(isolatedEnv).toEqual([{
      key: "CRM_API_KEY",
      value: "allowed-only",
      type: "encrypted",
      target: ["production"],
    }]);
    expect(String(fetchMock.mock.calls[3][0])).toContain(`/projects/${project}/env`);
    const deployment = JSON.parse(String(fetchMock.mock.calls[4][1]?.body));
    expect(deployment).toMatchObject({
      name: project,
      project,
    });
    expect(deployment).not.toHaveProperty("env");
    const serialized = JSON.stringify(deployment);
    expect(serialized).not.toContain("framework-mcp-root");
    expect(serialized).not.toContain("legacy-wrapper-root");
    expect(serialized).not.toContain("vercel-control-plane-root");
  });

  it("rejects oversized auth headers before reading a public request body", async () => {
    const keys = generateToolInvocationKeyPair();
    const wrapped = wrapToolSource("lookup-customer", SOURCE, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
    });
    const generated = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(wrapped).toString("base64")}#headers-${Date.now()}`
    ) as { default: (request: Request) => Promise<Response> };
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([123, 125]));
      },
    }, { highWaterMark: 0 });
    const request = new Request("https://tool.example.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hacc-invocation": "a".repeat(8_193),
        "x-hacc-signature": "a",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pullsBeforeHandler = pulls;
    expect((await generated.default(request)).status).toBe(401);
    expect(pulls).toBe(pullsBeforeHandler);
  });

  it("cancels an unauthenticated streaming body as soon as it crosses one megabyte", async () => {
    const keys = generateToolInvocationKeyPair();
    const wrapped = wrapToolSource("lookup-customer", SOURCE, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
    });
    const generated = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(wrapped).toString("base64")}#body-${Date.now()}`
    ) as { default: (request: Request) => Promise<Response> };
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://tool.example.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hacc-invocation": "a",
        "x-hacc-signature": "a",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await generated.default(request)).status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized declared body without consuming its stream", async () => {
    const keys = generateToolInvocationKeyPair();
    const wrapped = wrapToolSource("lookup-customer", SOURCE, {
      keyId: keys.keyId,
      publicKeySpki: keys.publicKeySpki,
    });
    const generated = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(wrapped).toString("base64")}#length-${Date.now()}`
    ) as { default: (request: Request) => Promise<Response> };
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([123, 125]));
      },
    }, { highWaterMark: 0 });
    const request = new Request("https://tool.example.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1000001",
        "x-hacc-invocation": "a",
        "x-hacc-signature": "a",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pullsBeforeHandler = pulls;
    expect((await generated.default(request)).status).toBe(413);
    expect(pulls).toBe(pullsBeforeHandler);
  });

  it("deletes only an isolated revision project and treats provider 404 as idempotent success", async () => {
    const project = isolatedToolProject("org-1", "lookup-customer", "tik_abcdefghijklmnop");
    // Cleanup authority is the immutable persisted v2 identity, not today's configurable prefix.
    process.env.VERCEL_TOOLS_PROJECT = "renamed-tool-prefix";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("provider-secret-body", { status: 500 }));

    await expect(cleanupToolProject(project)).resolves.toBeUndefined();
    await expect(cleanupToolProject(project)).resolves.toBeUndefined();
    await expect(cleanupToolProject(project)).rejects.toThrow(
      "Vercel isolated project cleanup failed with HTTP 500"
    );
    await expect(cleanupToolProject("production-app")).rejects.toThrow(/isolated tool project/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain(`/projects/${project}`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE", redirect: "error" });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("provider-secret-body");
  });

  it("fails closed for legacy unsigned tools and never reuses MCP_GATEWAY_SECRET", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(invokeTool("https://tool.vercel.app/api/test", {}, undefined)).rejects.toThrow(/credential is missing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepares endpoint/decrypt/sign locally before one explicit network crossing", async () => {
    const keys = generateToolInvocationKeyPair();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
      ok: true,
      output: { customer_id: "C-1" },
    }));
    const prepared = prepareToolInvocation(
      "https://tool.vercel.app/api/test",
      { id: "C-1" },
      {
        keyId: keys.keyId,
        privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
        slug: "lookup-customer",
      },
      INVOCATION_CONTEXT
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepared.binding).toEqual({
      toolId: INVOCATION_CONTEXT.toolId,
      slug: "lookup-customer",
      invocationId: INVOCATION_CONTEXT.invocationId,
    });

    await expect(executePreparedToolInvocation(prepared)).resolves.toMatchObject({
      outcome: "succeeded",
      acknowledged: true,
      value: { customer_id: "C-1" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(executePreparedToolInvocation(prepared)).rejects.toThrow(/already consumed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves authoritative success even when business output has an error field", async () => {
    const keys = generateToolInvocationKeyPair();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
      ok: true,
      output: { error: "business-level decline", retryable: false },
    }));
    const outcome = await invokeTool(
      "https://tool.vercel.app/api/test",
      { id: "C-1" },
      {
        keyId: keys.keyId,
        privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
        slug: "lookup-customer",
      },
      INVOCATION_CONTEXT
    );
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      acknowledged: true,
      value: { error: "business-level decline", retryable: false },
    });
  });

  it("separates pre-execution rejection from every ambiguous post-dispatch failure", async () => {
    const keys = generateToolInvocationKeyPair();
    const signer = {
      keyId: keys.keyId,
      privateKeyPkcs8Encrypted: keys.privateKeyPkcs8Encrypted,
      slug: "lookup-customer",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await expect(invokeTool(
      "https://tool.vercel.app/api/test", {}, signer, INVOCATION_CONTEXT
    )).resolves.toMatchObject({ outcome: "rejected", acknowledged: false });

    vi.mocked(fetch).mockResolvedValueOnce(Response.json(
      { ok: false, error: "tool execution failed" },
      { status: 500 }
    ));
    await expect(invokeTool(
      "https://tool.vercel.app/api/test", {}, signer, INVOCATION_CONTEXT
    )).rejects.toBeInstanceOf(ToolInvocationIndeterminateError);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("connection reset after send"));
    await expect(invokeTool(
      "https://tool.vercel.app/api/test", {}, signer, INVOCATION_CONTEXT
    )).rejects.toMatchObject({
      outcome: "indeterminate",
      dispatched: true,
      deliveryState: "unknown",
    });
  });
});
