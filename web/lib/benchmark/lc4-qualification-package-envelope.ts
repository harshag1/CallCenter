import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";

/**
 * The v5 package has no hash cycle:
 *
 *  1. payload_root_sha256 commits to every immutable evidence file except the
 *     signed terminal and this self-excluded envelope;
 *  2. the independently signed terminal commits to that payload root; and
 *  3. this signed envelope commits to the terminal artifact identity, the
 *     payload root, every package file (including the terminal), and the
 *     replay/authority/count bindings.
 *
 * A caller must cryptographically verify the terminal in `verifyTerminal`.
 * Keeping that callback generic lets the envelope be used by later terminal
 * schemas without importing a runner and creating a dependency cycle.
 */

export const LC4_QUALIFICATION_PAYLOAD_MANIFEST_VERSION =
  "HACC-LC4-QUALIFICATION-PAYLOAD-MANIFEST-v5" as const;
export const LC4_QUALIFICATION_PACKAGE_ENVELOPE_VERSION =
  "HACC-LC4-QUALIFICATION-PACKAGE-ENVELOPE-v5" as const;
export const LC4_QUALIFICATION_PACKAGE_MAXIMUM_PROVIDER_SESSIONS = 6 as const;

const PAYLOAD_ROOT_DOMAIN =
  "harshas-amazing-call-center/lc4-qualification-payload-root/v5\n";
const ENVELOPE_SIGNING_DOMAIN =
  "harshas-amazing-call-center/lc4-qualification-package-envelope-signature/v5\n";
const ENVELOPE_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4-qualification-package-envelope-artifact/v5\n";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SAFE_PACKAGE_PATH = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u;

const ENTRY_KEYS = Object.freeze(["byte_length", "path", "sha256"].sort());
const PAYLOAD_MANIFEST_KEYS = Object.freeze([
  "entries",
  "excluded_paths",
  "manifest_version",
  "payload_root_sha256",
  "schema_version",
].sort());
const BINDING_KEYS = Object.freeze([
  "attempt_id",
  "authorization_artifact_sha256",
  "budget_evidence_sha256",
  "budget_final_head_sha256",
  "generation_phase_count",
  "paid_session_count",
  "plan_artifact_sha256",
  "plan_sha256",
  "provider_session_count",
  "reconnect_count",
  "replay_artifact_sha256",
  "replay_chain_head_sha256",
  "replay_event_count",
  "retry_count",
  "setup_qualification_artifact_sha256",
  "source_commit",
  "source_tree_oid",
  "source_tree_sha256",
  "tool_roundtrip_count",
].sort());
const ENVELOPE_BODY_KEYS = Object.freeze([
  "bindings",
  "entries",
  "envelope_path",
  "envelope_version",
  "payload_manifest",
  "payload_root_sha256",
  "schema_version",
  "self_excluded",
  "terminal_artifact_sha256",
  "terminal_path",
].sort());
const SIGNED_ENVELOPE_KEYS = Object.freeze([
  "artifact_sha256",
  "authority_public_key_fingerprint_sha256",
  "authority_public_key_spki_base64",
  "body",
  "signature_algorithm",
  "signature_base64",
].sort());

export type Lc4QualificationPackageFile = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export type Lc4QualificationPackageEntryV5 = Readonly<{
  path: string;
  byte_length: number;
  sha256: string;
}>;

export type Lc4QualificationPayloadManifestV5 = Readonly<{
  schema_version: 1;
  manifest_version: typeof LC4_QUALIFICATION_PAYLOAD_MANIFEST_VERSION;
  excluded_paths: readonly [string, string];
  entries: readonly Lc4QualificationPackageEntryV5[];
  payload_root_sha256: string;
}>;

export type Lc4QualificationPackageBindingsV5 = Readonly<{
  attempt_id: string;
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  authorization_artifact_sha256: string;
  setup_qualification_artifact_sha256: string;
  budget_evidence_sha256: string;
  budget_final_head_sha256: string;
  provider_session_count: number;
  paid_session_count: number;
  generation_phase_count: number;
  tool_roundtrip_count: number;
  retry_count: number;
  reconnect_count: number;
  replay_artifact_sha256: string;
  replay_event_count: number;
  replay_chain_head_sha256: string | null;
}>;

