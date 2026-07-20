// Author: Harsha Gundala
// invocation.ts — per-tool asymmetric invocation assertions for generated tools.

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { deriveFlowActionInvocationId } from "../flow-runtime";
import { decryptSecret, encryptSecret } from "../vault";

const ASSERTION_VERSION = 1;
const ASSERTION_TTL_MS = 20_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export type ToolInvocationKeyPair = {
  keyId: string;
  publicKeySpki: string;
  privateKeyPkcs8Encrypted: string;
};

export type ToolInvocationSigner = {
  keyId: string;
  privateKeyPkcs8Encrypted: string;
  slug: string;
};

export type ToolInvocationClaims = {
  v: 1;
  kid: string;
  tool: string;
  audience: "flow_action" | "reconciliation" | "builder_test" | "direct";
  iat: number;
  exp: number;
  jti: string;
  body_sha256: string;
  scope_sha256: string;
  idempotency_sha256: string;
};

export type ToolInvocationContext = {
  orgId: string;
  toolId: string;
  /** Stable across retries/takeover for one persisted action receipt. */
  invocationId: string;
  audience: ToolInvocationClaims["audience"];
  idempotencyKey: string;
  callId?: string;
  agentId?: string;
  runtimeDigest?: string;
  receiptId?: string;
};

export type SignedToolInvocation = {
  body: string;
  headers: Readonly<Record<string, string>>;
  claims: Readonly<ToolInvocationClaims>;
};

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function parseBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid invocation encoding");
  return Buffer.from(value, "base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deriveToolInvocationId(stableIdentity: string): string {
  return deriveFlowActionInvocationId(stableIdentity);
}

function scopeDigest(context: ToolInvocationContext): string {
  return sha256(JSON.stringify({
    org_id: context.orgId,
    tool_id: context.toolId,
    invocation_id: context.invocationId,
    audience: context.audience,
    call_id: context.callId ?? null,
    agent_id: context.agentId ?? null,
    runtime_digest: context.runtimeDigest ?? null,
    receipt_id: context.receiptId ?? null,
  }));
}

function validateContext(context: ToolInvocationContext): void {
  for (const [name, value] of Object.entries({
    orgId: context.orgId,
    toolId: context.toolId,
    invocationId: context.invocationId,
    idempotencyKey: context.idempotencyKey,
    callId: context.callId,
    agentId: context.agentId,
    runtimeDigest: context.runtimeDigest,
    receiptId: context.receiptId,
  })) {
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 512)) {
      throw new Error(`invalid tool invocation ${name}`);
    }
  }
  if (!(["flow_action", "reconciliation", "builder_test", "direct"] as const).includes(context.audience)) {
    throw new Error("invalid tool invocation audience");
  }
  if (!/^[A-Za-z0-9_-]{24}$/.test(context.invocationId)) {
    throw new Error("invalid stable tool invocation id");
  }
  if ((context.audience === "flow_action" || context.audience === "reconciliation") &&
      (!context.callId || !context.agentId || !context.runtimeDigest || !context.receiptId)) {
    throw new Error("flow tool invocation requires call, agent, runtime, and receipt binding");
  }
}

export function generateToolInvocationKeyPair(): ToolInvocationKeyPair {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeySpki = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateKeyPkcs8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    keyId: `tik_${randomBytes(12).toString("base64url")}`,
    publicKeySpki,
    privateKeyPkcs8Encrypted: encryptSecret(privateKeyPkcs8),
  };
}

