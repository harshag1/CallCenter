// Non-authorizing credential form slots. Models receive only public correlation
// ids; plaintext moves from a same-origin form directly into a trusted sink.

import { randomUUID as nodeRandomUUID } from "node:crypto";
import { ensureSafeDatabaseRuntimeRole, getPool, q } from "./db";
import {
  encryptCredentialSecret,
  type CredentialSecretContext,
} from "./vault";
import {
  mcpAuthorizationCredentialPurpose,
  remoteMcpNamespace,
  snapshotExternalMcpServer,
  type McpRegistryServer,
} from "./remote-mcp-runtime";

export const MAX_CREDENTIAL_BYTES = 32 * 1024;
export const CREDENTIAL_SLOT_TTL_MS = 10 * 60_000;

const MAX_ENCRYPTED_CREDENTIAL_BYTES = 256 * 1024;
const MAX_LIVE_SLOTS_PER_ORG = 25;
const MAX_COLLISION_ATTEMPTS = 4;
const SLOT_CLAIM_TTL_SECONDS = 45;
const SLOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export type CredentialVaultQuery = (
  text: string,
  params?: unknown[]
) => Promise<unknown[]>;

export class CredentialVaultError extends Error {
  readonly code: "invalid_input" | "unavailable" | "corrupt_record" | "sink_failed";

  constructor(code: CredentialVaultError["code"]) {
    super(
      code === "invalid_input"
        ? "invalid credential handoff input"
        : code === "corrupt_record"
          ? "credential handoff record could not be verified"
          : code === "sink_failed"
            ? "credential destination could not be finalized"
            : "credential handoff is unavailable"
    );
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

export function isValidCredentialValue(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_CREDENTIAL_BYTES;
}

function requireOrgId(orgId: unknown): asserts orgId is string {
  // Org IDs originate from authenticated server state. A conservative UUID check
  // catches accidental use of model-authored or browser-authored identifiers.
  if (
    typeof orgId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orgId)
  ) {
    throw new CredentialVaultError("invalid_input");
  }
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

// ---------------------------------------------------------------------------
// Non-authorizing credential slots
// ---------------------------------------------------------------------------

export type CredentialSlotRequest =
  | Readonly<{
      kind: "env_var";
      name: string;
    }>
  | Readonly<{
      kind: "mcp_server";
      label: string;
      serverUrl: string;
      allowedTools?: readonly string[] | null;
    }>;

type StoredCredentialSlotSink =
  | Readonly<{
      kind: "env_var";
      name: string;
    }>
  | Readonly<{
      kind: "mcp_server";
      serverId: string;
      label: string;
      serverUrl: string;
      allowedTools: string[] | null;
    }>;

export type CredentialSlotReceipt =
  | Readonly<{
      kind: "env_var";
      name: string;
    }>
  | Readonly<{
      kind: "mcp_server";
      id: string;
      namespace: string;
      catalog_hash: string;
      tool_count: number;
    }>;

export type IssuedCredentialSlot = Readonly<{
  /** Correlation only. Possession grants no secret read or sink-finalize authority. */
  slotId: string;
  expiresAt: string;
  kind: CredentialSlotRequest["kind"];
}>;

export type CredentialSlotFinalization =
  | Readonly<{
      status: "completed";
      replayed: boolean;
      receipt: CredentialSlotReceipt;
    }>
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "already_used";
    }>;

export type CredentialSlotDependencies = Readonly<{
  query: CredentialVaultQuery;
  transaction?: <T>(work: (query: CredentialVaultQuery) => Promise<T>) => Promise<T>;
  encrypt: (plaintext: string, context: CredentialSecretContext) => string;
  randomUUID: () => string;
  snapshotMcp: (server: McpRegistryServer) => ReturnType<typeof snapshotExternalMcpServer>;
}>;

async function withCredentialSlotTransaction<T>(
  work: (query: CredentialVaultQuery) => Promise<T>
): Promise<T> {
  await ensureSafeDatabaseRuntimeRole();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const query: CredentialVaultQuery = async (text, params = []) => (
      await client.query(text, params as never[])
    ).rows;
    const result = await work(query);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const defaultSlotDependencies: CredentialSlotDependencies = {
  query: q as unknown as CredentialVaultQuery,
  transaction: withCredentialSlotTransaction,
  encrypt: encryptCredentialSecret,
  randomUUID: nodeRandomUUID,
  snapshotMcp: snapshotExternalMcpServer,
};

function requireSlotId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SLOT_ID_PATTERN.test(value)) {
    throw new CredentialVaultError("invalid_input");
  }
}

function validMcpLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function canonicalMcpServerUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new CredentialVaultError("invalid_input");
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) throw new CredentialVaultError("invalid_input");
    return parsed.toString();
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw new CredentialVaultError("invalid_input");
  }
}

function canonicalAllowedMcpTools(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 256) {
    throw new CredentialVaultError("invalid_input");
  }
  const tools = value.map((entry) => {
    if (typeof entry !== "string" || !MCP_TOOL_NAME_PATTERN.test(entry)) {
      throw new CredentialVaultError("invalid_input");
    }
    return entry;
  });
  if (new Set(tools).size !== tools.length) throw new CredentialVaultError("invalid_input");
  return [...tools].sort();
}

function normalizeSlotRequest(
  request: CredentialSlotRequest,
  randomUUID: () => string
): Readonly<{ purpose: string; sink: StoredCredentialSlotSink }> {
  if (!request || typeof request !== "object") throw new CredentialVaultError("invalid_input");
  if (request.kind === "env_var") {
    if (!ENV_NAME_PATTERN.test(request.name)) throw new CredentialVaultError("invalid_input");
    return Object.freeze({
      purpose: `env_var:${request.name}`,
      sink: Object.freeze({ kind: "env_var" as const, name: request.name }),
    });
  }
  if (request.kind === "mcp_server") {
    if (!validMcpLabel(request.label)) throw new CredentialVaultError("invalid_input");
    const serverUrl = canonicalMcpServerUrl(request.serverUrl);
    const serverId = randomUUID();
    requireSlotId(serverId);
    return Object.freeze({
      purpose: mcpAuthorizationCredentialPurpose(serverUrl),
      sink: Object.freeze({
        kind: "mcp_server" as const,
        serverId,
        label: request.label,
        serverUrl,
        allowedTools: canonicalAllowedMcpTools(request.allowedTools),
      }),
    });
  }
  throw new CredentialVaultError("invalid_input");
}

function parseStoredSlotSink(
  value: unknown,
  expectedKind: unknown,
  expectedPurpose: unknown
): StoredCredentialSlotSink {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new CredentialVaultError("corrupt_record");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialVaultError("corrupt_record");
  }
  const candidate = parsed as Record<string, unknown>;
  if (expectedKind === "env_var" && candidate.kind === "env_var") {
    if (typeof candidate.name !== "string" || !ENV_NAME_PATTERN.test(candidate.name)) {
      throw new CredentialVaultError("corrupt_record");
    }
    const sink = Object.freeze({ kind: "env_var" as const, name: candidate.name });
    if (expectedPurpose !== `env_var:${sink.name}`) throw new CredentialVaultError("corrupt_record");
    return sink;
  }
  if (expectedKind === "mcp_server" && candidate.kind === "mcp_server") {
    if (
      typeof candidate.serverId !== "string"
      || !SLOT_ID_PATTERN.test(candidate.serverId)
      || !validMcpLabel(candidate.label)
    ) throw new CredentialVaultError("corrupt_record");
    const serverUrl = canonicalMcpServerUrl(candidate.serverUrl);
    const allowedTools = canonicalAllowedMcpTools(candidate.allowedTools);
    if (expectedPurpose !== mcpAuthorizationCredentialPurpose(serverUrl)) {
      throw new CredentialVaultError("corrupt_record");
    }
    return Object.freeze({
      kind: "mcp_server" as const,
      serverId: candidate.serverId,
      label: candidate.label,
      serverUrl,
      allowedTools,
    });
  }
  throw new CredentialVaultError("corrupt_record");
}

