import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertLc4QualificationV3Authorization,
  assertLc4QualificationV3PlanArtifact,
  type Lc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3PlanArtifact,
} from "./lc4-qualification-v3-runner";
import {
  assertLc4QualificationBudgetEvidence,
  lc4QualificationBudgetBindingSha256,
  type Lc4QualificationBudgetBinding,
  type Lc4QualificationBudgetEvidence,
} from "./lc4-qualification-budget";
import {
  createLc4QualificationPayloadManifestV5,
  createSignedLc4QualificationPackageEnvelopeV5,
  verifySignedLc4QualificationPackageEnvelopeV5,
  type Lc4QualificationPackageBindingsV5,
  type Lc4QualificationPackageFile,
  type Lc4QualificationTerminalClaimsV5,
  type SignedLc4QualificationPackageEnvelopeV5,
} from "./lc4-qualification-package-envelope";
import {
  assertLc4QualificationV4CompletedReplay,
  type Lc4QualificationV4Aggregate,
  type Lc4QualificationV4Binding,
  type Lc4QualificationV4Manifest,
  type Lc4QualificationV4ReplayShard,
} from "./lc4-qualification-v4-shards";

export const LC4_QUALIFICATION_V4_TERMINAL_VERSION =
  "HACC-LC4-QUALIFICATION-V4-TERMINAL-v1" as const;
const TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-terminal/v1\n";
const TERMINAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-terminal-artifact/v1\n";
const SETUP_AGGREGATE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-setup-aggregate/v1\n";
const REPLAY_AGGREGATE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-replay-aggregate/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;

type SignedArtifact<Body> = Readonly<{
  body: Body;
  authority_public_key_spki_base64: string;
  authority_public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export type Lc4QualificationV4TerminalBody = Readonly<{
  schema_version: 1;
  terminal_version: typeof LC4_QUALIFICATION_V4_TERMINAL_VERSION;
  attempt_id: string;
  sealed_at: string;
  status: "passed";
  binding: Lc4QualificationV4Binding;
  manifest_sha256: string;
  aggregate_sha256: string;
  ordered_shard_terminal_sha256: readonly string[];
  payload_root_sha256: string;
  package_bindings: Lc4QualificationPackageBindingsV5;
  budget_evidence_sha256: string;
  budget_binding_sha256: string;
  terminal_sha256: string;
}>;

export type Lc4QualificationV4TerminalArtifact = SignedArtifact<Lc4QualificationV4TerminalBody>;

export type Lc4QualificationV4SignedPackage = Readonly<{
  terminal: Lc4QualificationV4TerminalArtifact;
  envelope: SignedLc4QualificationPackageEnvelopeV5;
  files: readonly Lc4QualificationPackageFile[];
}>;

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function jsonFile(path: string, value: unknown): Lc4QualificationPackageFile {
  return freeze({ path, bytes: Buffer.from(`${canonicalJson(value)}\n`) });
}

function signedTerminal(body: Lc4QualificationV4TerminalBody, privateKeyPem: string): Lc4QualificationV4TerminalArtifact {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("qualification v4 terminal requires Ed25519");
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const withoutArtifact = freeze({
    body,
    authority_public_key_spki_base64: publicKey.toString("base64"),
    authority_public_key_fingerprint_sha256: sha256Hex(publicKey),
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(null, Buffer.from(`${TERMINAL_DOMAIN}${canonicalJson(body)}`), privateKey).toString("base64"),
  });
  return freeze({
    ...withoutArtifact,
    artifact_sha256: sha256Hex(`${TERMINAL_ARTIFACT_DOMAIN}${canonicalJson(withoutArtifact)}`),
  });
}

function assertSignedTerminal(
  artifact: Lc4QualificationV4TerminalArtifact,
  expectedFingerprint: string,
): void {
  const { artifact_sha256, ...withoutArtifact } = artifact;
  if (artifact.body.schema_version !== 1
    || artifact.body.terminal_version !== LC4_QUALIFICATION_V4_TERMINAL_VERSION
    || artifact.body.status !== "passed"
    || artifact.signature_algorithm !== "Ed25519"
    || artifact.authority_public_key_fingerprint_sha256 !== expectedFingerprint
    || sha256Hex(Buffer.from(artifact.authority_public_key_spki_base64, "base64")) !== expectedFingerprint
    || artifact_sha256 !== sha256Hex(`${TERMINAL_ARTIFACT_DOMAIN}${canonicalJson(withoutArtifact)}`)) {
    throw new Error("qualification v4 signed terminal failed identity or artifact integrity");
  }
  const { terminal_sha256, ...bodyWithoutHash } = artifact.body;
  if (terminal_sha256 !== sha256Hex(`${TERMINAL_DOMAIN}${canonicalJson(bodyWithoutHash)}`)) {
    throw new Error("qualification v4 terminal body hash failed integrity");
  }
  const publicKey = createPublicKey({
    key: Buffer.from(artifact.authority_public_key_spki_base64, "base64"),
    format: "der",
    type: "spki",
  });
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !verify(
      null,
      Buffer.from(`${TERMINAL_DOMAIN}${canonicalJson(artifact.body)}`),
      publicKey,
      Buffer.from(artifact.signature_base64, "base64"),
    )) throw new Error("qualification v4 terminal signature failed integrity");
}

