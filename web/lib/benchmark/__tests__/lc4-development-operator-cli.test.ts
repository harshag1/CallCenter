import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  assertLc4DevOperatorAuthorizationDag,
  createLc4DevOperatorAuthorizationDag,
  lc4DevOperatorAuthorizationBindingSha256,
  loadLc4DevExplicitCredentials,
  type Lc4DevOperatorSigner,
} from "../lc4-development-operator-cli";
import type {
  Lc4DevLivePreflightArtifact,
  Lc4DevLivePrepareArtifact,
  Lc4DevRetainedQualificationReceipt,
} from "../lc4-development-live-runner";

const roots: string[] = [];
const HASH = "a".repeat(64);

function signer(): Lc4DevOperatorSigner {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({
    private_key: pair.privateKey,
    public_key_spki_der: der,
    public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pkcs8_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_fingerprint_sha256: sha256Hex(der),
  });
}

function fixtures() {
  const prepare = {
    execution_id: "lc4-dev-operator-test",
    prepare_sha256: "1".repeat(64),
    maximum_total_micro_usd: 15_000_000,
    audio_manifest_sha256: "2".repeat(64),
  } as Lc4DevLivePrepareArtifact;
  const qualification = {
    terminal_root_sha256: "3".repeat(64),
    retained_artifact_sha256: "4".repeat(64),
  } as Lc4DevRetainedQualificationReceipt;
  const authority = signer();
  const runtimeRoots = {
    control_plane_manifest_sha256: "5".repeat(64),
    listener_evidence_manifest_sha256: "6".repeat(64),
  };
  const input = {
    prepare,
    qualification,
    credential_identity_set_sha256: "7".repeat(64),
    roots: runtimeRoots,
    signer: authority,
    authorization_nonce_sha256: "8".repeat(64),
    not_before: "2026-07-22T06:00:00.000Z",
    expires_at: "2026-07-22T06:30:00.000Z",
  };
  return { prepare, qualification, authority, runtimeRoots, input };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("LC4-DEV operator custody", () => {
  it("builds an acyclic authorization -> ledger genesis -> signed authorization DAG", () => {
    const { input, authority } = fixtures();
    const dag = createLc4DevOperatorAuthorizationDag(input);
    const { immutable_ledger_genesis_sha256: _excluded, ...unsignedWithoutGenesis } = dag.authorization.body;
    void _excluded;
    expect(dag.authorization_binding_sha256).toBe(lc4DevOperatorAuthorizationBindingSha256(unsignedWithoutGenesis));
    expect(dag.immutable_ledger_genesis_sha256).toBe(dag.authorization.body.immutable_ledger_genesis_sha256);
    expect(dag.authorization.artifact_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const preflight = {
      execution_id: input.prepare.execution_id,
      prepare_sha256: input.prepare.prepare_sha256,
      immutable_ledger_genesis_sha256: dag.immutable_ledger_genesis_sha256,
      authority_trust_root_sha256: authority.public_key_fingerprint_sha256,
      authorization: dag.authorization,
    } as Lc4DevLivePreflightArtifact;
    expect(assertLc4DevOperatorAuthorizationDag({
      preflight,
      expected_authority_public_key_fingerprint_sha256: authority.public_key_fingerprint_sha256,
    })).toBe(dag.authorization_binding_sha256);
  });

  it("binds every custody edge and rejects a caller-supplied genesis or substituted preflight before execution", () => {
    const { input, authority } = fixtures();
    const baseline = createLc4DevOperatorAuthorizationDag(input);
    const mutations = [
      { ...input, credential_identity_set_sha256: "9".repeat(64) },
      { ...input, roots: { ...input.roots, control_plane_manifest_sha256: "b".repeat(64) } },
      { ...input, roots: { ...input.roots, listener_evidence_manifest_sha256: "c".repeat(64) } },
      { ...input, authorization_nonce_sha256: "d".repeat(64) },
      { ...input, expires_at: "2026-07-22T06:31:00.000Z" },
    ];
    for (const mutation of mutations) {
      const changed = createLc4DevOperatorAuthorizationDag(mutation);
      expect(changed.authorization_binding_sha256).not.toBe(baseline.authorization_binding_sha256);
      expect(changed.immutable_ledger_genesis_sha256).not.toBe(baseline.immutable_ledger_genesis_sha256);
    }

    const substituted = {
      execution_id: input.prepare.execution_id,
      prepare_sha256: input.prepare.prepare_sha256,
      immutable_ledger_genesis_sha256: HASH,
      authority_trust_root_sha256: authority.public_key_fingerprint_sha256,
      authorization: {
        ...baseline.authorization,
        body: { ...baseline.authorization.body, immutable_ledger_genesis_sha256: HASH },
      },
    } as Lc4DevLivePreflightArtifact;
    expect(() => assertLc4DevOperatorAuthorizationDag({
      preflight: substituted,
      expected_authority_public_key_fingerprint_sha256: authority.public_key_fingerprint_sha256,
    })).toThrow("authorization binding DAG or ledger genesis is invalid");
  });

  it("loads credentials only from two explicit files with deterministic repository-file precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-operator-env-"));
    roots.push(root);
    const provider = join(root, "provider.env");
    const repository = join(root, "repo.env");
    await writeFile(provider, "OPENAI_API_KEY=openai-test-secret\nGEMINI_API_KEY=gemini-test-secret\n", { mode: 0o600 });
    await writeFile(repository, "XAI_API_KEY=xai-test-secret-value\n", { mode: 0o600 });
    const credentials = await loadLc4DevExplicitCredentials({ provider_env_file: provider, repository_env_file: repository });
    expect(Object.keys(credentials)).toEqual(["openai", "gemini", "xai"]);
    expect(JSON.stringify(Object.keys(credentials))).not.toContain("secret");

    await chmod(repository, 0o600);
    await writeFile(repository, "OPENAI_API_KEY=different-openai-secret\nXAI_API_KEY=xai-test-secret-value\n");
    const overridden = await loadLc4DevExplicitCredentials({ provider_env_file: provider, repository_env_file: repository });
    expect(overridden.openai).toBe("different-openai-secret");
  });
});