function parseSlotReceipt(value: unknown): CredentialSlotReceipt {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new CredentialVaultError("corrupt_record");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialVaultError("corrupt_record");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kind === "env_var" && typeof candidate.name === "string" && ENV_NAME_PATTERN.test(candidate.name)) {
    return Object.freeze({ kind: "env_var" as const, name: candidate.name });
  }
  if (
    candidate.kind === "mcp_server"
    && typeof candidate.id === "string"
    && SLOT_ID_PATTERN.test(candidate.id)
    && typeof candidate.namespace === "string"
    && candidate.namespace === remoteMcpNamespace(candidate.id)
    && typeof candidate.catalog_hash === "string"
    && /^[a-f0-9]{64}$/.test(candidate.catalog_hash)
    && typeof candidate.tool_count === "number"
    && Number.isSafeInteger(candidate.tool_count)
    && candidate.tool_count >= 0
    && candidate.tool_count <= 256
  ) {
    return Object.freeze({
      kind: "mcp_server" as const,
      id: candidate.id,
      namespace: candidate.namespace,
      catalog_hash: candidate.catalog_hash,
      tool_count: candidate.tool_count,
    });
  }
  throw new CredentialVaultError("corrupt_record");
}

/** Creates a model-visible correlation slot that contains no credential or credential bearer. */
export async function createCredentialIngestSlot(
  input: Readonly<{ orgId: string; request: CredentialSlotRequest }>,
  dependencies: CredentialSlotDependencies = defaultSlotDependencies
): Promise<IssuedCredentialSlot> {
  requireOrgId(input.orgId);
  let normalized: ReturnType<typeof normalizeSlotRequest>;
  try {
    normalized = normalizeSlotRequest(input.request, dependencies.randomUUID);
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    throw new CredentialVaultError("unavailable");
  }
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    let slotId: string;
    try {
      slotId = dependencies.randomUUID();
      requireSlotId(slotId);
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError("unavailable");
    }
    try {
      if (!dependencies.transaction) throw new CredentialVaultError("unavailable");
      const rows = await dependencies.transaction(async (query) => {
        const lock = await query(
          `SELECT pg_try_advisory_xact_lock(
             hashtextextended(($1::uuid)::text, 910837)
           ) AS acquired`,
          [input.orgId]
        );
        if ((lock[0] as { acquired?: unknown } | undefined)?.acquired !== true) return [];
        return query(
          `WITH stale AS MATERIALIZED (
             SELECT slot_id
             FROM hacc_private.credential_ingest_slots
             WHERE expires_at <= now()
             ORDER BY expires_at
             LIMIT 100
             FOR UPDATE SKIP LOCKED
           ), pruned AS (
             DELETE FROM hacc_private.credential_ingest_slots slots
             USING stale
             WHERE slots.slot_id = stale.slot_id
             RETURNING 1
           )
           INSERT INTO hacc_private.credential_ingest_slots
             (slot_id, org_id, purpose, sink_kind, sink_config, expires_at)
           SELECT $1,$2::uuid,$3,$4,$5::jsonb,
                  clock_timestamp() + ($6::bigint * interval '1 millisecond')
           WHERE (SELECT count(*) FROM pruned) >= 0
             AND (SELECT count(*) FROM hacc_private.credential_ingest_slots
                  WHERE org_id = $2::uuid
                    AND expires_at > now()) < $7
           RETURNING expires_at`,
          [
            slotId,
            input.orgId,
            normalized.purpose,
            normalized.sink.kind,
            JSON.stringify(normalized.sink),
            CREDENTIAL_SLOT_TTL_MS,
            MAX_LIVE_SLOTS_PER_ORG,
          ]
        );
      });
      const expiresAt = new Date(
        (rows[0] as { expires_at?: Date | string } | undefined)?.expires_at ?? Number.NaN
      );
      if (!Number.isFinite(expiresAt.getTime())) throw new CredentialVaultError("unavailable");
      return Object.freeze({ slotId, expiresAt: expiresAt.toISOString(), kind: normalized.sink.kind });
    } catch (error) {
      if (uniqueViolation(error) && attempt + 1 < MAX_COLLISION_ATTEMPTS) continue;
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError("unavailable");
    }
  }
  throw new CredentialVaultError("unavailable");
}

