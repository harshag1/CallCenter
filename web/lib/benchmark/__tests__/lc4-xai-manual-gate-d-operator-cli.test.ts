import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "../lc4-production-provider-contract";
import {
  createLc4XaiFiniteManualGateDProductionAdapter,
} from "../lc4-production-provider-adapter";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "../lc4-provider-profiles";
import {
  LC4_XAI_GATE_D_OPERATOR_FILES,
  runLc4XaiManualGateDOperatorCli,
} from "../lc4-xai-manual-gate-d-operator-cli";
import {
  LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
  LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
  createLc4XaiFiniteManualGateDSigner,
  lc4XaiFiniteManualGateDExecutionReplaySha256,
  type Lc4XaiFiniteManualGateDExecutionEvidence,
  type Lc4XaiFiniteManualGateDProductionAdapter,
} from "../lc4-xai.manual-qualification";
import {
  lc4XaiManualResponseWireIdentitySha256,
  type Lc4SanitizedWireObservation,
} from "../lc4-xai-manual-turn-causality";

const NOW = new Date("2026-07-29T01:00:00.000Z");
const SOURCE = Object.freeze({
  source_commit: "a".repeat(40),
  source_tree_oid: "b".repeat(40),
  source_tree_sha256: sha256Hex("gate-d-operator-source"),
  worktree_clean: true as const,
});
const MANUAL_CAUSALITY_DOMAIN =
  "harshas-amazing-call-center/lc4-xai-manual-turn-causality/v1\n";
const FAILURE_SIGNING_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-failure/v1\n";
const FAILURE_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-failure-artifact/v1\n";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function pem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

async function resignedFailure(
  terminalPath: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const privateKey = createPrivateKey(await readFile(terminalPath));
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const withoutHash = {
    body,
    public_key_spki_base64: publicKeyDer.toString("base64"),
    public_key_fingerprint_sha256: sha256Hex(publicKeyDer),
    signature_algorithm: "Ed25519",
    signature_base64: sign(
      null,
      Buffer.from(`${FAILURE_SIGNING_DOMAIN}${canonicalJson(body)}`),
      privateKey,
    ).toString("base64"),
  };
  return {
    ...withoutHash,
    artifact_sha256: sha256Hex(
      `${FAILURE_ARTIFACT_DOMAIN}${canonicalJson(withoutHash)}`,
    ),
  };
}

function observations(): readonly Lc4SanitizedWireObservation[] {
  const roles = [
    ["outbound", "input_audio_buffer.commit"],
    ["inbound", "input_audio_buffer.committed"],
    ["outbound", "response.create"],
    ["inbound", "response.created"],
    ["inbound", "response.audio.delta"],
    ["inbound", "response.function_call_arguments.done"],
    ["inbound", "response.done"],
    ["outbound", "conversation.item.create"],
    ["outbound", "response.create"],
    ["inbound", "response.created"],
    ["inbound", "response.audio.delta"],
    ["inbound", "response.done"],
  ] as const;
  let previous: string | null = null;
  return roles.map(([direction, wireType], index) => {
    const sequence = index + 1;
    const observationSha256 = sha256Hex(canonicalJson({
      direction,
      wireType,
      sequence,
      previous,
    }));
    const value = Object.freeze({
      provider: "xai" as const,
      direction,
      connection_epoch: 1,
      sequence,
      wire_type: wireType,
      payload_sha256: sha256Hex(`payload:${sequence}`),
      payload_bytes: 8,
      projection_sha256: sha256Hex(`projection:${sequence}`),
      observation_sha256: observationSha256,
      previous_observation_sha256: previous,
      identity_hashes: {
        ...([4, 5, 6, 7].includes(sequence)
          ? {
              responseIdSha256:
                lc4XaiManualResponseWireIdentitySha256("root-response"),
            }
          : {}),
        ...([10, 11, 12].includes(sequence)
          ? {
              responseIdSha256:
                lc4XaiManualResponseWireIdentitySha256("continuation-response"),
            }
          : {}),
        ...([6, 7, 8].includes(sequence)
          ? { callIdSha256: sha256Hex("operator-capability-call") }
          : {}),
      },
    });
    previous = observationSha256;
    return value;
  });
}

