// Author: Harsha Gundala
// template.ts — least-privilege generated-tool wrapper.

import { parse } from "acorn";
import { createPublicKey } from "node:crypto";

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const RESERVED_ENV_PREFIXES = [
  "AWS_",
  "AUTH_",
  "MCP_",
  "NEXT_",
  "NODE_",
  "TOOL_",
  "VERCEL_",
  "XAI_",
  "OPENAI_",
  "GEMINI_",
] as const;

const FORBIDDEN_SOURCE_IDENTIFIERS = new Set([
  "Bun",
  "Deno",
  "Function",
  "Proxy",
  "Reflect",
  "WebAssembly",
  "__dirname",
  "__filename",
  "__proto__",
  "constructor",
  "eval",
  "exports",
  "getPrototypeOf",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "global",
  "globalThis",
  "import",
  "module",
  "process",
  "prototype",
  "require",
  "setPrototypeOf",
  "setInterval",
  "setTimeout",
  "self",
  "with",
]);

export type ToolWrapperOptions = {
  keyId: string;
  publicKeySpki: string;
  envNames?: readonly string[];
};

type SyntaxNode = { type: string; [key: string]: unknown };

function visitSyntax(value: unknown, visit: (node: SyntaxNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitSyntax(item, visit);
    return;
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return;
  const node = value as SyntaxNode;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    visitSyntax(child, visit);
  }
}

/**
 * Generated tools are intentionally a narrow single-function surface, not arbitrary modules.
 * The deployment has no framework root secret, and this guard also prevents reaching ambient
 * runtime globals instead of the explicit allowlisted `env` argument.
 */
export function validateToolSource(source: string): void {
  if (Buffer.byteLength(source, "utf8") > 64_000) throw new Error("source exceeds 64KB");
  let program: ReturnType<typeof parse>;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    throw new Error("source must be valid JavaScript");
  }
  const declaration = program.body[0];
  if (
    program.body.length !== 1 ||
    declaration?.type !== "FunctionDeclaration" ||
    !declaration.async ||
    declaration.generator ||
    declaration.id?.name !== "run" ||
    (declaration.params.length !== 2 && declaration.params.length !== 3) ||
    declaration.params[0]?.type !== "Identifier" || declaration.params[0].name !== "input" ||
    declaration.params[1]?.type !== "Identifier" || declaration.params[1].name !== "env" ||
    (declaration.params[2] !== undefined &&
      (declaration.params[2].type !== "Identifier" || declaration.params[2].name !== "context"))
  ) {
    throw new Error("source must be exactly one async function run(input, env, context)");
  }
  visitSyntax(program, (node) => {
    if (node.type === "Identifier") {
      const identifier = String(node.name ?? "");
      if (FORBIDDEN_SOURCE_IDENTIFIERS.has(identifier) || identifier.toLowerCase().startsWith("__hacc")) {
        throw new Error(`source cannot access ambient runtime primitive "${identifier}"`);
      }
    }
    if (node.type === "MemberExpression" && node.computed) {
      const property = node.property as SyntaxNode | undefined;
      // Dynamic property names can synthesize `constructor`/`prototype` without ever placing a
      // forbidden identifier in the AST. Permit only literal array indexes; use dot properties
      // and for-of loops for everything else.
      if (property?.type !== "Literal" || typeof property.value !== "number" ||
          !Number.isSafeInteger(property.value) || property.value < 0) {
        throw new Error("source cannot use dynamic computed properties");
      }
    }
    if (node.type === "Property") {
      const property = node as SyntaxNode & { computed?: unknown; key?: SyntaxNode };
      // Object-pattern property selection is another property-read primitive. Reject every
      // computed form, and catch quoted dangerous names that do not appear as Identifier nodes.
      if (property.computed === true) {
        throw new Error("source cannot use dynamic computed properties");
      }
      if (property.key?.type === "Literal" &&
          typeof property.key.value === "string" &&
          (FORBIDDEN_SOURCE_IDENTIFIERS.has(property.key.value) ||
            property.key.value.toLowerCase().startsWith("__hacc"))) {
        throw new Error(`source cannot access ambient runtime primitive "${property.key.value}"`);
      }
    }
    if (node.type === "ImportExpression" || node.type === "WithStatement" || node.type === "DebuggerStatement") {
      throw new Error(`source cannot use ${node.type}`);
    }
  });
}