type ClaimedCredentialSlot = Readonly<{
  slotId: string;
  orgId: string;
  claimToken: string;
  sink: StoredCredentialSlotSink;
}>;

async function abortCredentialSlotClaim(
  claim: ClaimedCredentialSlot,
  dependencies: Pick<CredentialSlotDependencies, "query">
): Promise<void> {
  await dependencies.query(
    `UPDATE hacc_private.credential_ingest_slots
     SET state = 'pending',
         claim_token = NULL,
         claimed_at = NULL,
         claim_expires_at = NULL,
         last_error_code = 'sink_failed'
     WHERE slot_id = $1
       AND org_id = $2
       AND state = 'finalizing'
       AND claim_token = $3
       AND expires_at > now()`,
    [claim.slotId, claim.orgId, claim.claimToken]
  ).catch(() => {});
}

async function claimCredentialSlot(
  orgId: string,
  slotId: string,
  submissionId: string,
  dependencies: CredentialSlotDependencies
): Promise<ClaimedCredentialSlot | CredentialSlotFinalization> {
  let claimToken: string;
  try {
    claimToken = dependencies.randomUUID();
    requireSlotId(claimToken);
  } catch {
    throw new CredentialVaultError("unavailable");
  }
  let rows: unknown[];
  try {
    rows = await dependencies.query(
      `UPDATE hacc_private.credential_ingest_slots
       SET state = 'finalizing',
           claim_token = $3,
           claimed_at = now(),
           claim_expires_at = now() + ($4::integer * interval '1 second'),
           attempts = attempts + 1,
           last_error_code = NULL
       WHERE slot_id = $1
         AND org_id = $2
         AND expires_at > now()
         AND attempts < 5
         AND (state = 'pending' OR (state = 'finalizing' AND claim_expires_at <= now()))
       RETURNING purpose, sink_kind, sink_config`,
      [slotId, orgId, claimToken, SLOT_CLAIM_TTL_SECONDS]
    );
  } catch {
    throw new CredentialVaultError("unavailable");
  }
  const claimed = rows[0] as {
    purpose?: unknown;
    sink_kind?: unknown;
    sink_config?: unknown;
  } | undefined;
  if (claimed) {
    try {
      return Object.freeze({
        slotId,
        orgId,
        claimToken,
        sink: parseStoredSlotSink(claimed.sink_config, claimed.sink_kind, claimed.purpose),
      });
    } catch (error) {
      await abortCredentialSlotClaim({
        slotId,
        orgId,
        claimToken,
        sink: Object.freeze({ kind: "env_var", name: "CORRUPT" }),
      }, dependencies);
      throw error;
    }
  }

  let stateRows: unknown[];
  try {
    stateRows = await dependencies.query(
      `SELECT state, completion_receipt, completion_submission_id
       FROM hacc_private.credential_ingest_slots
       WHERE slot_id = $1 AND org_id = $2`,
      [slotId, orgId]
    );
  } catch {
    throw new CredentialVaultError("unavailable");
  }
  const state = stateRows[0] as {
    state?: unknown;
    completion_receipt?: unknown;
    completion_submission_id?: unknown;
  } | undefined;
  if (state?.state === "completed") {
    if (
      typeof state.completion_submission_id !== "string"
      || !SLOT_ID_PATTERN.test(state.completion_submission_id)
    ) throw new CredentialVaultError("corrupt_record");
    if (state.completion_submission_id.toLowerCase() !== submissionId.toLowerCase()) {
      return Object.freeze({ status: "already_used" as const });
    }
    return Object.freeze({
      status: "completed" as const,
      replayed: true,
      receipt: parseSlotReceipt(state.completion_receipt),
    });
  }
  return Object.freeze({ status: "unavailable" as const });
}