function passingEvidence(
  callerPcm: Uint8Array,
): Lc4XaiFiniteManualGateDExecutionEvidence {
  const wire = observations();
  const causalityBody = Object.freeze({
    schema_version: 1 as const,
    connection_epoch: 1,
    commit_observation_sha256: wire[0]!.observation_sha256,
    commit_sequence: 1,
    commit_ack_observation_sha256: wire[1]!.observation_sha256,
    commit_ack_sequence: 2,
    response_create_observation_sha256: wire[2]!.observation_sha256,
    response_create_sequence: 3,
    response_start_observation_sha256: wire[3]!.observation_sha256,
    response_start_sequence: 4,
    response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("root-response"),
  });
  const withoutReplay = Object.freeze({
    schema_version: 2 as const,
    provider: "xai" as const,
    model: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model,
    voice: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.voice,
    transport_purpose: "finite_prerecorded_efficacy" as const,
    transport_mode: "manual_commit" as const,
    transport_profile_sha256:
      LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    caller_pcm_sha256: sha256Hex(callerPcm),
    caller_pcm_byte_length: callerPcm.byteLength,
    caller_pcm_appended_sha256: sha256Hex(callerPcm),
    caller_pcm_appended_byte_length: callerPcm.byteLength,
    provider_sessions_opened: 1 as const,
    generation_phases: 2 as const,
    capability_gateway_tool_roundtrips: 1 as const,
    retries: 0 as const,
    reconnects: 0 as const,
    fallbacks: 0 as const,
    operation_order: LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
    manual_turn_causality: Object.freeze({
      ...causalityBody,
      causality_sha256: sha256Hex(
        `${MANUAL_CAUSALITY_DOMAIN}${canonicalJson(causalityBody)}`,
      ),
    }),
    wire_observations: wire,
    initial_assistant_pcm_sha256: sha256Hex("initial-pcm"),
    initial_assistant_pcm_byte_length: 4,
    initial_assistant_pcm_observation_sha256:
      wire[4]!.observation_sha256,
    capability_gateway_tool_call_sha256: sha256Hex("tool-call"),
    capability_gateway_tool_call_observation_sha256:
      wire[6]!.observation_sha256,
    capability_gateway_tool_result_sha256: sha256Hex("tool-result"),
    capability_gateway_tool_result_observation_sha256:
      wire[7]!.observation_sha256,
    post_tool_continuation_sha256: sha256Hex("continuation"),
    post_tool_continuation_observation_sha256:
      wire[8]!.observation_sha256,
    post_tool_response_start_observation_sha256:
      wire[9]!.observation_sha256,
    post_tool_assistant_pcm_sha256: sha256Hex("post-tool-pcm"),
    post_tool_assistant_pcm_byte_length: 4,
    post_tool_assistant_pcm_observation_sha256:
      wire[10]!.observation_sha256,
    capability_gateway_call_id_sha256:
      sha256Hex("operator-capability-call"),
    post_tool_continuation_origin_response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("root-response"),
    post_tool_response_id_sha256:
      lc4XaiManualResponseWireIdentitySha256("continuation-response"),
    terminal_observation_sha256: wire[11]!.observation_sha256,
  });
  return Object.freeze({
    ...withoutReplay,
    replay_sha256:
      lc4XaiFiniteManualGateDExecutionReplaySha256(withoutReplay),
  });
}

function fakeAdapter(
  execute: Lc4XaiFiniteManualGateDProductionAdapter["execute"],
): Lc4XaiFiniteManualGateDProductionAdapter {
  return Object.freeze({
    [LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY]: true as const,
    kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1",
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    execute,
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hacc-gate-d-operator-"));
  roots.push(root);
  await chmod(root, 0o700);
  const repository = join(root, "repository");
  const evidence = join(root, "evidence");
  const clip = join(root, "clip.pcm");
  const authority = join(root, "authority.pem");
  const terminal = join(root, "terminal.pem");
  const authorityPem = pem();
  const terminalPem = pem();
  await Promise.all([
    mkdir(repository, { mode: 0o700 }),
    writeFile(clip, Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]), { mode: 0o600 }),
    writeFile(authority, authorityPem, { mode: 0o600 }),
    writeFile(terminal, terminalPem, { mode: 0o600 }),
  ]);
  return {
    root,
    repository,
    evidence,
    clip,
    authority,
    terminal,
    trust: createLc4XaiFiniteManualGateDSigner(
      authorityPem,
    ).public_key_fingerprint_sha256,
  };
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      now: () => NOW,
    },
  };
}

function baseDependencies(
  adapterFactory: (apiKey: string) => Lc4XaiFiniteManualGateDProductionAdapter,
) {
  return {
    inspect_source: async () => SOURCE,
    load_xai_credential: async () => "credential-value-never-log",
    create_adapter: adapterFactory,
    random_uuid: () => "deterministic-id",
    random_bytes: () => Buffer.alloc(32, 7),
  };
}

