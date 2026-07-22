import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_QUALIFICATION_PACKAGE_ENVELOPE_VERSION,
  createLc4QualificationPayloadManifestV5,
  createSignedLc4QualificationPackageEnvelopeV5,
  readLc4QualificationPackageDirectoryV5,
  verifySignedLc4QualificationPackageEnvelopeV5,
  type Lc4QualificationPackageBindingsV5,
  type Lc4QualificationPackageFile,
  type Lc4QualificationTerminalClaimsV5,
  type SignedLc4QualificationPackageEnvelopeV5,
} from "../lc4-qualification-package-envelope";

const ENVELOPE_PATH = "qualification-package-envelope.json";
const TERMINAL_PATH = "terminal.json";
const TERMINAL_SIGNING_DOMAIN = "hacc/test/signed-terminal/v5\n";
const TERMINAL_ARTIFACT_DOMAIN = "hacc/test/signed-terminal-artifact/v5\n";
const ENVELOPE_SIGNING_DOMAIN =
  "harshas-amazing-call-center/lc4-qualification-package-envelope-signature/v5\n";
const ENVELOPE_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4-qualification-package-envelope-artifact/v5\n";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    privateKeyPem,
    publicKeySpkiBase64: publicKeyDer.toString("base64"),
    fingerprint: sha256Hex(publicKeyDer),
  });
}

const ENVELOPE_AUTHORITY = keyPair();
const TERMINAL_AUTHORITY = keyPair();

function hash(character: string): string {
  return character.repeat(64);
}

function bindings(overrides: Partial<Lc4QualificationPackageBindingsV5> = {}): Lc4QualificationPackageBindingsV5 {
  return Object.freeze({
    attempt_id: "qualification-attempt-001",
    source_commit: "a".repeat(40),
    source_tree_oid: "b".repeat(40),
    source_tree_sha256: hash("c"),
    plan_artifact_sha256: hash("d"),
    plan_sha256: hash("e"),
    authorization_artifact_sha256: hash("f"),
    setup_qualification_artifact_sha256: hash("1"),
    budget_evidence_sha256: hash("2"),
    budget_final_head_sha256: hash("3"),
    provider_session_count: 6,
    paid_session_count: 3,
    generation_phase_count: 6,
    tool_roundtrip_count: 3,
    retry_count: 0,
    reconnect_count: 0,
    replay_artifact_sha256: hash("4"),
    replay_event_count: 27,
    replay_chain_head_sha256: hash("5"),
    ...overrides,
  });
}

