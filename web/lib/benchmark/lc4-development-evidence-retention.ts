import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";

const SHA256 = /^[a-f0-9]{64}$/u;
const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-ledger-event/v1\n";
const LEDGER_REPLAY_DOMAIN = "harshas-amazing-call-center/lc4-dev-ledger-replay/v1\n";

export const LC4_DEV_REPLAY_EVIDENCE_VERSION = "lc4-dev-replay-evidence-v1" as const;

export type Lc4DevReplayArtifactKind =
  | "ledger_payload"
  | "caller_pcm"
  | "assistant_pcm"
  | "repair_pcm"
  | "control_authority"
  | "provider_exchange"
  | "listener_evidence"
  | "repair_decision"
  | "repair_playback"
  | "caller_branch_decision"
  | "authority_source_checkpoint"
  | "authority_obligation_manifest"
  | "authority_episode_artifact"
  | "opportunity_finalization"
  | "segment_finalization"
  | "episode_finalization"
  | "failure_evidence";

export type Lc4DevReplayArtifactReference = Readonly<{
  schema_version: 1;
  retention_version: typeof LC4_DEV_REPLAY_EVIDENCE_VERSION;
  kind: Lc4DevReplayArtifactKind;
  evidence_sha256: string;
  byte_length: number;
  content_encoding: "raw-bytes" | "canonical-json" | "domain-prefixed-canonical-json";
  domain_prefix: string;
}>;

export type Lc4DevReplayCasPort = Readonly<{
  put(
    bytes: Uint8Array,
    mediaType?: "audio/pcm" | "application/json" | "application/octet-stream",
  ): Promise<Readonly<{
    artifact_sha256: string;
    byte_length: number;
    receipt_sha256: string;
  }>>;
  get(artifactSha256: string): Promise<Uint8Array>;
}>;

export type Lc4DevReplayEvidenceStore = Readonly<{
  retainBytes(input: Readonly<{
    kind: Extract<Lc4DevReplayArtifactKind, "caller_pcm" | "assistant_pcm" | "repair_pcm">;
    bytes: Uint8Array;
    expected_evidence_sha256: string;
    media_type: "audio/pcm" | "application/octet-stream";
  }>): Promise<Lc4DevReplayArtifactReference>;
  retainJson(input: Readonly<{
    kind: Exclude<Lc4DevReplayArtifactKind, "caller_pcm" | "assistant_pcm" | "repair_pcm">;
    body: JsonValue;
    domain_prefix?: string;
    expected_evidence_sha256?: string;
  }>): Promise<Lc4DevReplayArtifactReference>;
  assertResolvable(reference: Lc4DevReplayArtifactReference): Promise<void>;
  resolveJson(reference: Lc4DevReplayArtifactReference): Promise<JsonValue>;
  /** Immutable process-local inventory. Every entry is still CAS-verified on use. */
  retainedReferences(kind?: Lc4DevReplayArtifactKind): readonly Lc4DevReplayArtifactReference[];
}>;

export type Lc4DevReplayLedgerEvent = Readonly<{
  sequence: number;
  observed_at: string;
  event_type: string;
  episode_id: string;
  opportunity_id: string | null;
  payload_sha256: string;
  payload_evidence: Lc4DevReplayArtifactReference;
  evidence_references: readonly Lc4DevReplayArtifactReference[];
  previous_event_sha256: string | null;
  event_sha256: string;
}>;

function requireHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function reference(input: Readonly<{
  kind: Lc4DevReplayArtifactKind;
  evidence_sha256: string;
  byte_length: number;
  content_encoding: Lc4DevReplayArtifactReference["content_encoding"];
  domain_prefix: string;
}>): Lc4DevReplayArtifactReference {
  requireHash(input.evidence_sha256, "LC4-DEV replay evidence hash");
  if (!Number.isSafeInteger(input.byte_length) || input.byte_length < 1) {
    throw new Error("LC4-DEV replay evidence must contain retained bytes");
  }
  return immutableJson({
    schema_version: 1,
    retention_version: LC4_DEV_REPLAY_EVIDENCE_VERSION,
    ...input,
  }) as unknown as Lc4DevReplayArtifactReference;
}