export function validateToolEnvironmentNames(names: readonly string[]): string[] {
  if (names.length > 50) throw new Error("a generated tool may request at most 50 environment values");
  const unique = [...new Set(names)];
  if (unique.length !== names.length) throw new Error("env_var_names must not contain duplicates");
  for (const name of unique) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment name "${name}"`);
    if (RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error(`environment name "${name}" uses a reserved platform prefix`);
    }
  }
  return unique.sort();
}

/** Selects only explicitly declared values; the returned view is immutable and prototype-free. */
export function selectToolEnvironment(
  runtimeEnvironment: Readonly<Record<string, string | undefined>>,
  names: readonly string[]
): Readonly<Record<string, string>> {
  const allowed = validateToolEnvironmentNames(names);
  const selected = Object.create(null) as Record<string, string>;
  for (const name of allowed) {
    const value = runtimeEnvironment[name];
    if (typeof value === "string") selected[name] = value;
  }
  return Object.freeze(selected);
}

/**
 * Generates a wrapper with public-key verification only. No bearer or HMAC secret is embedded,
 * and no framework secret is deployed. Each assertion is bound to this slug, key revision, exact
 * request bytes, a random nonce, and a 20-second validity window.
 */
export function wrapToolSource(slug: string, runSource: string, options: ToolWrapperOptions): string {
  validateToolSource(runSource);
  const envNames = validateToolEnvironmentNames(options.envNames ?? []);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("invalid tool slug");
  if (!/^tik_[A-Za-z0-9_-]{16}$/.test(options.keyId)) throw new Error("invalid tool invocation key id");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(options.publicKeySpki)) throw new Error("invalid tool public key");
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(options.publicKeySpki, "base64"),
      type: "spki",
      format: "der",
    });
    if (publicKey.asymmetricKeyType !== "ec" ||
        publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("wrong key type");
    }
  } catch {
    throw new Error("invalid P-256 tool public key");
  }

  return `// Auto-generated by Harsha's Amazing Call Center — tool: ${slug}
export const config = { runtime: "edge" };

const __HACC_SLUG__ = ${JSON.stringify(slug)};
const __HACC_KEY_ID__ = ${JSON.stringify(options.keyId)};
const __HACC_PUBLIC_KEY__ = ${JSON.stringify(options.publicKeySpki)};
const __HACC_ALLOWED_ENV__ = Object.freeze(${JSON.stringify(envNames)});
const __HACC_RUNTIME_ENV__ = globalThis.process?.env ?? {};
const __HACC_TOOL_ENV__ = (() => {
  const selected = Object.create(null);
  for (const name of __HACC_ALLOWED_ENV__) {
    if (typeof __HACC_RUNTIME_ENV__[name] === "string") selected[name] = __HACC_RUNTIME_ENV__[name];
  }
  return Object.freeze(selected);
})();
// Capture every security-sensitive intrinsic before untrusted code ever runs. Generated code and
// the wrapper share an isolate, so future global/prototype mutation must not change authorization.
const __HACC_GLOBAL__ = globalThis;
const __HACC_SUBTLE__ = __HACC_GLOBAL__.crypto.subtle;
const __HACC_DIGEST__ = __HACC_SUBTLE__.digest.bind(__HACC_SUBTLE__);
const __HACC_IMPORT_KEY__ = __HACC_SUBTLE__.importKey.bind(__HACC_SUBTLE__);
const __HACC_VERIFY__ = __HACC_SUBTLE__.verify.bind(__HACC_SUBTLE__);
const __HACC_ENCODE__ = new TextEncoder().encode.bind(new TextEncoder());
const __HACC_DECODE_TEXT__ = new TextDecoder().decode.bind(new TextDecoder());
const __HACC_PARSE__ = JSON.parse.bind(JSON);
const __HACC_NOW__ = Date.now.bind(Date);
const __HACC_SAFE_INTEGER__ = Number.isSafeInteger.bind(Number);
const __HACC_HEADER_GET__ = Function.prototype.call.bind(Headers.prototype.get);
const __HACC_METHOD_GET__ = Object.getOwnPropertyDescriptor(Request.prototype, "method").get;
const __HACC_HEADERS_GET__ = Object.getOwnPropertyDescriptor(Request.prototype, "headers").get;
const __HACC_BODY_GET__ = Object.getOwnPropertyDescriptor(Request.prototype, "body").get;
const __HACC_STREAM_READER__ = Function.prototype.call.bind(ReadableStream.prototype.getReader);
const __HACC_READER_READ__ = Function.prototype.call.bind(ReadableStreamDefaultReader.prototype.read);
const __HACC_READER_CANCEL__ = Function.prototype.call.bind(ReadableStreamDefaultReader.prototype.cancel);
const __HACC_RESPONSE__ = Response;
const __HACC_JSON_RESPONSE__ = Response.json.bind(Response);
const __HACC_ATOB__ = __HACC_GLOBAL__.atob.bind(__HACC_GLOBAL__);
const __HACC_UINT8__ = Uint8Array;
const __HACC_UINT8_FROM__ = Uint8Array.from.bind(Uint8Array);
const __HACC_UINT8_SET__ = Function.prototype.call.bind(Uint8Array.prototype.set);
const __HACC_CHAR_CODE__ = Function.prototype.call.bind(String.prototype.charCodeAt);
const __HACC_KEYS__ = Object.keys.bind(Object);
const __HACC_FREEZE__ = Object.freeze.bind(Object);
const __HACC_PUSH__ = Function.prototype.call.bind(Array.prototype.push);
const __HACC_MAX_BODY_BYTES__ = 1_000_000;
const __HACC_MAX_ASSERTION_CHARS__ = 8_192;
const __HACC_MAX_SIGNATURE_CHARS__ = 512;
const __HACC_SEEN__ = new Map();
const __HACC_SEEN_HAS__ = __HACC_SEEN__.has.bind(__HACC_SEEN__);
const __HACC_SEEN_SET__ = __HACC_SEEN__.set.bind(__HACC_SEEN__);
const __HACC_SEEN_DELETE__ = __HACC_SEEN__.delete.bind(__HACC_SEEN__);
const __HACC_SEEN_FOREACH__ = __HACC_SEEN__.forEach.bind(__HACC_SEEN__);
const process = Object.freeze({ env: __HACC_TOOL_ENV__ });

function __haccChars(value, length) {
  if (typeof value !== "string" || (length !== undefined && value.length !== length) || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = __HACC_CHAR_CODE__(value, i);
    const valid = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || code === 45 || code === 95;
    if (!valid) return false;
  }
  return true;
}
function __haccHex64(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = __HACC_CHAR_CODE__(value, i);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}
function __haccDecode(value) {
  if (!__haccChars(value)) throw new Error("invalid assertion encoding");
  let base64 = "";
  for (let i = 0; i < value.length; i += 1) {
    base64 += value[i] === "-" ? "+" : value[i] === "_" ? "/" : value[i];
  }
  while (base64.length % 4 !== 0) base64 += "=";
  return __HACC_UINT8_FROM__(__HACC_ATOB__(base64), (c) => __HACC_CHAR_CODE__(c, 0));
}
function __haccHex(bytes) {
  const view = new __HACC_UINT8__(bytes);
  const alphabet = "0123456789abcdef";
  let value = "";
  for (let i = 0; i < view.length; i += 1) value += alphabet[view[i] >> 4] + alphabet[view[i] & 15];
  return value;
}
function __haccDeclaredLength(value) {
  if (value === null) return -1;
  if (typeof value !== "string" || value.length === 0 || value.length > 16) return __HACC_MAX_BODY_BYTES__ + 1;
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = __HACC_CHAR_CODE__(value, i);
    if (code < 48 || code > 57) return __HACC_MAX_BODY_BYTES__ + 1;
    result = result * 10 + (code - 48);
    if (result > __HACC_MAX_BODY_BYTES__) return result;
  }
  return result;
}
async function __haccReadBody(req) {
  const stream = __HACC_BODY_GET__.call(req);
  if (stream === null) return "";
  const reader = __HACC_STREAM_READER__(stream);
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await __HACC_READER_READ__(reader);
      if (part.done) break;
      if (!part.value || typeof part.value.byteLength !== "number") throw new Error("invalid body chunk");
      bytes += part.value.byteLength;
      if (bytes > __HACC_MAX_BODY_BYTES__) {
        await __HACC_READER_CANCEL__(reader).catch(() => {});
        return null;
      }
      __HACC_PUSH__(chunks, part.value);
    }
    const joined = new __HACC_UINT8__(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      __HACC_UINT8_SET__(joined, chunk, offset);
      offset += chunk.byteLength;
    }
    return __HACC_DECODE_TEXT__(joined);
  } catch {
    await __HACC_READER_CANCEL__(reader).catch(() => {});
    return null;
  }
}
async function __haccAuthorize(req, body) {
  const headers = __HACC_HEADERS_GET__.call(req);
  const assertion = __HACC_HEADER_GET__(headers, "x-hacc-invocation") ?? "";
  const signature = __HACC_HEADER_GET__(headers, "x-hacc-signature") ?? "";
  if (!assertion || !signature) return false;
  let claims;
  let envelope;
  try {
    claims = __HACC_PARSE__(__HACC_DECODE_TEXT__(__haccDecode(assertion)));
    envelope = __HACC_PARSE__(body);
  } catch { return false; }
  const now = __HACC_NOW__();
  const digest = __haccHex(await __HACC_DIGEST__("SHA-256", __HACC_ENCODE__(body)));
  const metadata = envelope?.metadata;
  if (claims?.v !== 1 || claims?.kid !== __HACC_KEY_ID__ || claims?.tool !== __HACC_SLUG__ ||
      !__HACC_SAFE_INTEGER__(claims?.iat) || !__HACC_SAFE_INTEGER__(claims?.exp) ||
      claims.exp - claims.iat !== 20000 || claims.iat > now + 5000 || claims.exp < now ||
      !__haccChars(claims?.jti, 24) || claims.body_sha256 !== digest ||
      !__haccHex64(claims?.scope_sha256) || !__haccHex64(claims?.idempotency_sha256) ||
      (claims.audience !== "flow_action" && claims.audience !== "reconciliation" &&
       claims.audience !== "builder_test" && claims.audience !== "direct") ||
      !envelope || typeof envelope !== "object" || !("input" in envelope) ||
      !metadata || typeof metadata !== "object" || __HACC_KEYS__(metadata).length !== 3 ||
      metadata.invocation_id !== claims.jti || metadata.audience !== claims.audience ||
      typeof metadata.idempotency_key !== "string" || metadata.idempotency_key.length < 1 ||
      metadata.idempotency_key.length > 512 ||
      __haccHex(await __HACC_DIGEST__("SHA-256", __HACC_ENCODE__(metadata.idempotency_key))) !== claims.idempotency_sha256) {
    return false;
  }
  try {
    const key = await __HACC_IMPORT_KEY__(
      "spki", __HACC_UINT8_FROM__(__HACC_ATOB__(__HACC_PUBLIC_KEY__), (c) => __HACC_CHAR_CODE__(c, 0)),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
    );
    const valid = await __HACC_VERIFY__(
      { name: "ECDSA", hash: "SHA-256" }, key, __haccDecode(signature), __HACC_ENCODE__(assertion)
    );
    if (!valid) return false;
    __HACC_SEEN_FOREACH__((expiresAt, jti) => { if (expiresAt < now) __HACC_SEEN_DELETE__(jti); });
    if (__HACC_SEEN_HAS__(claims.jti)) return false;
    __HACC_SEEN_SET__(claims.jti, claims.exp);
    return { envelope, claims };
  } catch { return false; }
}