type TestTerminal = Readonly<{
  body: Readonly<{
    schema_version: 1;
    terminal_version: "TEST-HACC-LC4-TERMINAL-v5";
    payload_root_sha256: string;
    bindings: Lc4QualificationPackageBindingsV5;
  }>;
  public_key_spki_base64: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

function createTerminal(
  payloadRootSha256: string,
  terminalBindings: Lc4QualificationPackageBindingsV5,
): Readonly<{ bytes: Uint8Array; claims: Lc4QualificationTerminalClaimsV5 }> {
  const body = Object.freeze({
    schema_version: 1 as const,
    terminal_version: "TEST-HACC-LC4-TERMINAL-v5" as const,
    payload_root_sha256: payloadRootSha256,
    bindings: terminalBindings,
  });
  const signatureBase64 = sign(
    null,
    Buffer.from(`${TERMINAL_SIGNING_DOMAIN}${canonicalJson(body)}`),
    createPrivateKey(TERMINAL_AUTHORITY.privateKeyPem),
  ).toString("base64");
  const withoutHash = Object.freeze({
    body,
    public_key_spki_base64: TERMINAL_AUTHORITY.publicKeySpkiBase64,
    signature_algorithm: "Ed25519" as const,
    signature_base64: signatureBase64,
  });
  const terminal: TestTerminal = Object.freeze({
    ...withoutHash,
    artifact_sha256: sha256Hex(`${TERMINAL_ARTIFACT_DOMAIN}${canonicalJson(withoutHash)}`),
  });
  return Object.freeze({
    bytes: Buffer.from(canonicalJson(terminal)),
    claims: Object.freeze({
      terminal_artifact_sha256: terminal.artifact_sha256,
      payload_root_sha256: body.payload_root_sha256,
      bindings: body.bindings,
    }),
  });
}

function verifyTerminal(bytes: Uint8Array): Lc4QualificationTerminalClaimsV5 {
  const terminal = JSON.parse(Buffer.from(bytes).toString("utf8")) as TestTerminal;
  const { artifact_sha256, ...withoutHash } = terminal;
  if (artifact_sha256 !== sha256Hex(`${TERMINAL_ARTIFACT_DOMAIN}${canonicalJson(withoutHash)}`)) {
    throw new Error("test terminal artifact failed integrity");
  }
  const publicKey = createPublicKey({
    key: Buffer.from(terminal.public_key_spki_base64, "base64"),
    format: "der",
    type: "spki",
  });
  if (sha256Hex(Buffer.from(terminal.public_key_spki_base64, "base64")) !== TERMINAL_AUTHORITY.fingerprint
    || !verify(
      null,
      Buffer.from(`${TERMINAL_SIGNING_DOMAIN}${canonicalJson(terminal.body)}`),
      publicKey,
      Buffer.from(terminal.signature_base64, "base64"),
    )) throw new Error("test terminal signature failed integrity");
  return Object.freeze({
    terminal_artifact_sha256: terminal.artifact_sha256,
    payload_root_sha256: terminal.body.payload_root_sha256,
    bindings: terminal.body.bindings,
  });
}

function evidenceFiles(): readonly Lc4QualificationPackageFile[] {
  return Object.freeze([
    Object.freeze({ path: "setup-acceptance.json", bytes: Buffer.from("setup evidence") }),
    Object.freeze({ path: "replay.jsonl", bytes: Buffer.from("event one\nevent two\n") }),
    Object.freeze({ path: "budget-evidence.json", bytes: Buffer.from("budget evidence") }),
  ]);
}

function packageFixture(input: Readonly<{
  terminalBindings?: Lc4QualificationPackageBindingsV5;
  envelopeClaimsBindings?: Lc4QualificationPackageBindingsV5;
}> = {}) {
  const evidence = evidenceFiles();
  const placeholder = Object.freeze({ path: TERMINAL_PATH, bytes: Buffer.from("placeholder") });
  const payload = createLc4QualificationPayloadManifestV5({
    files: [...evidence, placeholder],
    terminalPath: TERMINAL_PATH,
    envelopePath: ENVELOPE_PATH,
  });
  const terminal = createTerminal(payload.payload_root_sha256, input.terminalBindings ?? bindings());
  const files = Object.freeze([
    evidence[1]!,
    Object.freeze({ path: TERMINAL_PATH, bytes: terminal.bytes }),
    evidence[2]!,
    evidence[0]!,
  ]);
  const envelopeClaims = input.envelopeClaimsBindings === undefined
    ? terminal.claims
    : Object.freeze({ ...terminal.claims, bindings: input.envelopeClaimsBindings });
  const envelope = createSignedLc4QualificationPackageEnvelopeV5({
    files,
    terminalClaims: envelopeClaims,
    terminalPath: TERMINAL_PATH,
    envelopePath: ENVELOPE_PATH,
    authorityPrivateKeyPem: ENVELOPE_AUTHORITY.privateKeyPem,
  });
  return Object.freeze({ files, envelope, terminal, payload });
}

function resignEnvelope(
  body: SignedLc4QualificationPackageEnvelopeV5["body"],
): SignedLc4QualificationPackageEnvelopeV5 {
  const privateKey = createPrivateKey(ENVELOPE_AUTHORITY.privateKeyPem);
  const signatureBase64 = sign(
    null,
    Buffer.from(`${ENVELOPE_SIGNING_DOMAIN}${canonicalJson(body)}`),
    privateKey,
  ).toString("base64");
  const withoutHash = Object.freeze({
    body,
    authority_public_key_spki_base64: ENVELOPE_AUTHORITY.publicKeySpkiBase64,
    authority_public_key_fingerprint_sha256: ENVELOPE_AUTHORITY.fingerprint,
    signature_algorithm: "Ed25519" as const,
    signature_base64: signatureBase64,
  });
  return Object.freeze({
    ...withoutHash,
    artifact_sha256: sha256Hex(`${ENVELOPE_ARTIFACT_DOMAIN}${canonicalJson(withoutHash)}`),
  });
}

describe("LC4 qualification signed package envelope v5", () => {
  it("verifies the no-cycle payload -> terminal -> envelope chain", async () => {
    const fixture = packageFixture();
    const verified = await verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: fixture.envelope,
      files: fixture.files,
      expectedAuthorityFingerprintSha256: ENVELOPE_AUTHORITY.fingerprint,
      verifyTerminal,
    });

    expect(verified.body.envelope_version).toBe(LC4_QUALIFICATION_PACKAGE_ENVELOPE_VERSION);
    expect(verified.body.payload_root_sha256).toBe(fixture.payload.payload_root_sha256);
    expect(verified.body.payload_manifest.entries.map((entry) => entry.path)).toEqual([
      "budget-evidence.json",
      "replay.jsonl",
      "setup-acceptance.json",
    ]);
    expect(verified.body.entries.map((entry) => entry.path)).toEqual([
      "budget-evidence.json",
      "replay.jsonl",
      "setup-acceptance.json",
      TERMINAL_PATH,
    ]);
  });

  it("rejects payload tamper even when an attacker rehashes the manifest, entries, and artifact", async () => {
    const fixture = packageFixture();
    const files = fixture.files.map((file) => file.path === "replay.jsonl"
      ? Object.freeze({ ...file, bytes: Buffer.from("attacker replacement replay\n") })
      : file);
    const payloadManifest = createLc4QualificationPayloadManifestV5({
      files,
      terminalPath: TERMINAL_PATH,
      envelopePath: ENVELOPE_PATH,
    });
    const entries = [...files]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      .map((file) => Object.freeze({
        path: file.path,
        byte_length: file.bytes.byteLength,
        sha256: sha256Hex(file.bytes),
      }));
    const forgedBody = Object.freeze({
      ...fixture.envelope.body,
      payload_manifest: payloadManifest,
      payload_root_sha256: payloadManifest.payload_root_sha256,
      entries: Object.freeze(entries),
    });
    const forgedWithoutHash = Object.freeze({ ...fixture.envelope, body: forgedBody });
    const forged = Object.freeze({
      ...forgedWithoutHash,
      artifact_sha256: sha256Hex(`${ENVELOPE_ARTIFACT_DOMAIN}${canonicalJson({
        body: forgedBody,
        authority_public_key_spki_base64: forgedWithoutHash.authority_public_key_spki_base64,
        authority_public_key_fingerprint_sha256: forgedWithoutHash.authority_public_key_fingerprint_sha256,
        signature_algorithm: forgedWithoutHash.signature_algorithm,
        signature_base64: forgedWithoutHash.signature_base64,
      })}`),
    });

    await expect(verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: forged,
      files,
      verifyTerminal,
    })).rejects.toThrow("signature failed integrity");
  });

  it.each([
    ["source", { source_commit: "9".repeat(40) }],
    ["tree", { source_tree_sha256: hash("8") }],
    ["plan", { plan_sha256: hash("7") }],
    ["authorization", { authorization_artifact_sha256: hash("6") }],
    ["setup", { setup_qualification_artifact_sha256: hash("7") }],
    ["budget", { budget_final_head_sha256: hash("8") }],
    ["session count", { paid_session_count: 2 }],
    ["replay hash", { replay_artifact_sha256: hash("9") }],
    ["replay count", { replay_event_count: 26 }],
  ])("rejects a cross-run terminal with a mismatched %s binding", async (_label, changed) => {
    const terminalBindings = bindings(changed as Partial<Lc4QualificationPackageBindingsV5>);
    const fixture = packageFixture({ terminalBindings, envelopeClaimsBindings: bindings() });
    await expect(verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: fixture.envelope,
      files: fixture.files,
      verifyTerminal,
    })).rejects.toThrow("cross-run or mismatched signed terminal");
  });

  it("rejects unknown, missing, and unsorted envelope entries", async () => {
    const fixture = packageFixture();
    const unknown = [...fixture.files, { path: "unknown.json", bytes: Buffer.from("unknown") }];
    const missing = fixture.files.filter((file) => file.path !== "replay.jsonl");
    await expect(verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: fixture.envelope,
      files: unknown,
      verifyTerminal,
    })).rejects.toThrow("unknown, missing, unsorted, or mutated files");
    await expect(verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: fixture.envelope,
      files: missing,
      verifyTerminal,
    })).rejects.toThrow("unknown, missing, unsorted, or mutated files");

    const unsortedBody = Object.freeze({
      ...fixture.envelope.body,
      entries: Object.freeze([...fixture.envelope.body.entries].reverse()),
    });
    await expect(verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: resignEnvelope(unsortedBody),
      files: fixture.files,
      verifyTerminal,
    })).rejects.toThrow("strictly sorted");
  });

  it("rejects seventh-session, retry, reconnect, and incoherent replay declarations", () => {
    const cases: Partial<Lc4QualificationPackageBindingsV5>[] = [
      { provider_session_count: 7 },
      { retry_count: 1 },
      { reconnect_count: 1 },
      { replay_event_count: 0 },
      { replay_chain_head_sha256: null },
    ];
    for (const changed of cases) {
      expect(() => packageFixture({ terminalBindings: bindings(changed) })).toThrow();
    }
  });

  it("rejects an envelope signed by an untrusted authority", async () => {
    const fixture = packageFixture();
    await expect(verifySignedLc4QualificationPackageEnvelopeV5({
      envelope: fixture.envelope,
      files: fixture.files,
      expectedAuthorityFingerprintSha256: hash("0"),
      verifyTerminal,
    })).rejects.toThrow("authority is not trusted");
  });

  it("reads only a flat package and rejects symbolic-link evidence", async () => {
    const fixture = packageFixture();
    const root = await mkdtemp(join(tmpdir(), "hacc-package-envelope-"));
    roots.push(root);
    for (const file of fixture.files) await writeFile(join(root, file.path), file.bytes);
    await writeFile(join(root, ENVELOPE_PATH), canonicalJson(fixture.envelope));
    const retained = await readLc4QualificationPackageDirectoryV5({
      directory: root,
      envelopePath: ENVELOPE_PATH,
    });
    await expect(verifySignedLc4QualificationPackageEnvelopeV5({
      ...retained,
      verifyTerminal,
    })).resolves.toMatchObject({ artifact_sha256: fixture.envelope.artifact_sha256 });

    const linkedRoot = await mkdtemp(join(tmpdir(), "hacc-package-envelope-link-"));
    roots.push(linkedRoot);
    await writeFile(join(linkedRoot, ENVELOPE_PATH), canonicalJson(fixture.envelope));
    await symlink(join(root, "replay.jsonl"), join(linkedRoot, "replay.jsonl"));
    await expect(readLc4QualificationPackageDirectoryV5({
      directory: linkedRoot,
      envelopePath: ENVELOPE_PATH,
    })).rejects.toThrow("only regular files");
  });
});