function assertReferenceShape(value: Lc4DevReplayArtifactReference): void {
  if (value.schema_version !== 1 || value.retention_version !== LC4_DEV_REPLAY_EVIDENCE_VERSION) {
    throw new Error("LC4-DEV replay evidence reference version is invalid");
  }
  requireHash(value.evidence_sha256, "LC4-DEV replay evidence hash");
  if (!Number.isSafeInteger(value.byte_length) || value.byte_length < 1) {
    throw new Error("LC4-DEV replay evidence reference has an invalid byte length");
  }
  if (value.content_encoding === "raw-bytes" && value.domain_prefix !== "") {
    throw new Error("LC4-DEV raw replay evidence cannot claim a JSON domain prefix");
  }
  if (value.content_encoding === "canonical-json" && value.domain_prefix !== "") {
    throw new Error("LC4-DEV canonical JSON replay evidence cannot claim a domain prefix");
  }
  if (value.content_encoding === "domain-prefixed-canonical-json" && value.domain_prefix.length === 0) {
    throw new Error("LC4-DEV domain-prefixed replay evidence is missing its domain");
  }
}

/**
 * Stores the exact SHA-256 preimage for every replay-visible evidence digest.
 * Domain-separated evidence is retained as `domain || canonical-json`, so the
 * digest written to the ledger is itself the CAS address. There is no mutable
 * side index whose loss could make a syntactically valid ledger non-replayable.
 */
export function createLc4DevReplayEvidenceStore(cas: Lc4DevReplayCasPort): Lc4DevReplayEvidenceStore {
  const retainedReferences: Lc4DevReplayArtifactReference[] = [];
  const assertResolvable = async (value: Lc4DevReplayArtifactReference): Promise<void> => {
    assertReferenceShape(value);
    const bytes = await cas.get(value.evidence_sha256);
    if (bytes.byteLength !== value.byte_length || sha256Hex(bytes) !== value.evidence_sha256) {
      throw new Error("LC4-DEV replay evidence is missing, truncated, or tampered");
    }
    if (value.content_encoding !== "raw-bytes") {
      const encoded = Buffer.from(bytes).toString("utf8");
      if (!encoded.startsWith(value.domain_prefix)) {
        throw new Error("LC4-DEV replay evidence domain prefix is invalid");
      }
      const json = encoded.slice(value.domain_prefix.length);
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(json) as JsonValue;
      } catch {
        throw new Error("LC4-DEV replay evidence JSON cannot be parsed");
      }
      if (canonicalJson(parsed) !== json) throw new Error("LC4-DEV replay evidence JSON is not canonical");
    }
  };

  return Object.freeze({
    retainBytes: async ({ kind, bytes: inputBytes, expected_evidence_sha256, media_type }) => {
      requireHash(expected_evidence_sha256, "LC4-DEV expected byte evidence hash");
      if (!(inputBytes instanceof Uint8Array) || inputBytes.byteLength < 1) {
        throw new Error("LC4-DEV replay byte evidence is empty or malformed");
      }
      const bytes = Uint8Array.from(inputBytes);
      if (sha256Hex(bytes) !== expected_evidence_sha256) {
        throw new Error("LC4-DEV replay byte evidence differs from its claimed hash");
      }
      const receipt = await cas.put(bytes, media_type);
      if (receipt.artifact_sha256 !== expected_evidence_sha256 || receipt.byte_length !== bytes.byteLength) {
        throw new Error("LC4-DEV CAS did not retain the exact replay byte evidence");
      }
      const retained = reference({
        kind,
        evidence_sha256: expected_evidence_sha256,
        byte_length: bytes.byteLength,
        content_encoding: "raw-bytes",
        domain_prefix: "",
      });
      await assertResolvable(retained);
      retainedReferences.push(retained);
      return retained;
    },
    retainJson: async ({ kind, body: inputBody, domain_prefix = "", expected_evidence_sha256 }) => {
      const body = immutableJson(inputBody) as JsonValue;
      const encoded = `${domain_prefix}${canonicalJson(body)}`;
      const bytes = Buffer.from(encoded, "utf8");
      const evidenceSha256 = sha256Hex(bytes);
      if (expected_evidence_sha256 !== undefined) {
        requireHash(expected_evidence_sha256, "LC4-DEV expected JSON evidence hash");
        if (evidenceSha256 !== expected_evidence_sha256) {
          throw new Error("LC4-DEV replay JSON evidence differs from its claimed domain hash");
        }
      }
      const receipt = await cas.put(bytes, domain_prefix === "" ? "application/json" : "application/octet-stream");
      if (receipt.artifact_sha256 !== evidenceSha256 || receipt.byte_length !== bytes.byteLength) {
        throw new Error("LC4-DEV CAS did not retain the exact replay JSON evidence");
      }
      const retained = reference({
        kind,
        evidence_sha256: evidenceSha256,
        byte_length: bytes.byteLength,
        content_encoding: domain_prefix === "" ? "canonical-json" : "domain-prefixed-canonical-json",
        domain_prefix,
      });
      await assertResolvable(retained);
      retainedReferences.push(retained);
      return retained;
    },
    assertResolvable,
    resolveJson: async (value) => {
      await assertResolvable(value);
      if (value.content_encoding === "raw-bytes") throw new Error("LC4-DEV raw replay evidence is not JSON");
      const bytes = await cas.get(value.evidence_sha256);
      return immutableJson(JSON.parse(Buffer.from(bytes).toString("utf8").slice(value.domain_prefix.length))) as JsonValue;
    },
    retainedReferences: (kind) => Object.freeze(retainedReferences
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => immutableJson(entry) as unknown as Lc4DevReplayArtifactReference)),
  });
}

