import { describe, expect, it } from "vitest";
import {
  publicAuditToolArguments,
  publicAuditToolCallPayload,
  publicAuditToolResult,
  publicAuditToolResultPayload,
  type PublicAuditOptions,
} from "../public-audit";

const fingerprintKey = "00112233445566778899aabbccddeefffedcba98765432100123456789abcdef";
const baseOptions = Object.freeze({
  fingerprintKey,
  fingerprintScope: Object.freeze({ organizationId: "org-1", callId: "call-1" }),
}) satisfies PublicAuditOptions;

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function fingerprint(value: { _audit: { fingerprint_hmac_sha256: string | null } }): string | null {
  return value._audit.fingerprint_hmac_sha256;
}

describe("public tool audit boundary", () => {
  it("never publishes nested run_action arguments or its capability lease", () => {
    const secrets = {
      lease: "eyJhbGciOiJIUzI1NiJ9.private-action-lease.signature",
      card: "4111111111111111",
      email: "caller-private@example.com",
      apiKey: "sk-super-private-provider-key",
      queryToken: "query-token-that-must-not-be-public",
    };
    const event = publicAuditToolCallPayload("run_action", {
      name: "reserve_field_technician",
      capability_grant: secrets.lease,
      arguments: {
        card_number: secrets.card,
        contact: { email: secrets.email },
        auth: [{ api_key: secrets.apiKey }],
        callback: `https://user:pass@example.com/hook?token=${secrets.queryToken}&safe=nope`,
        topic: "nested-topic-must-not-be-public",
        table: "nested_table_must_not_be_public",
      },
    }, {
      ...baseOptions,
      trustedToolNames: ["reserve_field_technician"],
      audience: "realtime",
    });

    expect(event).toMatchObject({
      name: "run_action",
      audience: "realtime",
      args: {
        name: "reserve_field_technician",
        _audit: {
          schema_version: 2,
          redaction: "trusted_top_level_allowlist_only",
          fingerprint_algorithm: "call-scoped-hmac-sha256-v2",
          fingerprint_complete: true,
          fingerprint_hmac_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(Object.keys(event.args).sort()).toEqual(["_audit", "name"]);
    const output = serialized(event);
    for (const secret of Object.values(secrets)) expect(output).not.toContain(secret);
    expect(output).not.toContain("nested-topic-must-not-be-public");
    expect(output).not.toContain("nested_table_must_not_be_public");
    expect(output).not.toContain("user:pass");
  });

  it("treats arbitrary business arguments as sensitive regardless of their key names", () => {
    const event = publicAuditToolCallPayload("send_email", {
      to: "patient@example.com",
      subject: "Your private diagnosis",
      message: "The caller disclosed a protected medical condition.",
      totally_innocent_name: "still-private",
      password: "hunter2",
    }, { ...baseOptions, audience: "background" });

    expect(event.name).toBe("send_email");
    expect(event.audience).toBe("background");
    expect(Object.keys(event.args)).toEqual(["_audit"]);
    expect(fingerprint(event.args)).toMatch(/^[a-f0-9]{64}$/);
    const output = serialized(event);
    for (const secret of [
      "patient@example.com",
      "diagnosis",
      "medical condition",
      "still-private",
      "hunter2",
    ]) expect(output).not.toContain(secret);
  });

  it("requires exact trusted-runtime values before publishing dynamic metadata", () => {
    const values = {
      topic: ["membership.renewal", "returns"],
      step: ["returns/verify-order"],
      table: ["memberships_2026"],
    };
    expect(publicAuditToolArguments("classify", {
      topic: "membership.renewal",
      query: "private",
    }, { ...baseOptions, trustedMetadataValues: values })).toMatchObject({ topic: "membership.renewal" });
    expect(publicAuditToolArguments("begin_step", {
      topic: "returns",
      step: "returns/verify-order",
      customer: "private",
    }, { ...baseOptions, trustedMetadataValues: values }))
      .toMatchObject({ topic: "returns", step: "returns/verify-order" });
    expect(publicAuditToolArguments("write_table", {
      table: "memberships_2026",
      row: { email: "private@example.com" },
    }, { ...baseOptions, trustedMetadataValues: values })).toMatchObject({ table: "memberships_2026" });
    expect(publicAuditToolArguments("launch_task", {
      when: "end_of_call",
      command: "private",
    }, baseOptions)).toMatchObject({ when: "end_of_call" });
  });

  it("does not confuse identifier shape with trust", () => {
    const attacks = [
      publicAuditToolArguments("classify", { topic: "4111111111111111" }, baseOptions),
      publicAuditToolArguments("write_table", { table: "sk_super_private_provider_key" }, baseOptions),
      publicAuditToolResult("tool", {
        status: "private_patient_record_123",
        code: "4111111111111111",
        receipt_id: "018f0e21-7b7c-7d8e-8f9a-0b1c2d3e4f5a",
      }, baseOptions),
    ];
    for (const attack of attacks) {
      expect(Object.keys(attack)).toEqual(["_audit"]);
      const output = serialized(attack);
      expect(output).not.toContain("4111111111111111");
      expect(output).not.toContain("sk_super_private_provider_key");
      expect(output).not.toContain("private_patient_record_123");
      expect(output).not.toContain("018f0e21");
    }

    const toolName = "bearerdeadbeefdeadbeefdeadbeef1234";
    const toolEvent = publicAuditToolCallPayload(toolName, {}, baseOptions);
    expect(toolEvent.name).toBe("[REDACTED_TOOL]");
    expect(serialized(toolEvent)).not.toContain(toolName);
  });

  it("produces canonical, domain-bound fingerprints within one call", () => {
    const left = publicAuditToolArguments("send_sms", {
      message: "same secret body",
      nested: { z: 3, a: [1, 2, { ok: true }] },
    }, baseOptions);
    const reordered = publicAuditToolArguments("send_sms", {
      nested: { a: [1, 2, { ok: true }], z: 3 },
      message: "same secret body",
    }, baseOptions);
    const changed = publicAuditToolArguments("send_sms", {
      nested: { a: [1, 2, { ok: true }], z: 3 },
      message: "different secret body",
    }, baseOptions);
    const otherTool = publicAuditToolArguments("send_email", {
      nested: { a: [1, 2, { ok: true }], z: 3 },
      message: "same secret body",
    }, baseOptions);

    expect(fingerprint(left)).toBe(fingerprint(reordered));
    expect(fingerprint(changed)).not.toBe(fingerprint(left));
    expect(fingerprint(otherTool)).not.toBe(fingerprint(left));
  });

  it("prevents fingerprint correlation across calls and organizations", () => {
    const value = { message: "low-entropy-secret" };
    const first = publicAuditToolArguments("send_sms", value, baseOptions);
    const otherCall = publicAuditToolArguments("send_sms", value, {
      ...baseOptions,
      fingerprintScope: { organizationId: "org-1", callId: "call-2" },
    });
    const otherOrganization = publicAuditToolArguments("send_sms", value, {
      ...baseOptions,
      fingerprintScope: { organizationId: "org-2", callId: "call-1" },
    });
    expect(fingerprint(first)).not.toBe(fingerprint(otherCall));
    expect(fingerprint(first)).not.toBe(fingerprint(otherOrganization));
  });

  it("canonicalizes map/set order and distinguishes typed-array representations", () => {
    const ordered = publicAuditToolArguments("custom_tool", {
      map: new Map([["a", 1], ["b", 2]]),
      set: new Set(["a", "b"]),
    }, baseOptions);
    const reversed = publicAuditToolArguments("custom_tool", {
      set: new Set(["b", "a"]),
      map: new Map([["b", 2], ["a", 1]]),
    }, baseOptions);
    expect(fingerprint(ordered)).toBe(fingerprint(reversed));

    const uint8 = publicAuditToolArguments("custom_tool", { bytes: new Uint8Array([1, 0]) }, baseOptions);
    const uint16 = publicAuditToolArguments("custom_tool", { bytes: new Uint16Array([1]) }, baseOptions);
    expect(fingerprint(uint8)).not.toBe(fingerprint(uint16));
  });

  it("handles cycles, arrays, URLs, binary data, errors, and supported non-JSON leaves", () => {
    const value: Record<string, unknown> = {
      undefined,
      notANumber: Number.NaN,
      infinity: Infinity,
      error: new Error("private error message"),
      date: new Date("2026-07-10T00:00:00.000Z"),
      regexp: /private-pattern/gi,
      binary: new Uint8Array([115, 101, 99, 114, 101, 116]),
      url: new URL("https://user:password@example.com/private?api_key=private-query-key"),
      map: new Map<unknown, unknown>([["private-map-key", { token: "private-map-token" }]]),
      set: new Set<unknown>(["private-set-value"]),
      array: ["private-array-value", { token: "private-array-token" }],
    };
    value.self = value;
    (value.array as unknown[]).push(value);

    const first = publicAuditToolArguments("custom_tool", value, baseOptions);
    const second = publicAuditToolArguments("custom_tool", value, baseOptions);
    expect(first._audit.fingerprint_complete).toBe(true);
    expect(fingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint(first)).toBe(fingerprint(second));
    const output = serialized(first);
    for (const text of [
      "private error message",
      "private-pattern",
      "user:password",
      "private-query-key",
      "private-map-key",
      "private-map-token",
      "private-set-value",
      "private-array-value",
      "private-array-token",
    ]) expect(output).not.toContain(text);
  });

  it("does not invoke opaque values and refuses false equality evidence for them", () => {
    let getterCalls = 0;
    const withGetter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter secret");
      },
    });
    const getterAudit = publicAuditToolArguments("custom_tool", withGetter, baseOptions);
    expect(getterCalls).toBe(0);
    expect(getterAudit._audit).toMatchObject({
      fingerprint_algorithm: null,
      fingerprint_complete: false,
      fingerprint_hmac_sha256: null,
    });

    const functionAudit = publicAuditToolArguments("custom_tool", {
      fn: () => "private closure value",
    }, baseOptions);
    const symbolAudit = publicAuditToolArguments("custom_tool", {
      value: Symbol("private symbol value"),
    }, baseOptions);
    const bigintAudit = publicAuditToolArguments("custom_tool", {
      value: BigInt("9007199254740993"),
    }, baseOptions);
    expect(functionAudit._audit.fingerprint_complete).toBe(false);
    expect(symbolAudit._audit.fingerprint_complete).toBe(false);
    expect(bigintAudit._audit.fingerprint_complete).toBe(false);
    expect(serialized(functionAudit)).not.toContain("private closure value");
    expect(serialized(symbolAudit)).not.toContain("private symbol value");

    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("proxy secret");
      },
    });
    const hostileAudit = publicAuditToolArguments("custom_tool", hostile, baseOptions);
    expect(hostileAudit._audit).toMatchObject({
      fingerprint_algorithm: null,
      fingerprint_complete: false,
      fingerprint_hmac_sha256: null,
    });
    expect(serialized(hostileAudit)).not.toContain("proxy secret");
  });

  it("fails closed for prototype-key tool names and hostile trust catalogs", () => {
    const prototypeName = "__proto__";
    const prototypeAudit = publicAuditToolCallPayload(prototypeName, {
      credential: "prototype-secret",
    }, baseOptions);
    expect(prototypeAudit.name).toBe("[REDACTED_TOOL]");
    expect(Object.keys(prototypeAudit.args)).toEqual(["_audit"]);
    expect(serialized(prototypeAudit)).not.toContain(prototypeName);
    expect(serialized(prototypeAudit)).not.toContain("prototype-secret");

    let getterCalls = 0;
    const hostileCatalog = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret_tool_name";
      },
    });
    hostileCatalog.length = 1;
    const event = publicAuditToolCallPayload("secret_tool_name", { secret: "never-public" }, {
      ...baseOptions,
      trustedToolNames: hostileCatalog,
    });
    expect(getterCalls).toBe(0);
    expect(event.name).toBe("[REDACTED_TOOL]");
    expect(serialized(event)).not.toContain("secret_tool_name");
    expect(serialized(event)).not.toContain("never-public");
  });

  it("does not execute accessors on audit options", () => {
    let optionGetterCalls = 0;
    const options = Object.defineProperty({}, "trustedToolNames", {
      enumerable: true,
      get() {
        optionGetterCalls += 1;
        throw new Error("option getter secret");
      },
    }) as PublicAuditOptions;
    const event = publicAuditToolCallPayload("custom_secret_tool", { token: "private" }, options);
    expect(optionGetterCalls).toBe(0);
    expect(event.name).toBe("[REDACTED_TOOL]");
    expect(event.args._audit.fingerprint_complete).toBe(false);
    expect(serialized(event)).not.toContain("custom_secret_tool");
    expect(serialized(event)).not.toContain("private");
  });

  it("never presents depth- or size-limited input as equality evidence", () => {
    function deeplyNested(secret: string): Record<string, unknown> {
      const root: Record<string, unknown> = {};
      let cursor = root;
      for (let depth = 0; depth < 70; depth += 1) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      cursor.secret = secret;
      return root;
    }
    const deepA = publicAuditToolArguments("custom_tool", deeplyNested("secret-a"), baseOptions);
    const deepB = publicAuditToolArguments("custom_tool", deeplyNested("secret-b"), baseOptions);
    const hugeArray = publicAuditToolArguments("custom_tool", new Array(200_000).fill(7), baseOptions);
    const hugeString = publicAuditToolArguments("custom_tool", { value: "x".repeat(300_000) }, baseOptions);
    const hugeMapKey = publicAuditToolArguments("custom_tool", {
      value: new Map([["private-map-key".repeat(100_000), 1]]),
    }, baseOptions);

    for (const projection of [deepA, deepB, hugeArray, hugeString, hugeMapKey]) {
      expect(projection._audit).toMatchObject({
        fingerprint_algorithm: null,
        fingerprint_complete: false,
        fingerprint_hmac_sha256: null,
      });
    }
    expect(serialized(deepA)).not.toContain("secret-a");
    expect(serialized(deepB)).not.toContain("secret-b");
  });

  it("uses fixed-size fingerprints instead of publishing in-budget secret lengths", () => {
    const short = publicAuditToolArguments("send_sms", { message: "x" }, baseOptions);
    const long = publicAuditToolArguments("send_sms", { message: "x".repeat(50_000) }, baseOptions);
    expect(short._audit.fingerprint_complete).toBe(true);
    expect(long._audit.fingerprint_complete).toBe(true);
    expect(fingerprint(short)).not.toBe(fingerprint(long));
    expect(serialized(short).length).toBe(serialized(long).length);
    expect(serialized(long)).not.toContain("50000");
  });

  it("fails closed for missing scope and invalid or placeholder keys", () => {
    const secret = "must-never-appear";
    const projections = [
      publicAuditToolArguments("send_sms", { message: secret }),
      publicAuditToolArguments("send_sms", { message: secret }, {
        fingerprintKey,
      }),
      publicAuditToolArguments("send_sms", { message: secret }, {
        fingerprintKey: "short",
        fingerprintScope: baseOptions.fingerprintScope,
      }),
      publicAuditToolArguments("send_sms", { message: secret }, {
        fingerprintKey: "00".repeat(32),
        fingerprintScope: baseOptions.fingerprintScope,
      }),
    ];
    for (const projection of projections) {
      expect(projection).toEqual({
        _audit: {
          schema_version: 2,
          redaction: "trusted_top_level_allowlist_only",
          fingerprint_algorithm: null,
          fingerprint_complete: false,
          fingerprint_hmac_sha256: null,
        },
      });
      expect(serialized(projection)).not.toContain(secret);
    }
  });

  it("redacts result bodies while retaining only fixed or ledger-authorized metadata", () => {
    const receiptId = "018f0e21-7b7c-7d8e-8f9a-0b1c2d3e4f5a";
    const result = {
      status: "succeeded",
      code: "action_ok",
      receipt_id: receiptId,
      replayed: false,
      pending: false,
      email: "caller@example.com",
      error: "provider returned private account data",
      payload: { authorization: "Bearer private-result-token" },
    };
    const options = {
      ...baseOptions,
      trustedToolNames: ["renew_membership"],
      trustedMetadataValues: { code: ["action_ok"], receipt_id: [receiptId] },
    } satisfies PublicAuditOptions;
    const projection = publicAuditToolResult("renew_membership", result, options);
    expect(projection).toMatchObject({
      status: "succeeded",
      code: "action_ok",
      receipt_id: receiptId,
      replayed: false,
      pending: false,
    });
    expect(Object.keys(projection).sort()).toEqual([
      "_audit",
      "code",
      "pending",
      "receipt_id",
      "replayed",
      "status",
    ]);
    const output = serialized(projection);
    expect(output).not.toContain("caller@example.com");
    expect(output).not.toContain("private account data");
    expect(output).not.toContain("private-result-token");

    expect(publicAuditToolResultPayload("renew_membership", result, {
      ...options,
      audience: "realtime",
    })).toEqual({ name: "renew_membership", result: projection, audience: "realtime" });
  });

  it("never echoes an invalid audience and returns immutable event projections", () => {
    const event = publicAuditToolCallPayload("send_sms", { value: "private" }, {
      ...baseOptions,
      audience: "invalid" as "realtime",
    });
    expect(event).not.toHaveProperty("audience");
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.args)).toBe(true);
    expect(Object.isFrozen(event.args._audit)).toBe(true);
  });
});