export type Lc4QualificationTerminalClaimsV5 = Readonly<{
  terminal_artifact_sha256: string;
  payload_root_sha256: string;
  bindings: Lc4QualificationPackageBindingsV5;
}>;

export type Lc4QualificationPackageEnvelopeBodyV5 = Readonly<{
  schema_version: 1;
  envelope_version: typeof LC4_QUALIFICATION_PACKAGE_ENVELOPE_VERSION;
  self_excluded: true;
  envelope_path: string;
  terminal_path: string;
  payload_manifest: Lc4QualificationPayloadManifestV5;
  payload_root_sha256: string;
  terminal_artifact_sha256: string;
  entries: readonly Lc4QualificationPackageEntryV5[];
  bindings: Lc4QualificationPackageBindingsV5;
}>;

export type SignedLc4QualificationPackageEnvelopeV5 = Readonly<{
  body: Lc4QualificationPackageEnvelopeBodyV5;
  authority_public_key_spki_base64: string;
  authority_public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export type Lc4QualificationTerminalVerifierV5 = (
  terminalBytes: Uint8Array,
  terminalPath: string,
) => Lc4QualificationTerminalClaimsV5 | Promise<Lc4QualificationTerminalClaimsV5>;

function hasExactlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertCount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertPackagePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_PACKAGE_PATH.test(value)) {
    throw new Error(`${label} must be a canonical package basename`);
  }
  if (/\.(?:pem|env)$/u.test(value) || /(?:^|[-_.])signing[-_.]?key(?:$|[-_.])/u.test(value)) {
    throw new Error(`${label} is a forbidden package path`);
  }
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function assertBindings(value: unknown): asserts value is Lc4QualificationPackageBindingsV5 {
  assertRecord(value, "qualification package bindings");
  if (!hasExactlyKeys(value, BINDING_KEYS)) {
    throw new Error("qualification package bindings have unknown or missing fields");
  }
  if (typeof value.attempt_id !== "string" || !SAFE_ID.test(value.attempt_id)) {
    throw new Error("qualification package attempt_id is invalid");
  }
  if (typeof value.source_commit !== "string" || !GIT_OBJECT_ID.test(value.source_commit)) {
    throw new Error("qualification package source_commit is invalid");
  }
  if (typeof value.source_tree_oid !== "string" || !GIT_OBJECT_ID.test(value.source_tree_oid)) {
    throw new Error("qualification package source_tree_oid is invalid");
  }
  for (const key of [
    "source_tree_sha256",
    "plan_artifact_sha256",
    "plan_sha256",
    "authorization_artifact_sha256",
    "setup_qualification_artifact_sha256",
    "budget_evidence_sha256",
    "budget_final_head_sha256",
    "replay_artifact_sha256",
  ] as const) assertSha(value[key], `qualification package ${key}`);
  for (const key of [
    "provider_session_count",
    "paid_session_count",
    "generation_phase_count",
    "tool_roundtrip_count",
    "retry_count",
    "reconnect_count",
    "replay_event_count",
  ] as const) assertCount(value[key], `qualification package ${key}`);
  if (value.replay_chain_head_sha256 !== null) {
    assertSha(value.replay_chain_head_sha256, "qualification package replay_chain_head_sha256");
  }
  const checked = value as unknown as Lc4QualificationPackageBindingsV5;
  if (checked.provider_session_count > LC4_QUALIFICATION_PACKAGE_MAXIMUM_PROVIDER_SESSIONS) {
    throw new Error("qualification package declares a seventh provider session");
  }
  if (checked.paid_session_count > checked.provider_session_count) {
    throw new Error("qualification package paid sessions exceed provider sessions");
  }
  if (checked.retry_count !== 0) {
    throw new Error("qualification package declares a retry");
  }
  if (checked.reconnect_count !== 0) {
    throw new Error("qualification package declares a reconnect");
  }
  if ((checked.replay_event_count === 0) !== (checked.replay_chain_head_sha256 === null)) {
    throw new Error("qualification package replay count and chain head disagree");
  }
}