describe("LC4 xAI Gate D operator", () => {
  it("documents the environment-only, one-shot $1 command contract", async () => {
    const output = io();
    expect(await runLc4XaiManualGateDOperatorCli(["--help"], output.value))
      .toBe(0);
    expect(output.stdout.join("\n")).toContain("XAI_API_KEY=<secret>");
    expect(output.stdout.join("\n")).toContain("exactly $1.00");
    expect(output.stdout.join("\n")).toContain(
      "cannot be retried, reconnected",
    );
    expect(output.stdout.join("\n")).not.toContain("credential-value");
  });

  it("runs prepare, authorize, one paid seam, report, and status end to end", async () => {
    const value = await fixture();
    const output = io();
    const paid = vi.fn(async ({ caller_pcm }: { caller_pcm: Uint8Array }) => (
      passingEvidence(caller_pcm)
    ));
    const dependencies = baseDependencies(() => fakeAdapter(paid));
    expect(await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies)).toBe(0);
    expect(await runLc4XaiManualGateDOperatorCli([
      "authorize",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--authority-private-key", value.authority,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    expect(await runLc4XaiManualGateDOperatorCli([
      "run",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    expect(await runLc4XaiManualGateDOperatorCli([
      "report",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    expect(await runLc4XaiManualGateDOperatorCli([
      "status",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    expect(paid).toHaveBeenCalledTimes(1);
    expect(output.stderr).toEqual([]);
    const records = output.stdout
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({
      action: "lc4-xai-gate-d-status",
      state: "passed",
      verification: "verified",
      retry_permitted: false,
      provider_calls_made: 0,
    });
    expect(records).toContainEqual(expect.objectContaining({
      action: "lc4-xai-gate-d-passed",
      provider_sessions_opened: 1,
      generation_phases: 2,
      capability_gateway_tool_roundtrips: 1,
      retries: 0,
      reconnects: 0,
      fallbacks: 0,
      conservatively_settled_micro_usd: 1_000_000,
      active_micro_usd: 0,
      efficacy_scored: false,
      raw_audio_retained: false,
      credentials_retained: false,
    }));
    const serializedOutput = output.stdout.join("\n");
    expect(serializedOutput).not.toContain("credential-value-never-log");
    expect(serializedOutput).not.toContain("[1,0,2,0");
    for (const filename of [
      LC4_XAI_GATE_D_OPERATOR_FILES.plan,
      LC4_XAI_GATE_D_OPERATOR_FILES.authorization,
      LC4_XAI_GATE_D_OPERATOR_FILES.invocation,
      LC4_XAI_GATE_D_OPERATOR_FILES.receipt,
    ]) {
      expect((await stat(join(value.evidence, filename))).mode & 0o777)
        .toBe(0o400);
    }
    const receipt = await readFile(
      join(value.evidence, LC4_XAI_GATE_D_OPERATOR_FILES.receipt),
      "utf8",
    );
    expect(receipt).not.toContain("credential-value-never-log");
  });

  it("claims before execution and permanently refuses a retry after failure", async () => {
    const value = await fixture();
    const output = io();
    const firstPaid = vi.fn(async () => {
      throw new Error("provider plaintext must not escape");
    });
    const dependencies = baseDependencies(() => fakeAdapter(firstPaid));
    await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies);
    await runLc4XaiManualGateDOperatorCli([
      "authorize",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--authority-private-key", value.authority,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies);
    expect(await runLc4XaiManualGateDOperatorCli([
      "run",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(2);
    expect(firstPaid).toHaveBeenCalledTimes(1);
    expect(output.stderr.at(-1)).toContain("$1 authority is conservatively settled");
    expect(output.stderr.at(-1)).toContain("failure_class=provider_protocol");
    expect(output.stderr.join("\n")).not.toContain("provider plaintext");
    expect(await runLc4XaiManualGateDOperatorCli([
      "report",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(2);
    expect(await runLc4XaiManualGateDOperatorCli([
      "status",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    const records = output.stdout
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({
      action: "lc4-xai-gate-d-report",
      status: "failed",
      verification: "verified",
      failure_stage: "provider_execution",
      failure_class: "provider_protocol",
      retry_permitted: false,
      conservatively_settled_micro_usd: 1_000_000,
      active_micro_usd: 0,
      provider_calls_made_by_report: 0,
      contains_raw_error_credentials_or_audio: false,
    }));
    expect(records.at(-1)).toMatchObject({
      action: "lc4-xai-gate-d-status",
      state: "failed",
      verification: "verified",
      retry_permitted: false,
      failure_class: "provider_protocol",
    });
    const failurePath = join(
      value.evidence,
      LC4_XAI_GATE_D_OPERATOR_FILES.failure,
    );
    expect((await stat(failurePath)).mode & 0o777).toBe(0o400);
    const failure = await readFile(failurePath, "utf8");
    expect(failure).not.toContain("provider plaintext");
    expect(failure).not.toContain("credential-value-never-log");
    expect(failure).not.toContain(value.root);
    expect(failure).not.toContain("[1,0,2,0");

    const secondPaid = vi.fn();
    expect(await runLc4XaiManualGateDOperatorCli([
      "run",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, {
      ...dependencies,
      create_adapter: () => fakeAdapter(secondPaid),
    })).toBe(1);
    expect(secondPaid).not.toHaveBeenCalled();
    expect(output.stderr.at(-1)).toContain("cannot be retried");
  });

  it("rejects independently re-signed semantic tampering in claimed failures", async () => {
    const value = await fixture();
    const output = io();
    const dependencies = baseDependencies(() => fakeAdapter(vi.fn(
      async () => {
        throw new Error("provider response identity mismatch");
      },
    )));
    await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies);
    await runLc4XaiManualGateDOperatorCli([
      "authorize",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--authority-private-key", value.authority,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies);
    expect(await runLc4XaiManualGateDOperatorCli([
      "run",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(2);
    const failurePath = join(
      value.evidence,
      LC4_XAI_GATE_D_OPERATOR_FILES.failure,
    );
    const original = JSON.parse(
      await readFile(failurePath, "utf8"),
    ) as { body: Record<string, unknown> };
    const mutations: Array<(body: Record<string, unknown>) => void> = [
      (body) => {
        body.failure_stage = "success_receipt_persistence";
      },
      (body) => {
        body.source_commit = "c".repeat(40);
      },
      (body) => {
        (body.budget as Record<string, unknown>).active_micro_usd = 1;
      },
      (body) => {
        const claim = body.invocation_claim as Record<string, unknown>;
        claim.marker_inode = Number(claim.marker_inode) + 1;
      },
      (body) => {
        body.candidate_pass_receipt_sha256 = "d".repeat(64);
      },
      (body) => {
        body.raw_error_retained = true;
      },
    ];
    for (const mutate of mutations) {
      const body = structuredClone(original.body);
      mutate(body);
      const artifact = await resignedFailure(value.terminal, body);
      await chmod(failurePath, 0o600);
      await writeFile(failurePath, `${canonicalJson(artifact)}\n`);
      await chmod(failurePath, 0o400);
      const reportOutput = io();
      expect(await runLc4XaiManualGateDOperatorCli([
        "report",
        "--repository-root", value.repository,
        "--evidence-root", value.evidence,
        "--trust-root-fingerprint", value.trust,
      ], reportOutput.value, dependencies)).toBe(1);
    }
    await chmod(failurePath, 0o600);
    await writeFile(failurePath, Buffer.alloc((256 * 1024) + 1, 0x20));
    await chmod(failurePath, 0o400);
    const oversizedOutput = io();
    expect(await runLc4XaiManualGateDOperatorCli([
      "report",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], oversizedOutput.value, dependencies)).toBe(1);
    expect(oversizedOutput.stderr.at(-1)).toContain("invalid size");
  });

  it("fails closed on a terminal conflict", async () => {
    const value = await fixture();
    const output = io();
    const dependencies = baseDependencies(
      () => fakeAdapter(vi.fn(async ({ caller_pcm }) => (
        passingEvidence(caller_pcm)
      ))),
    );
    await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies);
    await runLc4XaiManualGateDOperatorCli([
      "authorize",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--authority-private-key", value.authority,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies);
    expect(await runLc4XaiManualGateDOperatorCli([
      "run",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    await writeFile(
      join(value.evidence, LC4_XAI_GATE_D_OPERATOR_FILES.failure),
      "{}\n",
      { flag: "wx", mode: 0o400 },
    );
    expect(await runLc4XaiManualGateDOperatorCli([
      "report",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(1);
    expect(await runLc4XaiManualGateDOperatorCli([
      "status",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    const status = JSON.parse(output.stdout.at(-1)!) as Record<string, unknown>;
    expect(status).toMatchObject({
      state: "terminal_conflict",
      verification: "not_verified",
      retry_permitted: false,
    });
  });

  it("does not terminalize an invocation marker owned by another process", async () => {
    const value = await fixture();
    const output = io();
    const createAdapter = vi.fn();
    const dependencies = baseDependencies(createAdapter);
    await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies);
    await runLc4XaiManualGateDOperatorCli([
      "authorize",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--authority-private-key", value.authority,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies);
    await writeFile(
      join(value.evidence, LC4_XAI_GATE_D_OPERATOR_FILES.invocation),
      "{}\n",
      { flag: "wx", mode: 0o400 },
    );
    expect(await runLc4XaiManualGateDOperatorCli([
      "run",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(1);
    expect(createAdapter).not.toHaveBeenCalled();
    await expect(stat(
      join(value.evidence, LC4_XAI_GATE_D_OPERATOR_FILES.failure),
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runLc4XaiManualGateDOperatorCli([
      "status",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    expect(JSON.parse(output.stdout.at(-1)!)).toMatchObject({
      state: "claimed_unsealed",
      verification: "not_verified",
      retry_permitted: false,
    });
  });

  it("reports a failure-file collision as claimed and unsealed", async () => {
    const value = await fixture();
    const output = io();
    const failurePath = join(
      value.evidence,
      LC4_XAI_GATE_D_OPERATOR_FILES.failure,
    );
    const paid = vi.fn(async () => {
      await writeFile(failurePath, "{}\n", {
        flag: "wx",
        mode: 0o400,
      });
      throw new Error("provider connection failed");
    });
    const dependencies = baseDependencies(() => fakeAdapter(paid));
    await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies);
    await runLc4XaiManualGateDOperatorCli([
      "authorize",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--authority-private-key", value.authority,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies);
    expect(await runLc4XaiManualGateDOperatorCli([
      "run",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--terminal-private-key", value.terminal,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(1);
    expect(paid).toHaveBeenCalledTimes(1);
    expect(output.stderr.at(-1)).toContain(
      "sanitized_failure_artifact=not_sealed",
    );
    expect(await runLc4XaiManualGateDOperatorCli([
      "status",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(0);
    expect(JSON.parse(output.stdout.at(-1)!)).toMatchObject({
      state: "claimed_unsealed",
      verification: "not_verified",
      retry_permitted: false,
    });
  });

  it("rejects credential-like CLI flags and dirty source before paid construction", async () => {
    const value = await fixture();
    const output = io();
    const createAdapter = vi.fn();
    expect(await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
      "--xai-api-key", "forbidden",
    ], output.value, baseDependencies(createAdapter))).toBe(1);
    expect(output.stderr.at(-1)).toContain("requires exactly");
    expect(createAdapter).not.toHaveBeenCalled();

    expect(await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, {
      ...baseDependencies(createAdapter),
      inspect_source: async () => {
        throw new Error("dirty");
      },
    })).toBe(1);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("requires distinct private signer identities and a private evidence root", async () => {
    const value = await fixture();
    const output = io();
    const dependencies = baseDependencies(() => fakeAdapter(vi.fn()));
    await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies);
    expect(await runLc4XaiManualGateDOperatorCli([
      "authorize",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--authority-private-key", value.authority,
      "--terminal-private-key", value.authority,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(1);
    expect(output.stderr.at(-1)).toContain("identities must differ");

    await chmod(value.evidence, 0o755);
    expect(await runLc4XaiManualGateDOperatorCli([
      "status",
      "--repository-root", value.repository,
      "--evidence-root", value.evidence,
      "--trust-root-fingerprint", value.trust,
    ], output.value, dependencies)).toBe(1);
    expect(output.stderr.at(-1)).toContain("physical private 0700 directory");
  });

  it("rejects evidence custody physically inside the repository, including aliases", async () => {
    const value = await fixture();
    const output = io();
    const createAdapter = vi.fn();
    const dependencies = baseDependencies(createAdapter);
    const inside = join(value.repository, "gate-d-evidence");
    expect(await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", inside,
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies)).toBe(1);
    expect(output.stderr.at(-1)).toContain(
      "physically outside the source repository",
    );
    expect(createAdapter).not.toHaveBeenCalled();

    const repositoryAlias = join(value.root, "repository-alias");
    await symlink(value.repository, repositoryAlias, "dir");
    expect(await runLc4XaiManualGateDOperatorCli([
      "prepare",
      "--repository-root", value.repository,
      "--evidence-root", join(repositoryAlias, "aliased-evidence"),
      "--harmless-clip-pcm", value.clip,
      "--authority-private-key", value.authority,
    ], output.value, dependencies)).toBe(1);
    expect(output.stderr.at(-1)).toContain(
      "physically outside the source repository",
    );
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("constructs only the exact frozen production adapter identity", () => {
    const adapter = createLc4XaiFiniteManualGateDProductionAdapter(
      "credential-value-never-log",
    );
    expect(adapter).toMatchObject({
      kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1",
      production_adapter_binding_sha256:
        LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    });
  });
});