async function commitEnvSlot(
  claim: ClaimedCredentialSlot & Readonly<{ sink: Extract<StoredCredentialSlotSink, { kind: "env_var" }> }>,
  encrypted: string,
  receipt: Extract<CredentialSlotReceipt, { kind: "env_var" }>,
  submissionId: string,
  dependencies: CredentialSlotDependencies
): Promise<boolean> {
  const rows = await dependencies.query(
    `WITH claimed AS MATERIALIZED (
       SELECT slot_id
       FROM hacc_private.credential_ingest_slots
       WHERE slot_id = $1
         AND org_id = $2
         AND state = 'finalizing'
         AND claim_token = $3
         AND claim_expires_at > now()
         AND expires_at > now()
       FOR UPDATE
     ), persisted AS (
       INSERT INTO env_vars (org_id, name, value_encrypted, value_encryption_slot_id)
       SELECT $2,$4,$5,$1::uuid FROM claimed
       ON CONFLICT (org_id, name) DO UPDATE
       SET value_encrypted = EXCLUDED.value_encrypted,
           value_encryption_slot_id = EXCLUDED.value_encryption_slot_id,
           updated_at = now()
       RETURNING 1
     ), completed AS (
       UPDATE hacc_private.credential_ingest_slots slots
       SET state = 'completed',
           completion_receipt = $6::jsonb,
           completion_submission_id = $7::uuid,
           completed_at = now(),
           claim_token = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL,
           last_error_code = NULL
       WHERE slots.slot_id = $1
         AND slots.org_id = $2
         AND slots.claim_token = $3
         AND EXISTS (SELECT 1 FROM persisted)
       RETURNING 1
     )
     SELECT 1 FROM completed`,
    [
      claim.slotId,
      claim.orgId,
      claim.claimToken,
      claim.sink.name,
      encrypted,
      JSON.stringify(receipt),
      submissionId,
    ]
  );
  return Boolean(rows[0]);
}

async function commitMcpSlot(
  claim: ClaimedCredentialSlot & Readonly<{ sink: Extract<StoredCredentialSlotSink, { kind: "mcp_server" }> }>,
  encrypted: string,
  receipt: Extract<CredentialSlotReceipt, { kind: "mcp_server" }>,
  manifest: Awaited<ReturnType<typeof snapshotExternalMcpServer>>,
  submissionId: string,
  dependencies: CredentialSlotDependencies
): Promise<boolean> {
  const rows = await dependencies.query(
    `WITH claimed AS MATERIALIZED (
       SELECT slot_id
       FROM hacc_private.credential_ingest_slots
       WHERE slot_id = $1
         AND org_id = $2
         AND state = 'finalizing'
         AND claim_token = $3
         AND claim_expires_at > now()
         AND expires_at > now()
       FOR UPDATE
     ), persisted AS (
       INSERT INTO mcp_servers
         (id, org_id, label, server_url, auth_header_encrypted, auth_encryption_slot_id, allowed_tools,
          approved_manifest, approved_catalog_hash, approved_at)
       SELECT $4,$2,$5,$6,$7,$1::uuid,$8,$9::jsonb,$10,now() FROM claimed
       ON CONFLICT (id) DO UPDATE
       SET label = EXCLUDED.label,
           auth_header_encrypted = EXCLUDED.auth_header_encrypted,
           auth_encryption_slot_id = EXCLUDED.auth_encryption_slot_id,
           allowed_tools = EXCLUDED.allowed_tools,
           approved_manifest = EXCLUDED.approved_manifest,
           approved_catalog_hash = EXCLUDED.approved_catalog_hash,
           approved_at = now()
       WHERE mcp_servers.org_id = EXCLUDED.org_id
         AND mcp_servers.server_url = EXCLUDED.server_url
       RETURNING 1
     ), completed AS (
       UPDATE hacc_private.credential_ingest_slots slots
       SET state = 'completed',
           completion_receipt = $11::jsonb,
           completion_submission_id = $12::uuid,
           completed_at = now(),
           claim_token = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL,
           last_error_code = NULL
       WHERE slots.slot_id = $1
         AND slots.org_id = $2
         AND slots.claim_token = $3
         AND EXISTS (SELECT 1 FROM persisted)
       RETURNING 1
     )
     SELECT 1 FROM completed`,
    [
      claim.slotId,
      claim.orgId,
      claim.claimToken,
      claim.sink.serverId,
      claim.sink.label,
      manifest.serverUrl,
      encrypted,
      manifest.allowedTools,
      JSON.stringify(manifest),
      manifest.catalogHash,
      JSON.stringify(receipt),
      submissionId,
    ]
  );
  return Boolean(rows[0]);
}