function entryFor(file: Lc4QualificationPackageFile): Lc4QualificationPackageEntryV5 {
  assertPackagePath(file.path, "qualification package file path");
  if (!(file.bytes instanceof Uint8Array)) {
    throw new Error(`qualification package file ${file.path} is not bytes`);
  }
  return freeze({
    path: file.path,
    byte_length: file.bytes.byteLength,
    sha256: sha256Hex(file.bytes),
  });
}

function sortedUniqueFiles(files: readonly Lc4QualificationPackageFile[]): readonly Lc4QualificationPackageFile[] {
  const copied = files.map((file) => ({ path: file.path, bytes: file.bytes }));
  copied.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (let index = 0; index < copied.length; index += 1) {
    assertPackagePath(copied[index]!.path, "qualification package file path");
    if (index > 0 && copied[index - 1]!.path === copied[index]!.path) {
      throw new Error(`qualification package contains duplicate path ${copied[index]!.path}`);
    }
  }
  return freeze(copied);
}

function payloadManifestBody(input: Readonly<{
  excluded_paths: readonly [string, string];
  entries: readonly Lc4QualificationPackageEntryV5[];
}>): Omit<Lc4QualificationPayloadManifestV5, "payload_root_sha256"> {
  return freeze({
    schema_version: 1 as const,
    manifest_version: LC4_QUALIFICATION_PAYLOAD_MANIFEST_VERSION,
    excluded_paths: input.excluded_paths,
    entries: input.entries,
  });
}

export function createLc4QualificationPayloadManifestV5(input: Readonly<{
  files: readonly Lc4QualificationPackageFile[];
  terminalPath: string;
  envelopePath: string;
}>): Lc4QualificationPayloadManifestV5 {
  assertPackagePath(input.terminalPath, "qualification terminal path");
  assertPackagePath(input.envelopePath, "qualification envelope path");
  if (input.terminalPath === input.envelopePath) {
    throw new Error("qualification terminal and envelope paths must differ");
  }
  const files = sortedUniqueFiles(input.files);
  if (!files.some((file) => file.path === input.terminalPath)) {
    throw new Error("qualification package is missing its terminal");
  }
  if (files.some((file) => file.path === input.envelopePath)) {
    throw new Error("qualification envelope must be self-excluded while signing");
  }
  const entries = freeze(files
    .filter((file) => file.path !== input.terminalPath && file.path !== input.envelopePath)
    .map(entryFor));
  if (entries.length === 0) {
    throw new Error("qualification payload must contain immutable evidence");
  }
  const excludedPaths: readonly [string, string] = freeze(input.envelopePath < input.terminalPath
    ? [input.envelopePath, input.terminalPath]
    : [input.terminalPath, input.envelopePath]);
  const body = payloadManifestBody({ excluded_paths: excludedPaths, entries });
  return freeze({
    ...body,
    payload_root_sha256: sha256Hex(`${PAYLOAD_ROOT_DOMAIN}${canonicalJson(body)}`),
  });
}

function assertEntry(value: unknown, label: string): asserts value is Lc4QualificationPackageEntryV5 {
  assertRecord(value, label);
  if (!hasExactlyKeys(value, ENTRY_KEYS)) throw new Error(`${label} has unknown or missing fields`);
  assertPackagePath(value.path, `${label}.path`);
  assertCount(value.byte_length, `${label}.byte_length`);
  assertSha(value.sha256, `${label}.sha256`);
}