${runSource}

export default async function handler(req) {
  if (__HACC_METHOD_GET__.call(req) !== "POST") return new __HACC_RESPONSE__("POST only", { status: 405 });
  const headers = __HACC_HEADERS_GET__.call(req);
  if (__HACC_HEADER_GET__(headers, "content-type") !== "application/json") {
    return new __HACC_RESPONSE__("JSON only", { status: 415 });
  }
  const assertion = __HACC_HEADER_GET__(headers, "x-hacc-invocation") ?? "";
  const signature = __HACC_HEADER_GET__(headers, "x-hacc-signature") ?? "";
  if (!assertion || !signature ||
      assertion.length > __HACC_MAX_ASSERTION_CHARS__ || signature.length > __HACC_MAX_SIGNATURE_CHARS__) {
    return new __HACC_RESPONSE__("unauthorized", { status: 401 });
  }
  if (__haccDeclaredLength(__HACC_HEADER_GET__(headers, "content-length")) > __HACC_MAX_BODY_BYTES__) {
    return new __HACC_RESPONSE__("payload too large", { status: 413 });
  }
  const body = await __haccReadBody(req);
  if (body === null) return new __HACC_RESPONSE__("payload too large", { status: 413 });
  const authorized = await __haccAuthorize(req, body);
  if (!authorized) return new __HACC_RESPONSE__("unauthorized", { status: 401 });
  try {
    const metadata = __HACC_FREEZE__({
      invocationId: authorized.claims.jti,
      idempotencyKey: authorized.envelope.metadata.idempotency_key,
      audience: authorized.claims.audience,
    });
    const output = await run(authorized.envelope.input, __HACC_TOOL_ENV__, metadata);
    return __HACC_JSON_RESPONSE__({ ok: true, output });
  } catch {
    // A generated tool may include a granted credential in its exception. Never echo it.
    return __HACC_JSON_RESPONSE__({ ok: false, error: "tool execution failed" }, { status: 500 });
  }
}
`;
}

export const RUN_SIGNATURE_DOC = `Write exactly one self-contained JavaScript function:
  async function run(input, env, context) { ... return <json-serializable>; }
- input: object matching the tool's JSON Schema.
- env: an immutable, prototype-free object containing only names declared in env_var_names.
- context: immutable { invocationId, idempotencyKey, audience }; forward idempotencyKey to mutating downstream APIs.
- Ambient runtime access (process/globalThis/import/require/eval/Function/prototype escapes) is rejected.
- The syntax check is defense-in-depth, not a sandbox. Generated code is trusted with explicitly granted env values.
- Use fetch() for external APIs. No imports or filesystem. Must complete in <20s.`;