export function signToolInvocation(
  input: unknown,
  signer: ToolInvocationSigner,
  context: ToolInvocationContext,
  options: { now?: number; jti?: string } = {}
): SignedToolInvocation {
  if (!/^tik_[A-Za-z0-9_-]{16}$/.test(signer.keyId)) {
    throw new Error("invalid tool invocation key id");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(signer.slug)) {
    throw new Error("invalid tool slug");
  }
  validateContext(context);
  const now = options.now ?? Date.now();
  const jti = options.jti ?? context.invocationId;
  if (!/^[A-Za-z0-9_-]{24}$/.test(jti)) throw new Error("invalid tool invocation id");
  if (jti !== context.invocationId) throw new Error("tool invocation id does not match its persisted context");
  const body = JSON.stringify({
    input,
    metadata: {
      invocation_id: jti,
      idempotency_key: context.idempotencyKey,
      audience: context.audience,
    },
  });
  if (body === undefined) throw new Error("tool input is not JSON-serializable");
  const claims: ToolInvocationClaims = {
    v: ASSERTION_VERSION,
    kid: signer.keyId,
    tool: signer.slug,
    audience: context.audience,
    iat: now,
    exp: now + ASSERTION_TTL_MS,
    jti,
    body_sha256: sha256(body),
    scope_sha256: scopeDigest(context),
    idempotency_sha256: sha256(context.idempotencyKey),
  };
  const assertion = base64Url(JSON.stringify(claims));
  const privateKey = decryptSecret(signer.privateKeyPkcs8Encrypted);
  let signature: Buffer;
  try {
    signature = signBytes("sha256", Buffer.from(assertion, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
  } finally {
    // Strings cannot be zeroed, so keep the decrypted key in the narrowest possible scope and
    // never return, log, serialize, or attach it to a request.
  }
  return Object.freeze({
    body,
    claims: Object.freeze(claims),
    headers: Object.freeze({
      "Content-Type": "application/json",
      "X-HACC-Invocation": assertion,
      "X-HACC-Signature": signature.toString("base64url"),
    }),
  });
}

/** Node-side verifier used by tests and self-hosted generated-tool runtimes. */
export function verifyToolInvocation(
  signed: Pick<SignedToolInvocation, "body" | "headers">,
  expected: {
    keyId: string;
    slug: string;
    publicKeySpki: string;
    context: ToolInvocationContext;
    now?: number;
  }
): ToolInvocationClaims {
  const assertion = signed.headers["X-HACC-Invocation"] ?? signed.headers["x-hacc-invocation"];
  const encodedSignature = signed.headers["X-HACC-Signature"] ?? signed.headers["x-hacc-signature"];
  if (!assertion || !encodedSignature) throw new Error("missing invocation assertion");
  let claims: ToolInvocationClaims;
  try {
    claims = JSON.parse(parseBase64Url(assertion).toString("utf8")) as ToolInvocationClaims;
  } catch {
    throw new Error("invalid invocation assertion");
  }
  validateContext(expected.context);
  const now = expected.now ?? Date.now();
  if (
    claims.v !== ASSERTION_VERSION ||
    claims.kid !== expected.keyId ||
    claims.tool !== expected.slug ||
    claims.audience !== expected.context.audience ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp - claims.iat !== ASSERTION_TTL_MS ||
    claims.iat > now + MAX_CLOCK_SKEW_MS ||
    claims.exp < now ||
    !/^[A-Za-z0-9_-]{24}$/.test(claims.jti) ||
    claims.body_sha256 !== sha256(signed.body) ||
    claims.scope_sha256 !== scopeDigest(expected.context) ||
    claims.idempotency_sha256 !== sha256(expected.context.idempotencyKey)
  ) {
    throw new Error("invalid or expired invocation assertion");
  }
  const publicKey = {
    key: Buffer.from(expected.publicKeySpki, "base64"),
    type: "spki" as const,
    format: "der" as const,
  };
  const valid = verifyBytes(
    "sha256",
    Buffer.from(assertion, "utf8"),
    { ...publicKey, dsaEncoding: "ieee-p1363" },
    parseBase64Url(encodedSignature)
  );
  if (!valid) throw new Error("invalid invocation signature");
  return claims;
}

export const TOOL_INVOCATION_TTL_MS = ASSERTION_TTL_MS;
