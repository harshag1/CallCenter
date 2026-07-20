import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Mutation = Readonly<{ method: string; source: string }>;

async function routeFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return routeFiles(url);
    return entry.name === "route.ts" ? [url] : [];
  }));
  return nested.flat();
}

function mutations(source: string): Mutation[] {
  const matches = [...source.matchAll(
    /export\s+(?:(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|const\s+(GET|POST|PUT|PATCH|DELETE)\s*=)/g,
  )];
  return matches.flatMap((match, index) => {
    const method = match[1] ?? match[2];
    if (method === "GET") return [];
    return [{
      method,
      source: source.slice(match.index!, matches[index + 1]?.index ?? source.length),
    }];
  });
}

type ExternalBoundary = Readonly<{
  handler: RegExp;
  route: RegExp;
}>;

const EXPLICIT_NON_COOKIE_MUTATIONS = new Map<string, ExternalBoundary>([
  ["POST auth/send-code/route.ts", { handler: /readAuthJsonObject\s*\(/, route: /readAuthJsonObject\s*\(/ }],
  ["POST auth/verify-code/route.ts", { handler: /readAuthJsonObject\s*\(/, route: /readAuthJsonObject\s*\(/ }],
  ["POST mcp/route.ts", { handler: /verifyScope\s*\(/, route: /verifyScope\s*\(/ }],
  ["POST telephony/bridge/capabilities/rotate/route.ts", { handler: /verifyScope\s*\(/, route: /verifyScope\s*\(/ }],
  ["POST telephony/events/route.ts", { handler: /verifyScope\s*\(/, route: /verifyScope\s*\(/ }],
  ["POST telephony/session/route.ts", { handler: /verifyScope\s*\(/, route: /verifyScope\s*\(/ }],
  ["POST telephony/status/route.ts", { handler: /verifyTwilioWebhook\s*\(/, route: /verifyTwilioWebhook\s*\(/ }],
  ["POST telephony/twiml/route.ts", { handler: /return\s+handle\s*\(req\)/, route: /async function handle[\s\S]*verifyTwilioWebhook\s*\(/ }],
  ["POST voice/webhooks/route.ts", { handler: /verifyXaiWebhook\s*\(/, route: /verifyXaiWebhook\s*\(/ }],
]);

const WRAPPED_COOKIE_MUTATIONS = new Set([
  "POST datasets/[id]/rows/route.ts",
  "PATCH datasets/[id]/rows/route.ts",
  "DELETE datasets/[id]/rows/route.ts",
]);

describe("cookie-authenticated browser mutation inventory", () => {
  it("guards every cookie/session mutation before identity or side-effect access", async () => {
    const apiRoot = new URL("../../app/api/", import.meta.url);
    const failures: string[] = [];
    const classified = new Set<string>();
    let guarded = 0;
    for (const file of await routeFiles(apiRoot)) {
      const source = await readFile(file, "utf8");
      const relative = decodeURIComponent(file.href.slice(apiRoot.href.length));
      for (const mutation of mutations(source)) {
        const key = `${mutation.method} ${relative}`;
        const sessionIndex = mutation.source.search(/\b(?:getSession|requireSession)\s*\(/);
        const cookieIndex = mutation.source.search(/cookies\s*\(\)/);
        // Logout intentionally parses the raw Cookie header through the shared
        // duplicate-preserving revocation helper instead of Next's lossy cookie store.
        const rawCookieRevocationIndex = key === "POST auth/logout/route.ts"
          ? mutation.source.search(/\brevokePresentedSessions\s*\(/)
          : -1;
        const authorityIndex = sessionIndex >= 0
          ? sessionIndex
          : cookieIndex >= 0
            ? cookieIndex
            : rawCookieRevocationIndex;
        if (authorityIndex < 0) {
          if (WRAPPED_COOKIE_MUTATIONS.has(key)) {
            guarded += 1;
            classified.add(key);
            const bodyIndex = mutation.source.search(/await\s+privateBody\s*\(req\)/);
            const scopeIndex = mutation.source.search(/await\s+scoped\s*\(id,\s*true\)/);
            if (bodyIndex < 0 || scopeIndex < 0 || bodyIndex > scopeIndex) {
              failures.push(`${key}: guarded body wrapper must precede cookie scope wrapper`);
            }
            if (!/async function privateBody[\s\S]*assertSameOriginBrowserMutation\s*\(req\)[\s\S]*readPrivateJsonObject\s*\(req/.test(source)) {
              failures.push(`${key}: private body wrapper must use the shared origin and bounded JSON boundary`);
            }
            if (!/async function scoped[\s\S]*getSession\s*\(/.test(source)) {
              failures.push(`${key}: scope wrapper must remain cookie-authenticated`);
            }
            continue;
          }
          const external = EXPLICIT_NON_COOKIE_MUTATIONS.get(key);
          if (!external) {
            failures.push(`${key}: mutation has no classified cookie or external authentication boundary`);
            continue;
          }
          classified.add(key);
          if (!external.handler.test(mutation.source) || !external.route.test(source)) {
            failures.push(`${key}: explicit external authentication boundary is missing`);
          }
          continue;
        }
        guarded += 1;
        classified.add(key);
        const guardIndex = mutation.source.indexOf("assertSameOriginBrowserMutation(");
        if (guardIndex < 0 || guardIndex > authorityIndex) {
          failures.push(`${key}: guard must precede cookie authority`);
        }
        if (/\.(?:json|formData)\s*\(\)|\breadJson\s*</.test(mutation.source)) {
          failures.push(`${key}: permissive body parser bypasses private request limits`);
        }
      }
    }
    expect(guarded).toBeGreaterThanOrEqual(20);
    expect(
      [...EXPLICIT_NON_COOKIE_MUTATIONS.keys()].filter((key) => !classified.has(key)),
      "every explicit machine/login ingress remains present in the route inventory",
    ).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("keeps non-cookie machine ingress on explicit authentication boundaries", async () => {
    const checks = [
      ["bridge/route.ts", /verifyTwilioStreamUpgrade\s*\(/],
      ["cron/scheduler/route.ts", /authorizeCronRequest\s*\(/],
      ["mcp/route.ts", /verifyScope\s*\(/],
      ["telephony/bridge/capabilities/rotate/route.ts", /verifyScope\s*\(/],
      ["telephony/events/route.ts", /verifyScope\s*\(/],
      ["telephony/session/route.ts", /verifyScope\s*\(/],
      ["telephony/status/route.ts", /verifyTwilioWebhook\s*\(/],
      ["telephony/twiml/route.ts", /verifyTwilioWebhook\s*\(/],
      ["voice/webhooks/route.ts", /verifyXaiWebhook\s*\(/],
    ] as const;
    const apiRoot = new URL("../../app/api/", import.meta.url);
    for (const [relative, authPattern] of checks) {
      const source = await readFile(new URL(relative, apiRoot), "utf8");
      expect(source, relative).not.toMatch(/\b(?:getSession|requireSession)\s*\(/);
      expect(source, relative).toMatch(authPattern);
    }
  });

  it("keeps canonical standalone-bridge aliases pinned to the verified handlers", async () => {
    const apiRoot = new URL("../../app/api/", import.meta.url);
    const aliases = [
      ["telephony/bridge/events/route.ts", /export \{ POST \} from "@\/app\/api\/telephony\/events\/route";/],
      ["telephony/bridge/session/route.ts", /export \{ POST \} from "\.\.\/\.\.\/session\/route";/],
    ] as const;
    for (const [relative, expectedExport] of aliases) {
      const source = await readFile(new URL(relative, apiRoot), "utf8");
      expect(source, relative).toMatch(expectedExport);
      expect(source, relative).not.toMatch(/export async function POST/);
    }
  });

  it("uses the duplicate-aware shared parser for authority-bearing bridge exchanges", async () => {
    const apiRoot = new URL("../../app/api/", import.meta.url);
    for (const relative of [
      "mcp/route.ts",
      "telephony/events/route.ts",
      "telephony/session/route.ts",
      "telephony/bridge/capabilities/rotate/route.ts",
    ]) {
      const source = await readFile(new URL(relative, apiRoot), "utf8");
      const post = mutations(source).find((mutation) => mutation.method === "POST")?.source ?? "";
      expect(post, relative).toContain("readStrictJsonObject(");
      expect(post, relative).not.toMatch(/JSON\.parse\s*\(/);
    }
  });

  it("keeps unauthenticated login delivery non-simple and strictly bounded", async () => {
    const apiRoot = new URL("../../app/api/", import.meta.url);
    for (const relative of ["auth/send-code/route.ts", "auth/verify-code/route.ts"]) {
      const source = await readFile(new URL(relative, apiRoot), "utf8");
      expect(source, relative).toContain("readAuthJsonObject(");
      expect(source, relative).not.toMatch(/\.json\s*\(\)/);
    }
  });
});