function assertSortedEntries(entries: unknown, label: string): asserts entries is readonly Lc4QualificationPackageEntryV5[] {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array`);
  for (let index = 0; index < entries.length; index += 1) {
    assertEntry(entries[index], `${label}[${index}]`);
    if (index > 0 && entries[index - 1]!.path >= entries[index]!.path) {
      throw new Error(`${label} must be strictly sorted with unique paths`);
    }
  }
}

function assertPayloadManifest(value: unknown): asserts value is Lc4QualificationPayloadManifestV5 {
  assertRecord(value, "qualification payload manifest");
  if (!hasExactlyKeys(value, PAYLOAD_MANIFEST_KEYS)
    || value.schema_version !== 1
    || value.manifest_version !== LC4_QUALIFICATION_PAYLOAD_MANIFEST_VERSION) {
    throw new Error("qualification payload manifest schema is invalid");
  }
  if (!Array.isArray(value.excluded_paths)
    || value.excluded_paths.length !== 2
    || typeof value.excluded_paths[0] !== "string"
    || typeof value.excluded_paths[1] !== "string"
    || value.excluded_paths[0] >= value.excluded_paths[1]) {
    throw new Error("qualification payload manifest exclusions are invalid or unsorted");
  }
  assertPackagePath(value.excluded_paths[0], "qualification payload exclusion");
  assertPackagePath(value.excluded_paths[1], "qualification payload exclusion");
  assertSortedEntries(value.entries, "qualification payload manifest entries");
  assertSha(value.payload_root_sha256, "qualification payload root");
  const { payload_root_sha256, ...body } = value as unknown as Lc4QualificationPayloadManifestV5;
  if (payload_root_sha256 !== sha256Hex(`${PAYLOAD_ROOT_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("qualification payload manifest root failed integrity");
  }
}

function signedEnvelopeBody(input: Readonly<{
  files: readonly Lc4QualificationPackageFile[];
  terminalClaims: Lc4QualificationTerminalClaimsV5;
  terminalPath: string;
  envelopePath: string;
}>): Lc4QualificationPackageEnvelopeBodyV5 {
  assertBindings(input.terminalClaims.bindings);
  assertSha(input.terminalClaims.terminal_artifact_sha256, "qualification terminal artifact hash");
  assertSha(input.terminalClaims.payload_root_sha256, "qualification terminal payload root");
  const files = sortedUniqueFiles(input.files);
  const payloadManifest = createLc4QualificationPayloadManifestV5({
    files,
    terminalPath: input.terminalPath,
    envelopePath: input.envelopePath,
  });
  if (input.terminalClaims.payload_root_sha256 !== payloadManifest.payload_root_sha256) {
    throw new Error("signed qualification terminal does not bind the package payload root");
  }
  const entries = freeze(files.map(entryFor));
  return freeze({
    schema_version: 1 as const,
    envelope_version: LC4_QUALIFICATION_PACKAGE_ENVELOPE_VERSION,
    self_excluded: true as const,
    envelope_path: input.envelopePath,
    terminal_path: input.terminalPath,
    payload_manifest: payloadManifest,
    payload_root_sha256: payloadManifest.payload_root_sha256,
    terminal_artifact_sha256: input.terminalClaims.terminal_artifact_sha256,
    entries,
    bindings: freeze({ ...input.terminalClaims.bindings }),
  });
}