function shardPrefix(index: number, provider: string): string {
  return `${String(index).padStart(2, "0")}-${provider}`;
}

function coreFiles(input: Readonly<{
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  budget: Lc4QualificationBudgetEvidence;
  manifest: Lc4QualificationV4Manifest;
  aggregate: Lc4QualificationV4Aggregate;
  shards: readonly Lc4QualificationV4ReplayShard[];
}>): readonly Lc4QualificationPackageFile[] {
  const files: Lc4QualificationPackageFile[] = [
    jsonFile("plan.json", input.plan),
    jsonFile("authorization.json", input.authorization),
    jsonFile("budget-settlement.json", input.budget),
    jsonFile("v4-manifest.json", input.manifest),
    jsonFile("v4-aggregate.json", input.aggregate),
  ];
  input.shards.forEach((shard, index) => {
    const prefix = shardPrefix(index, shard.reservation.provider);
    files.push(
      jsonFile(`${prefix}-reservation.json`, shard.reservation),
      jsonFile(`${prefix}-setup-admission.json`, shard.setup_admission),
      jsonFile(`${prefix}-setup-terminal.json`, shard.setup_terminal),
      jsonFile(`${prefix}-paid-admission.json`, shard.paid_admission),
      jsonFile(`${prefix}-paid-terminal.json`, shard.paid_terminal),
      jsonFile(`${prefix}-shard-terminal.json`, shard.shard_terminal),
    );
  });
  return freeze(files);
}

function exactFileSet(
  core: readonly Lc4QualificationPackageFile[],
  extras: readonly Lc4QualificationPackageFile[],
): readonly Lc4QualificationPackageFile[] {
  const files = [...core, ...extras].sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u.test(file.path)
      || file.path === "terminal.json"
      || file.path === "qualification-package-envelope.json"
      || (index > 0 && files[index - 1]!.path === file.path)) {
      throw new Error("qualification v4 package evidence paths are invalid, reserved, or duplicated");
    }
  }
  return freeze(files);
}