/**
 * Same-origin form finalizer. Plaintext is never persisted in a slot or returned.
 * The destination write and slot completion share one SQL statement/transaction;
 * retries after an indeterminate response observe the stored non-secret receipt.
 */
export async function finalizeCredentialIngestSlot(
  input: Readonly<{ orgId: string; slotId: string; submissionId: string; credential: string }>,
  dependencies: CredentialSlotDependencies = defaultSlotDependencies
): Promise<CredentialSlotFinalization> {
  requireOrgId(input.orgId);
  requireSlotId(input.slotId);
  requireSlotId(input.submissionId);
  if (!isValidCredentialValue(input.credential)) throw new CredentialVaultError("invalid_input");

  const claimed = await claimCredentialSlot(
    input.orgId,
    input.slotId,
    input.submissionId,
    dependencies
  );
  if ("status" in claimed) return claimed;
  try {
    let encrypted: string;
    try {
      encrypted = dependencies.encrypt(input.credential, {
        orgId: input.orgId,
        sinkKind: claimed.sink.kind,
        sinkId: claimed.sink.kind === "env_var" ? claimed.sink.name : claimed.sink.serverId,
        slotId: claimed.slotId,
      });
    } catch {
      throw new CredentialVaultError("sink_failed");
    }
    if (
      typeof encrypted !== "string"
      || encrypted.length === 0
      || Buffer.byteLength(encrypted, "utf8") > MAX_ENCRYPTED_CREDENTIAL_BYTES
    ) throw new CredentialVaultError("sink_failed");

    if (claimed.sink.kind === "env_var") {
      const receipt = Object.freeze({ kind: "env_var" as const, name: claimed.sink.name });
      const committed = await commitEnvSlot(
        claimed as ClaimedCredentialSlot & { sink: Extract<StoredCredentialSlotSink, { kind: "env_var" }> },
        encrypted,
        receipt,
        input.submissionId,
        dependencies
      );
      if (!committed) throw new CredentialVaultError("sink_failed");
      return Object.freeze({ status: "completed" as const, replayed: false, receipt });
    }

    const server: McpRegistryServer = {
      id: claimed.sink.serverId,
      org_id: claimed.orgId,
      label: claimed.sink.label,
      server_url: claimed.sink.serverUrl,
      auth_header_encrypted: encrypted,
      auth_encryption_slot_id: claimed.slotId,
      allowed_tools: claimed.sink.allowedTools,
    };
    const manifest = await dependencies.snapshotMcp(server);
    const receipt = Object.freeze({
      kind: "mcp_server" as const,
      id: server.id,
      namespace: remoteMcpNamespace(server.id),
      catalog_hash: manifest.catalogHash,
      tool_count: manifest.tools.length,
    });
    const committed = await commitMcpSlot(
      claimed as ClaimedCredentialSlot & { sink: Extract<StoredCredentialSlotSink, { kind: "mcp_server" }> },
      encrypted,
      receipt,
      manifest,
      input.submissionId,
      dependencies
    );
    if (!committed) throw new CredentialVaultError("sink_failed");
    return Object.freeze({ status: "completed" as const, replayed: false, receipt });
  } catch (error) {
    await abortCredentialSlotClaim(claimed, dependencies);
    if (error instanceof CredentialVaultError) throw error;
    throw new CredentialVaultError("sink_failed");
  }
}
