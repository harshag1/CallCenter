import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../db", () => ({
  ensureSafeDatabaseRuntimeRole: vi.fn(),
  getPool: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
}));

import { AuthRequestInputError, readAuthJsonObject } from "../auth";

function request(rawBody: string, headers: Record<string, string> = {}): Request {
  return new Request("https://voice.example.test/api/auth/send-code", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
}

async function statusOf(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof AuthRequestInputError ? error.status : -1;
  }
}

describe("authentication request parser", () => {
  it("accepts an exact bounded JSON object", async () => {
    await expect(readAuthJsonObject(request('{"email":"owner@example.test"}')))
      .resolves.toEqual({ email: "owner@example.test" });
  });

  it.each([
    ["literal duplicate", '{"email":"first@example.test","email":"second@example.test"}'],
    ["escape-equivalent duplicate", '{"email":"first@example.test","em\\u0061il":"second@example.test"}'],
    ["nested duplicate", '{"email":"owner@example.test","metadata":{"code":"1","code":"2"}}'],
  ])("rejects %s keys before login delivery", async (_label, body) => {
    expect(await statusOf(readAuthJsonObject(request(body)))).toBe(400);
  });

  it("preserves strict media type and byte caps", async () => {
    expect(await statusOf(readAuthJsonObject(request("{}", { "content-type": "text/plain" }))))
      .toBe(415);
    expect(await statusOf(readAuthJsonObject(request("{}", { "content-length": "9000" }))))
      .toBe(413);
  });

  it.each([
    ["comma-folded conflicting fields", "application/json; charset=utf-8, text/plain"],
    ["comma-folded duplicate fields", "application/json, application/json"],
    ["unknown parameters", "application/json; profile=authority"],
    ["duplicate charset parameters", "application/json; charset=utf-8; charset=utf-8"],
  ])("rejects %s in Content-Type", async (_label, contentType) => {
    expect(await statusOf(readAuthJsonObject(request("{}", {
      "content-type": contentType,
    })))).toBe(415);
  });

  it.each([
    "application/json",
    "Application/JSON; charset=UTF-8",
    'application/json; charset="utf-8"',
  ])("accepts the exact JSON media type %s", async (contentType) => {
    await expect(readAuthJsonObject(request("{}", {
      "content-type": contentType,
    }))).resolves.toEqual({});
  });
});