export function createSignedLc4QualificationPackageEnvelopeV5(input: Readonly<{
  files: readonly Lc4QualificationPackageFile[];
  terminalClaims: Lc4QualificationTerminalClaimsV5;
  terminalPath: string;
  envelopePath: string;
  authorityPrivateKeyPem: string;
}>): SignedLc4QualificationPackageEnvelopeV5 {
  const body = signedEnvelopeBody(input);
  const privateKey = createPrivateKey(input.authorityPrivateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("qualification package envelope requires an Ed25519 private key");
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const authorityPublicKeySpkiBase64 = publicKeyDer.toString("base64");
  const authorityFingerprint = sha256Hex(publicKeyDer);
  const signatureBase64 = sign(
    null,
    Buffer.from(`${ENVELOPE_SIGNING_DOMAIN}${canonicalJson(body)}`),
    privateKey,
  ).toString("base64");
  const withoutHash = freeze({
    body,
    authority_public_key_spki_base64: authorityPublicKeySpkiBase64,
    authority_public_key_fingerprint_sha256: authorityFingerprint,
    signature_algorithm: "Ed25519" as const,
    signature_base64: signatureBase64,
  });
  return freeze({
    ...withoutHash,
    artifact_sha256: sha256Hex(`${ENVELOPE_ARTIFACT_DOMAIN}${canonicalJson(withoutHash)}`),
  });
}

function assertEnvelopeStructure(value: unknown): asserts value is SignedLc4QualificationPackageEnvelopeV5 {
  assertRecord(value, "qualification package envelope");
  if (!hasExactlyKeys(value, SIGNED_ENVELOPE_KEYS)) {
    throw new Error("qualification package envelope has unknown or missing fields");
  }
  assertRecord(value.body, "qualification package envelope body");
  if (!hasExactlyKeys(value.body, ENVELOPE_BODY_KEYS)
    || value.body.schema_version !== 1
    || value.body.envelope_version !== LC4_QUALIFICATION_PACKAGE_ENVELOPE_VERSION
    || value.body.self_excluded !== true) {
    throw new Error("qualification package envelope schema is invalid");
  }
  assertPackagePath(value.body.envelope_path, "qualification envelope path");
  assertPackagePath(value.body.terminal_path, "qualification terminal path");
  if (value.body.envelope_path === value.body.terminal_path) {
    throw new Error("qualification terminal and envelope paths must differ");
  }
  assertPayloadManifest(value.body.payload_manifest);
  assertSha(value.body.payload_root_sha256, "qualification envelope payload root");
  assertSha(value.body.terminal_artifact_sha256, "qualification envelope terminal artifact hash");
  assertSortedEntries(value.body.entries, "qualification package envelope entries");
  assertBindings(value.body.bindings);
  if (typeof value.authority_public_key_spki_base64 !== "string"
    || typeof value.signature_base64 !== "string"
    || value.signature_algorithm !== "Ed25519") {
    throw new Error("qualification package envelope signature fields are invalid");
  }
  assertSha(value.authority_public_key_fingerprint_sha256, "qualification envelope authority fingerprint");
  assertSha(value.artifact_sha256, "qualification envelope artifact hash");
}

/**
 * Revalidates the signed envelope itself without claiming that its referenced
 * payload files were reopened. Callers projecting already-verified package
 * evidence can use this to prevent a later, fully rehashed receipt from
 * substituting its package authority or bindings.
 */
export function assertSignedLc4QualificationPackageEnvelopeV5Identity(input: Readonly<{
  envelope: unknown;
  expectedAuthorityFingerprintSha256?: string;
}>): SignedLc4QualificationPackageEnvelopeV5 {
  assertEnvelopeStructure(input.envelope);
  const envelope = input.envelope;
  const { artifact_sha256, ...withoutHash } = envelope;
  if (artifact_sha256 !== sha256Hex(`${ENVELOPE_ARTIFACT_DOMAIN}${canonicalJson(withoutHash)}`)) {
    throw new Error("qualification package envelope artifact hash failed integrity");
  }
  const publicKeyDer = Buffer.from(envelope.authority_public_key_spki_base64, "base64");
  if (sha256Hex(publicKeyDer) !== envelope.authority_public_key_fingerprint_sha256) {
    throw new Error("qualification package envelope authority identity failed integrity");
  }
  if (input.expectedAuthorityFingerprintSha256 !== undefined
    && input.expectedAuthorityFingerprintSha256 !== envelope.authority_public_key_fingerprint_sha256) {
    throw new Error("qualification package envelope authority is not trusted");
  }
  const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !verify(
      null,
      Buffer.from(`${ENVELOPE_SIGNING_DOMAIN}${canonicalJson(envelope.body)}`),
      publicKey,
      Buffer.from(envelope.signature_base64, "base64"),
    )) {
    throw new Error("qualification package envelope signature failed integrity");
  }
  return envelope;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function verifySignedLc4QualificationPackageEnvelopeV5(input: Readonly<{
  envelope: unknown;
  files: readonly Lc4QualificationPackageFile[];
  expectedAuthorityFingerprintSha256?: string;
  verifyTerminal: Lc4QualificationTerminalVerifierV5;
}>): Promise<SignedLc4QualificationPackageEnvelopeV5> {
  const envelope = assertSignedLc4QualificationPackageEnvelopeV5Identity({
    envelope: input.envelope,
    expectedAuthorityFingerprintSha256: input.expectedAuthorityFingerprintSha256,
  });

  const files = sortedUniqueFiles(input.files);
  if (files.some((file) => file.path === envelope.body.envelope_path)) {
    throw new Error("qualification package file list must self-exclude the envelope");
  }
  const actualEntries = files.map(entryFor);
  if (!sameJson(actualEntries, envelope.body.entries)) {
    throw new Error("qualification package has unknown, missing, unsorted, or mutated files");
  }
  if (envelope.body.entries.some((entry) => entry.path === envelope.body.envelope_path)
    || !envelope.body.entries.some((entry) => entry.path === envelope.body.terminal_path)) {
    throw new Error("qualification package envelope exclusion or terminal membership is invalid");
  }
  const expectedExclusions = [envelope.body.envelope_path, envelope.body.terminal_path].sort();
  if (!sameJson(envelope.body.payload_manifest.excluded_paths, expectedExclusions)) {
    throw new Error("qualification payload exclusions are not bound to the envelope paths");
  }
  const payloadEntries = actualEntries.filter((entry) =>
    entry.path !== envelope.body.terminal_path && entry.path !== envelope.body.envelope_path);
  if (!sameJson(payloadEntries, envelope.body.payload_manifest.entries)
    || envelope.body.payload_root_sha256 !== envelope.body.payload_manifest.payload_root_sha256) {
    throw new Error("qualification payload manifest differs from the retained evidence");
  }

  const terminalFile = files.find((file) => file.path === envelope.body.terminal_path);
  if (!terminalFile) throw new Error("qualification package is missing its terminal");
  const terminalClaims = await input.verifyTerminal(terminalFile.bytes, terminalFile.path);
  assertSha(terminalClaims.terminal_artifact_sha256, "verified qualification terminal artifact hash");
  assertSha(terminalClaims.payload_root_sha256, "verified qualification terminal payload root");
  assertBindings(terminalClaims.bindings);
  if (terminalClaims.terminal_artifact_sha256 !== envelope.body.terminal_artifact_sha256
    || terminalClaims.payload_root_sha256 !== envelope.body.payload_root_sha256
    || !sameJson(terminalClaims.bindings, envelope.body.bindings)) {
    throw new Error("qualification package contains a cross-run or mismatched signed terminal");
  }
  return envelope;
}

/** Read a flat, immutable package directory while rejecting links and folders. */
export async function readLc4QualificationPackageDirectoryV5(input: Readonly<{
  directory: string;
  envelopePath: string;
}>): Promise<Readonly<{
  envelope: unknown;
  files: readonly Lc4QualificationPackageFile[];
}>> {
  assertPackagePath(input.envelopePath, "qualification envelope path");
  const names = (await readdir(input.directory)).sort();
  if (!names.includes(input.envelopePath)) {
    throw new Error("qualification package directory is missing its envelope");
  }
  const files: Lc4QualificationPackageFile[] = [];
  let envelope: unknown;
  for (const name of names) {
    assertPackagePath(name, "qualification package directory entry");
    const path = resolve(input.directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("qualification package directory accepts only regular files");
    }
    const bytes = await readFile(path);
    if (name === input.envelopePath) {
      try {
        envelope = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new Error("qualification package envelope is not valid JSON");
      }
    } else {
      files.push(freeze({ path: name, bytes }));
    }
  }
  return freeze({ envelope, files: freeze(files) });
}