function packageBindings(input: Readonly<{
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  budget: Lc4QualificationBudgetEvidence;
  aggregate: Lc4QualificationV4Aggregate;
  shards: readonly Lc4QualificationV4ReplayShard[];
}>): Lc4QualificationPackageBindingsV5 {
  const setupEvidence = input.shards.map((shard) => shard.setup_terminal.result.evidence_sha256);
  const paidEvidence = input.shards.map((shard) => shard.paid_terminal.result.evidence_sha256);
  const heads = input.shards.flatMap((shard) => [
    shard.setup_terminal.result.wire_head_sha256,
    shard.paid_terminal.result.wire_head_sha256,
  ]);
  if (heads.some((head) => head === null)) throw new Error("passing v4 package has a missing replay chain head");
  return freeze({
    attempt_id: input.authorization.body.authorization_id,
    source_commit: input.plan.body.source.source_commit,
    source_tree_oid: input.plan.body.source.source_tree_oid,
    source_tree_sha256: input.plan.body.source.source_tree_sha256,
    plan_artifact_sha256: input.plan.artifact_sha256,
    plan_sha256: input.plan.body.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    setup_qualification_artifact_sha256: sha256Hex(`${SETUP_AGGREGATE_DOMAIN}${canonicalJson(setupEvidence)}`),
    budget_evidence_sha256: input.budget.evidence_sha256,
    budget_final_head_sha256: input.budget.final_head_sha256,
    provider_session_count: input.aggregate.provider_sessions_opened,
    paid_session_count: input.aggregate.paid_sessions_opened,
    generation_phase_count: input.aggregate.generation_phases_attempted,
    tool_roundtrip_count: input.aggregate.tool_roundtrips_attempted,
    retry_count: input.aggregate.paid_retries_attempted,
    reconnect_count: input.shards.reduce((sum, shard) => (
      sum + shard.setup_terminal.result.reconnect_count + shard.paid_terminal.result.reconnect_count
    ), 0),
    replay_artifact_sha256: sha256Hex(`${REPLAY_AGGREGATE_DOMAIN}${canonicalJson(paidEvidence)}`),
    replay_event_count: input.shards.reduce((sum, shard) => (
      sum + shard.setup_terminal.result.wire_observation_count
        + shard.paid_terminal.result.wire_observation_count
    ), 0),
    replay_chain_head_sha256: sha256Hex(`${REPLAY_AGGREGATE_DOMAIN}${canonicalJson(heads)}`),
  });
}

function assertCrossBindings(input: Readonly<{
  binding: Lc4QualificationV4Binding;
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  budget: Lc4QualificationBudgetEvidence;
  budgetBinding: Lc4QualificationBudgetBinding;
  terminalPrivateKeyFingerprint?: string;
}>): void {
  const binding = input.binding;
  if (binding.attempt_id !== input.authorization.body.authorization_id
    || binding.authorization_artifact_sha256 !== input.authorization.artifact_sha256
    || binding.authorization_maximum_total_micro_usd !== input.authorization.body.maximum_total_micro_usd
    || binding.plan_artifact_sha256 !== input.plan.artifact_sha256
    || binding.plan_sha256 !== input.plan.body.plan_sha256
    || binding.source_commit !== input.plan.body.source.source_commit
    || binding.source_tree_sha256 !== input.plan.body.source.source_tree_sha256
    || binding.credential_set_sha256 !== input.plan.body.credential_set_sha256
    || binding.provider_profile_manifest_sha256 !== input.plan.body.provider_profile_manifest_sha256
    || binding.setup_configuration_matrix_sha256 !== input.plan.body.setup_configuration_matrix_sha256
    || binding.paid_configuration_matrix_sha256 !== input.plan.body.paid_configuration_matrix_sha256
    || input.budget.binding_sha256 !== lc4QualificationBudgetBindingSha256(input.budgetBinding)
    || input.budget.reservation_id !== `lc4qv3:${binding.attempt_id}`
    || (input.terminalPrivateKeyFingerprint !== undefined
      && input.terminalPrivateKeyFingerprint !== input.authorization.body.terminal_public_key_fingerprint_sha256)) {
    throw new Error("qualification v4 source, authorization, credential, plan, or budget binding differs");
  }
}

