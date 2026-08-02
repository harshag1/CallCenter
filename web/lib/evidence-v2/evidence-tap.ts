import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { canonicalJson, immutableJson, sha256Hex } from "./canonical";
import {
  EVIDENCE_CATEGORIES,
  type EvidenceBundleV2,
  type EvidenceCategoryRootV2,
  type EvidenceCategoryV2,
  type EvidenceEventTypeV2,
  type EvidenceEventV2,
  type EvidenceManifestV2,
  type EvidencePayloadByTypeV2,
  type EvidenceSignerV2,
  type TerminalJournalPayload,
} from "./types";
import { eventCategory, safeId, timestamp, validatePayload } from "./validation";

const EVENT_DOMAIN = "hacc/evidence-v2/event/v2\n";
const CATEGORY_DOMAIN = "hacc/evidence-v2/category-root/v2\n";
const MANIFEST_DOMAIN = "hacc/evidence-v2/manifest/v2\n";
const SIGNATURE_DOMAIN = "hacc/evidence-v2/manifest-signature/v2\n";

export function publicKeyFingerprintV2(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  return sha256Hex(publicKey.export({ type: "spki", format: "der" }));
}

export function createEd25519EvidenceSignerV2(input: Readonly<{
  signerId: string;
  privateKeyPem: string;
}>): EvidenceSignerV2 {
  safeId(input.signerId, "signer ID");
  const privateKey = createPrivateKey(input.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("evidence signer must use Ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return Object.freeze({
    algorithm: "ed25519" as const,
    signer_id: input.signerId,
    public_key_pem: publicKeyPem,
    sign(payload: string): string {
      return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
    },
  });
}

function eventHash(event: Omit<EvidenceEventV2, "event_sha256">): string {
  return sha256Hex(`${EVENT_DOMAIN}${canonicalJson(event)}`);
}

function categoryRoot(category: EvidenceCategoryV2, events: readonly EvidenceEventV2[]): EvidenceCategoryRootV2 {
  const hashes = events.filter((event) => eventCategory(event.event_type) === category).map((event) => event.event_sha256);
  return Object.freeze({
    event_count: hashes.length,
    root_sha256: sha256Hex(`${CATEGORY_DOMAIN}${canonicalJson({ category, event_hashes: hashes })}`),
  });
}

type UnsignedManifest = Omit<EvidenceManifestV2, "manifest_root_sha256" | "signature">;

export function evidenceManifestRootV2(manifest: UnsignedManifest): string {
  return sha256Hex(`${MANIFEST_DOMAIN}${canonicalJson(manifest)}`);
}

export function serializeEvidenceBundleV2(bundle: EvidenceBundleV2): string {
  return `${canonicalJson(bundle)}\n`;
}

export class EvidenceTapV2 {
  private readonly events: EvidenceEventV2[] = [];
  private closed = false;

  constructor(private readonly options: Readonly<{
    runId: string;
    signer: EvidenceSignerV2;
    now?: () => Date;
  }>) {
    safeId(options.runId, "run ID");
    safeId(options.signer.signer_id, "signer ID");
    if (options.signer.algorithm !== "ed25519") throw new Error("evidence signer must use Ed25519");
    if (createPublicKey(options.signer.public_key_pem).asymmetricKeyType !== "ed25519") {
      throw new Error("evidence signer public key must use Ed25519");
    }
    publicKeyFingerprintV2(options.signer.public_key_pem);
  }

  append<T extends Exclude<EvidenceEventTypeV2, "journal.terminal">>(
    eventType: T,
    payloadInput: EvidencePayloadByTypeV2[T],
    observedAt = (this.options.now ?? (() => new Date()))().toISOString(),
  ): EvidenceEventV2<T> {
    if (this.closed) throw new Error("evidence tap is closed");
    timestamp(observedAt, "event timestamp");
    const payload = immutableJson(validatePayload(eventType, payloadInput)) as unknown as EvidencePayloadByTypeV2[T];
    const body = Object.freeze({
      schema_version: 2 as const,
      run_id: this.options.runId,
      sequence: this.events.length,
      observed_at: observedAt,
      event_type: eventType,
      payload,
      previous_event_sha256: this.events.at(-1)?.event_sha256 ?? null,
    });
    const event = Object.freeze({ ...body, event_sha256: eventHash(body as Omit<EvidenceEventV2, "event_sha256">) });
    this.events.push(event as EvidenceEventV2);
    return event as EvidenceEventV2<T>;
  }

  finalize(
    terminalInput: TerminalJournalPayload,
    observedAt = (this.options.now ?? (() => new Date()))().toISOString(),
  ): EvidenceBundleV2 {
    if (this.closed) throw new Error("evidence tap is closed");
    timestamp(observedAt, "terminal timestamp");
    const payload = immutableJson(validatePayload("journal.terminal", terminalInput)) as unknown as TerminalJournalPayload;
    const body = Object.freeze({
      schema_version: 2 as const,
      run_id: this.options.runId,
      sequence: this.events.length,
      observed_at: observedAt,
      event_type: "journal.terminal" as const,
      payload,
      previous_event_sha256: this.events.at(-1)?.event_sha256 ?? null,
    });
    this.events.push(Object.freeze({ ...body, event_sha256: eventHash(body) }) as EvidenceEventV2);
    this.closed = true;

    const categoryRoots = Object.fromEntries(EVIDENCE_CATEGORIES.map((category) => [
      category,
      categoryRoot(category, this.events),
    ])) as Record<EvidenceCategoryV2, EvidenceCategoryRootV2>;
    const unsigned: UnsignedManifest = Object.freeze({
      schema_version: 2,
      manifest_type: "hacc_evidence_manifest",
      run_id: this.options.runId,
      created_at: observedAt,
      event_count: this.events.length,
      event_chain_head_sha256: this.events.at(-1)!.event_sha256,
      category_roots: Object.freeze(categoryRoots),
      signer_id: this.options.signer.signer_id,
      signing_public_key_sha256: publicKeyFingerprintV2(this.options.signer.public_key_pem),
    });
    const manifestRoot = evidenceManifestRootV2(unsigned);
    const signatureBase64 = this.options.signer.sign(`${SIGNATURE_DOMAIN}${manifestRoot}`);
    const signatureBytes = Buffer.from(signatureBase64, "base64");
    if (signatureBytes.byteLength !== 64 || signatureBytes.toString("base64") !== signatureBase64) {
      throw new Error("evidence signer returned a noncanonical Ed25519 signature");
    }
    const manifest: EvidenceManifestV2 = Object.freeze({
      ...unsigned,
      manifest_root_sha256: manifestRoot,
      signature: Object.freeze({
        algorithm: "ed25519",
        signer_id: this.options.signer.signer_id,
        signature_base64: signatureBase64,
      }),
    });
    return Object.freeze({
      schema_version: 2,
      bundle_type: "hacc_evidence_bundle",
      run_id: this.options.runId,
      events: Object.freeze([...this.events]),
      terminal_manifest: manifest,
    });
  }
}

export const evidenceV2Domains = Object.freeze({ EVENT_DOMAIN, CATEGORY_DOMAIN, MANIFEST_DOMAIN, SIGNATURE_DOMAIN });