/**
 * Independently replays ledger structure and resolves every evidence edge from
 * retained bytes. This intentionally accepts only the public ledger shape and
 * a CAS reader; it does not trust the live runner's counters or in-memory map.
 */
export async function verifyLc4DevReplayLedger(
  events: readonly Lc4DevReplayLedgerEvent[],
  evidence: Pick<Lc4DevReplayEvidenceStore, "assertResolvable" | "resolveJson">,
): Promise<Readonly<{
  event_count: number;
  evidence_reference_count: number;
  ledger_head_sha256: string;
  replay_sha256: string;
}>> {
  if (events.length < 1) throw new Error("LC4-DEV replay ledger is empty");
  let previous: string | null = null;
  let evidenceReferenceCount = 0;
  const replayedPayloads: Array<Readonly<{ event_sha256: string; payload: JsonValue }>> = [];
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.previous_event_sha256 !== previous) {
      throw new Error("LC4-DEV replay ledger sequence or hash chain is invalid");
    }
    if (event.payload_sha256 !== event.payload_evidence.evidence_sha256) {
      throw new Error("LC4-DEV replay ledger payload is not directly CAS-addressable");
    }
    const { event_sha256: claimed, ...body } = event;
    if (claimed !== sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson(body)}`)) {
      throw new Error("LC4-DEV replay ledger event hash is invalid");
    }
    await evidence.assertResolvable(event.payload_evidence);
    const payload = await evidence.resolveJson(event.payload_evidence);
    for (const reference of event.evidence_references) {
      await evidence.assertResolvable(reference);
      evidenceReferenceCount += 1;
    }
    replayedPayloads.push(Object.freeze({ event_sha256: event.event_sha256, payload }));
    previous = event.event_sha256;
  }
  const body = Object.freeze({
    event_count: events.length,
    evidence_reference_count: evidenceReferenceCount,
    ledger_head_sha256: previous!,
    replayed_payload_set_sha256: sha256Hex(canonicalJson(replayedPayloads)),
  });
  return Object.freeze({ ...body, replay_sha256: sha256Hex(`${LEDGER_REPLAY_DOMAIN}${canonicalJson(body)}`) });
}