export function createSignedLc4QualificationV4Package(input: Readonly<{
  binding: Lc4QualificationV4Binding;
  manifest: Lc4QualificationV4Manifest;
  aggregate: Lc4QualificationV4Aggregate;
  shards: readonly Lc4QualificationV4ReplayShard[];
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  budget: Lc4QualificationBudgetEvidence;
  budgetBinding: Lc4QualificationBudgetBinding;
  terminalPrivateKeyPem: string;
  sealedAt: string;
  evidenceFiles?: readonly Lc4QualificationPackageFile[];
}>): Lc4QualificationV4SignedPackage {
  assertLc4QualificationV4CompletedReplay(input);
  assertLc4QualificationBudgetEvidence(input.budget);
  const privateKey = createPrivateKey(input.terminalPrivateKeyPem);
  const terminalFingerprint = sha256Hex(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
  assertCrossBindings({ ...input, terminalPrivateKeyFingerprint: terminalFingerprint });
  if (new Date(input.sealedAt).toISOString() !== input.sealedAt) throw new Error("qualification v4 seal time is invalid");
  assertLc4QualificationV3Authorization({
    artifact: input.authorization,
    plan: input.plan,
    trustRootFingerprint: input.authorization.authority_public_key_fingerprint_sha256,
    now: new Date(input.sealedAt),
  });
  const bindings = packageBindings(input);
  const evidence = exactFileSet(coreFiles(input), input.evidenceFiles ?? []);
  const payload = createLc4QualificationPayloadManifestV5({
    files: freeze([...evidence, freeze({ path: "terminal.json", bytes: Buffer.from("pending") })]),
    terminalPath: "terminal.json",
    envelopePath: "qualification-package-envelope.json",
  });
  const terminalWithoutHash = freeze({
    schema_version: 1 as const,
    terminal_version: LC4_QUALIFICATION_V4_TERMINAL_VERSION,
    attempt_id: input.binding.attempt_id,
    sealed_at: input.sealedAt,
    status: "passed" as const,
    binding: input.binding,
    manifest_sha256: input.manifest.manifest_sha256,
    aggregate_sha256: input.aggregate.aggregate_sha256,
    ordered_shard_terminal_sha256: freeze(input.shards.map((shard) => shard.shard_terminal.terminal_sha256)),
    payload_root_sha256: payload.payload_root_sha256,
    package_bindings: bindings,
    budget_evidence_sha256: input.budget.evidence_sha256,
    budget_binding_sha256: input.budget.binding_sha256,
  });
  const terminalBody = freeze({
    ...terminalWithoutHash,
    terminal_sha256: sha256Hex(`${TERMINAL_DOMAIN}${canonicalJson(terminalWithoutHash)}`),
  });
  const terminal = signedTerminal(terminalBody, input.terminalPrivateKeyPem);
  const files = freeze([...evidence, jsonFile("terminal.json", terminal)]);
  const envelope = createSignedLc4QualificationPackageEnvelopeV5({
    files,
    terminalClaims: freeze({
      terminal_artifact_sha256: terminal.artifact_sha256,
      payload_root_sha256: terminal.body.payload_root_sha256,
      bindings: terminal.body.package_bindings,
    }),
    terminalPath: "terminal.json",
    envelopePath: "qualification-package-envelope.json",
    authorityPrivateKeyPem: input.terminalPrivateKeyPem,
  });
  return freeze({ terminal, envelope, files });
}

function parseJson<T>(file: Lc4QualificationPackageFile, label: string): T {
  try {
    return JSON.parse(Buffer.from(file.bytes).toString("utf8")) as T;
  } catch {
    throw new Error(`qualification v4 package ${label} is invalid JSON`);
  }
}

function fileMap(files: readonly Lc4QualificationPackageFile[]): Map<string, Lc4QualificationPackageFile> {
  const map = new Map<string, Lc4QualificationPackageFile>();
  for (const file of files) {
    if (map.has(file.path)) throw new Error("qualification v4 package contains duplicate files");
    map.set(file.path, file);
  }
  return map;
}

export async function verifySignedLc4QualificationV4Package(input: Readonly<{
  envelope: unknown;
  files: readonly Lc4QualificationPackageFile[];
  expectedTrustRootFingerprintSha256: string;
  expectedBinding: Lc4QualificationV4Binding;
  budgetBinding: Lc4QualificationBudgetBinding;
}>): Promise<Readonly<{
  terminal: Lc4QualificationV4TerminalArtifact;
  aggregate: Lc4QualificationV4Aggregate;
  package_manifest_sha256: string;
}>> {
  const files = fileMap(input.files);
  const required = (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error(`qualification v4 package is missing ${path}`);
    return file;
  };
  const terminal = parseJson<Lc4QualificationV4TerminalArtifact>(required("terminal.json"), "terminal");
  const plan = parseJson<Lc4QualificationV3PlanArtifact>(required("plan.json"), "plan");
  const authorization = parseJson<Lc4QualificationV3AuthorizationArtifact>(required("authorization.json"), "authorization");
  const budget = parseJson<Lc4QualificationBudgetEvidence>(required("budget-settlement.json"), "budget");
  const manifest = parseJson<Lc4QualificationV4Manifest>(required("v4-manifest.json"), "manifest");
  const aggregate = parseJson<Lc4QualificationV4Aggregate>(required("v4-aggregate.json"), "aggregate");
  assertLc4QualificationV3PlanArtifact(plan, input.expectedTrustRootFingerprintSha256);
  assertLc4QualificationV3Authorization({
    artifact: authorization,
    plan,
    trustRootFingerprint: input.expectedTrustRootFingerprintSha256,
    now: new Date(terminal.body.sealed_at),
  });
  assertLc4QualificationBudgetEvidence(budget);
  assertSignedTerminal(terminal, authorization.body.terminal_public_key_fingerprint_sha256);
  if (canonicalJson(terminal.body.binding) !== canonicalJson(input.expectedBinding)) {
    throw new Error("qualification v4 package terminal binding differs from expected source/auth/credentials");
  }
  assertCrossBindings({ binding: input.expectedBinding, plan, authorization, budget, budgetBinding: input.budgetBinding });
  const shards = manifest.reservations.map((reservation, index): Lc4QualificationV4ReplayShard => {
    const prefix = shardPrefix(index, reservation.provider);
    return freeze({
      reservation: parseJson(required(`${prefix}-reservation.json`), `${prefix} reservation`),
      setup_admission: parseJson(required(`${prefix}-setup-admission.json`), `${prefix} setup admission`),
      setup_terminal: parseJson(required(`${prefix}-setup-terminal.json`), `${prefix} setup terminal`),
      paid_admission: parseJson(required(`${prefix}-paid-admission.json`), `${prefix} paid admission`),
      paid_terminal: parseJson(required(`${prefix}-paid-terminal.json`), `${prefix} paid terminal`),
      shard_terminal: parseJson(required(`${prefix}-shard-terminal.json`), `${prefix} shard terminal`),
    });
  });
  assertLc4QualificationV4CompletedReplay({
    binding: input.expectedBinding,
    manifest,
    aggregate,
    shards,
  });
  const expectedBindings = packageBindings({ plan, authorization, budget, aggregate, shards });
  if (canonicalJson(terminal.body.package_bindings) !== canonicalJson(expectedBindings)
    || terminal.body.manifest_sha256 !== manifest.manifest_sha256
    || terminal.body.aggregate_sha256 !== aggregate.aggregate_sha256
    || canonicalJson(terminal.body.ordered_shard_terminal_sha256)
      !== canonicalJson(shards.map((shard) => shard.shard_terminal.terminal_sha256))) {
    throw new Error("qualification v4 terminal differs from replay-derived package bindings");
  }
  const packageManifest = await verifySignedLc4QualificationPackageEnvelopeV5({
    envelope: input.envelope,
    files: input.files,
    expectedAuthorityFingerprintSha256: authorization.body.terminal_public_key_fingerprint_sha256,
    verifyTerminal: (bytes): Lc4QualificationTerminalClaimsV5 => {
      const packaged = JSON.parse(Buffer.from(bytes).toString("utf8")) as Lc4QualificationV4TerminalArtifact;
      assertSignedTerminal(packaged, authorization.body.terminal_public_key_fingerprint_sha256);
      if (canonicalJson(packaged) !== canonicalJson(terminal)) {
        throw new Error("qualification v4 envelope terminal differs from retained terminal");
      }
      return freeze({
        terminal_artifact_sha256: packaged.artifact_sha256,
        payload_root_sha256: packaged.body.payload_root_sha256,
        bindings: packaged.body.package_bindings,
      });
    },
  });
  if (!SHA256.test(packageManifest.artifact_sha256)) {
    throw new Error("qualification v4 package manifest hash is invalid");
  }
  return freeze({ terminal, aggregate, package_manifest_sha256: packageManifest.artifact_sha256 });
}
