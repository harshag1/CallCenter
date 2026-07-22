import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
  LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
  LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
  assertLc4QualificationV3PlanArtifact,
  createLc4QualificationV3AuthorizationArtifact,
  loadLc4QualificationV3ExplicitCredentials,
  prepareLc4QualificationV3,
  reportLc4QualificationV3,
  runLc4QualificationV3,
  type Lc4QualificationV3AuthorizationBody,
  type Lc4QualificationV3GitSource,
} from "../lc4-qualification-v3-runner";
import {
  LC4_S2S_COMPACT_CONTROL_SHA256,
  LC4_S2S_PACKETIZER_SHA256,
  LC4_S2S_SOURCE_TEXT,
  LC4_S2S_TOOL_SCHEMA_SHA256,
  type Lc4S2sAudioRenderer,
  type Lc4S2sRoundtripExecution,
} from "../provider-s2s-tool-roundtrip";
import type { LiveStsProvider } from "../live-sts-development-experiment";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeEventListener,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const SOURCE: Lc4QualificationV3GitSource = Object.freeze({
  source_commit: "a".repeat(40),
  source_tree_oid: "b".repeat(40),
  source_tree_sha256: "c".repeat(64),
  worktree_clean: true,
});
const CREDENTIALS = Object.freeze({
  openai: "openai-qualification-secret",
  gemini: "gemini-qualification-secret",
  xai: "xai-qualification-secret",
});
const NOW = new Date("2026-07-22T20:00:00.000Z");

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicSpki = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    privatePem,
    publicSpkiBase64: publicSpki.toString("base64"),
    fingerprint: sha256Hex(publicSpki),
  });
}

function pcm(sampleRateHz: 16_000 | 24_000): Uint8Array {
  const bytes = new Uint8Array(sampleRateHz * 12 / 10 * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < bytes.byteLength / 2; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(2 * Math.PI * 220 * index / sampleRateHz) * 4_000), true);
  }
  return bytes;
}

const renderer: Lc4S2sAudioRenderer = Object.freeze({
  identitySha256: "d".repeat(64),
  async render(text) {
    expect(text).toBe(LC4_S2S_SOURCE_TEXT);
    return Object.freeze({ pcm16k: pcm(16_000), pcm24k: pcm(24_000) });
  },
});

function acknowledgement(provider: LiveStsProvider): SessionConfigurationAcknowledgement {
  const verified = Object.freeze({ status: "verified" as const, requestedSha256: "1".repeat(64), acknowledgedSha256: "1".repeat(64), acknowledgedBy: "session.updated" as const });
  const unverifiable = Object.freeze({ status: "unverifiable" as const, requestedSha256: "2".repeat(64), reason: "provider does not echo this field" });
  if (provider === "gemini") return Object.freeze({
    schemaVersion: 1, strictParityVerified: false, paidBenchmarkReady: false, session: unverifiable,
    fields: Object.freeze({ model: unverifiable, voice: unverifiable, instructions: unverifiable, tools: unverifiable, tool_choice: Object.freeze({ status: "not_requested" as const }), input_audio: unverifiable, output_audio: unverifiable, turn_detection: unverifiable }),
  });
  if (provider === "xai") return Object.freeze({
    schemaVersion: 1, strictParityVerified: false, paidBenchmarkReady: false, session: unverifiable,
    fields: Object.freeze({ model: verified, voice: unverifiable, instructions: verified, tools: unverifiable, tool_choice: verified, input_audio: unverifiable, output_audio: verified, turn_detection: verified }),
  });
  return Object.freeze({
    schemaVersion: 1, strictParityVerified: true, paidBenchmarkReady: true, session: verified,
    fields: Object.freeze({ model: verified, voice: verified, instructions: verified, tools: verified, tool_choice: verified, input_audio: verified, output_audio: verified, turn_detection: verified }),
  });
}

class SetupClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly sessionConfigurationAcknowledgement;
  readonly #listeners = new Set<RealtimeEventListener>();
  constructor(provider: LiveStsProvider) {
    this.provider = provider;
    this.sessionConfigurationAcknowledgement = acknowledgement(provider);
  }
  async connect() {
    this.state = "ready";
    const event: NormalizedRealtimeEvent = {
      type: "session.ready", provider: this.provider, receivedAtMs: 1,
      wireType: this.provider === "gemini" ? "setupComplete" : "session.updated",
      configuration: this.sessionConfigurationAcknowledgement,
    };
    for (const listener of this.#listeners) listener(event);
  }
  close() { this.state = "closed"; }
  onEvent(listener: RealtimeEventListener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent() { return () => undefined; }
  appendInputAudio() { throw new Error("setup only"); }
  prepareResponse() { throw new Error("setup only"); }
  commitInputAudio() { throw new Error("setup only"); }
  createResponse() { throw new Error("setup only"); }
  sendTurn() { throw new Error("setup only"); }
  submitToolResults() { throw new Error("setup only"); }
}

function passedExecution(input: Parameters<NonNullable<Parameters<typeof runLc4QualificationV3>[0]["dependencies"]>["executeRoundtrip"]>[0]): Lc4S2sRoundtripExecution {
  const body = Object.freeze({
    schema_version: 1 as const,
    roundtrip_version: "HACC-LC4-S2S-TOOL-ROUNDTRIP-v3" as const,
    provider: input.provider,
    model: input.model,
    attempted_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
    status: "passed" as const,
    failure_class: "none" as const,
    audio: input.audioObject,
    delivery: Object.freeze({
      packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
      delivery_profile_sha256: "3".repeat(64),
      audio_sha256: input.audioObject.sha256,
      audio_bytes: input.audioObject.byte_length,
      chunk_count: 60,
      frame_bytes: input.audioObject.sample_rate_hz * 20 / 1_000 * 2,
      tail_bytes: input.audioObject.sample_rate_hz * 20 / 1_000 * 2,
      scheduled_offsets_ms: Object.freeze(Array.from({ length: 60 }, (_, index) => index * 20)),
    }),
    compact_control_sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
    tool_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
    response_generation_requested: true,
    tool_call_observed: true,
    tool_result_submitted: true,
    tool_result_event_observed: true,
    tool_result_wire_observed: true,
    post_tool_continuation_requested: true,
    post_tool_continuation_observed: true,
    post_tool_terminal_observed: true,
    post_tool_usage_observed: true,
    provider_tool_call_evidence_sha256: "4".repeat(64),
    tool_result_evidence_sha256: "5".repeat(64),
    wire_observations: Object.freeze([]),
    usage: Object.freeze([{ totalTokens: 8, raw: { total: 8 } }]),
    operation_order: Object.freeze(["session_ready", "exact_tool_call_observed", "matching_tool_result_submitted", "post_tool_terminal_observed"]),
    failure_evidence_sha256: "6".repeat(64),
  });
  return Object.freeze({
    ...body,
    evidence_sha256: sha256Hex(`harshas-amazing-call-center/lc4-s2s-roundtrip-evidence/v3\n${canonicalJson(body)}`),
  });
}

describe("LC4 qualification v3 signed runner", () => {
  it("signs the exact source/fixture plan and rejects plan mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-evidence-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-plan-test",
      dependencies: { inspectGitSource: async () => SOURCE, loadCredentials: async () => CREDENTIALS, materializeAudio: (await import("../provider-s2s-tool-roundtrip")).materializeLc4S2sAudioFixture },
    });
    expect(plan.body).toMatchObject({
      provider_calls_authorized: false,
      maximum_provider_sessions: 6,
      maximum_paid_sessions: 3,
      maximum_generation_phases: 6,
      maximum_tool_roundtrips: 3,
    });
    expect(plan.body.control_size_diagnostic.qualification_gate).toBe(false);
    expect(() => assertLc4QualificationV3PlanArtifact(plan, authority.fingerprint)).not.toThrow();
    expect(() => assertLc4QualificationV3PlanArtifact({
      ...plan,
      body: { ...plan.body, maximum_paid_sessions: 2 as 3 },
    }, authority.fingerprint)).toThrow("hash mismatch");
  });

  it("retains a signed full-loop terminal and a self-excluding package manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-evidence-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-run-plan",
      dependencies: { inspectGitSource: async () => SOURCE, loadCredentials: async () => CREDENTIALS, materializeAudio: audioModule.materializeLc4S2sAudioFixture },
    });
    const authBody: Lc4QualificationV3AuthorizationBody = Object.freeze({
      schema_version: 1,
      authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
      authorization_id: "qualification-v3-attempt-001",
      authorization_nonce_sha256: "7".repeat(64),
      plan_artifact_sha256: plan.artifact_sha256,
      plan_sha256: plan.body.plan_sha256,
      source_commit: plan.body.source.source_commit,
      source_tree_sha256: plan.body.source.source_tree_sha256,
      credential_set_sha256: plan.body.credential_set_sha256,
      terminal_public_key_spki_base64: terminalKey.publicSpkiBase64,
      terminal_public_key_fingerprint_sha256: terminalKey.fingerprint,
      maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
      maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
      maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
      maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
      maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
      paid_retry_allowed: false,
      not_before: "2026-07-22T19:00:00.000Z",
      expires_at: "2026-07-22T21:00:00.000Z",
    });
    const authorization = createLc4QualificationV3AuthorizationArtifact({ body: authBody, authorityPrivateKeyPem: authority.privatePem });
    const terminal = await runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
        createClient: (provider) => new SetupClient(provider),
        executeRoundtrip: async (input) => passedExecution(input),
      },
    });
    expect(terminal.body).toMatchObject({
      status: "passed",
      provider_sessions_opened: 6,
      paid_sessions_opened: 3,
      generation_phases_attempted: 6,
      tool_roundtrips_attempted: 3,
      paid_retries_attempted: 0,
    });
    const manifest = JSON.parse(await readFile(join(root, "attempts", `${authBody.authorization_id}.complete`, "artifact-manifest.json"), "utf8")) as { self_excluded: boolean; entries: { path: string }[] };
    expect(manifest.self_excluded).toBe(true);
    expect(manifest.entries.map((entry) => entry.path)).not.toContain("artifact-manifest.json");
    expect(manifest.entries.some((entry) => /\.pem$|\.env$/u.test(entry.path))).toBe(false);
    const report = await reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint });
    expect(report).toMatchObject({
      invoked_attempts: 1,
      refused_attempts: 0,
      stranded_invocations: 0,
      complete_attempts: 1,
      partial_attempts: 0,
      gate_c_qualification_gate: false,
    });
  });

  it("loads only two explicit regular files with stable repository-last precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-env-"));
    roots.push(root);
    const provider = join(root, "provider.env");
    const repository = join(root, "repository.env");
    await writeFile(provider, [
      "OPENAI_API_KEY=provider-openai-secret",
      "GEMINI_API_KEY=provider-gemini-secret",
      "XAI_API_KEY=provider-xai-secret",
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(repository, [
      "OPENAI_API_KEY=repository-openai-secret",
      "XAI_API_KEY=repository-xai-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    const previous = {
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      xai: process.env.XAI_API_KEY,
      selected: process.env.BENCHMARK_PROVIDER_ENV_FILE,
    };
    process.env.OPENAI_API_KEY = "hostile-ambient-openai";
    process.env.GEMINI_API_KEY = "hostile-ambient-gemini";
    process.env.XAI_API_KEY = "hostile-ambient-xai";
    process.env.BENCHMARK_PROVIDER_ENV_FILE = join(root, "ambient-must-not-be-read.env");
    try {
      await expect(loadLc4QualificationV3ExplicitCredentials({
        providerEnvFile: provider,
        repoEnvFile: repository,
      })).resolves.toEqual({
        openai: "repository-openai-secret",
        gemini: "provider-gemini-secret",
        xai: "repository-xai-secret",
      });
    } finally {
      for (const [name, value] of Object.entries({
        OPENAI_API_KEY: previous.openai,
        GEMINI_API_KEY: previous.gemini,
        XAI_API_KEY: previous.xai,
        BENCHMARK_PROVIDER_ENV_FILE: previous.selected,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    await expect(loadLc4QualificationV3ExplicitCredentials({
      providerEnvFile: join(root, "missing.env"),
      repoEnvFile: repository,
    })).rejects.toMatchObject({ stage: "credentials", code: "credential_source_invalid" });
    const providerLink = join(root, "provider-link.env");
    await symlink(provider, providerLink);
    await expect(loadLc4QualificationV3ExplicitCredentials({
      providerEnvFile: providerLink,
      repoEnvFile: repository,
    })).rejects.toMatchObject({ stage: "credentials", code: "credential_source_invalid" });
  });

  it("strands authority and retains a signed refusal before budget or provider construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-refusal-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-v3-repo-"));
    roots.push(root, repositoryRoot);
    const authority = keys();
    const terminalKey = keys();
    const audioModule = await import("../provider-s2s-tool-roundtrip");
    const plan = await prepareLc4QualificationV3({
      root,
      repositoryRoot,
      authorityPrivateKeyPem: authority.privatePem,
      trustRootFingerprint: authority.fingerprint,
      audioRenderer: renderer,
      now: () => NOW,
      planId: "qualification-v3-refusal-plan",
      dependencies: {
        inspectGitSource: async () => SOURCE,
        loadCredentials: async () => CREDENTIALS,
        materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      },
    });
    const authBody: Lc4QualificationV3AuthorizationBody = Object.freeze({
      schema_version: 1,
      authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
      authorization_id: "qualification-v3-refusal-001",
      authorization_nonce_sha256: "8".repeat(64),
      plan_artifact_sha256: plan.artifact_sha256,
      plan_sha256: plan.body.plan_sha256,
      source_commit: plan.body.source.source_commit,
      source_tree_sha256: plan.body.source.source_tree_sha256,
      credential_set_sha256: plan.body.credential_set_sha256,
      terminal_public_key_spki_base64: terminalKey.publicSpkiBase64,
      terminal_public_key_fingerprint_sha256: terminalKey.fingerprint,
      maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
      maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
      maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
      maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
      maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
      paid_retry_allowed: false,
      not_before: "2026-07-22T19:00:00.000Z",
      expires_at: "2026-07-22T21:00:00.000Z",
    });
    const authorization = createLc4QualificationV3AuthorizationArtifact({
      body: authBody,
      authorityPrivateKeyPem: authority.privatePem,
    });
    let sourceInspections = 0;
    let credentialReads = 0;
    let clientConstructions = 0;
    const dependencies = {
      inspectGitSource: async () => {
        sourceInspections += 1;
        return SOURCE;
      },
      loadCredentials: async () => {
        credentialReads += 1;
        return Object.freeze({ ...CREDENTIALS, openai: "rotated-openai-qualification-secret" });
      },
      materializeAudio: audioModule.materializeLc4S2sAudioFixture,
      createClient: (provider: LiveStsProvider) => {
        clientConstructions += 1;
        return new SetupClient(provider);
      },
      executeRoundtrip: async (input: Parameters<typeof passedExecution>[0]) => passedExecution(input),
    };
    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: keys().privatePem,
      now: () => NOW,
      dependencies,
    })).rejects.toMatchObject({ stage: "terminal_key", code: "terminal_key_validation_failed" });
    await expect(readFile(join(root, "attempts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(sourceInspections).toBe(0);
    expect(credentialReads).toBe(0);
    expect(clientConstructions).toBe(0);

    const invocation = runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies,
    });
    await expect(invocation).rejects.toMatchObject({
      stage: "credentials",
      code: "credential_set_mismatch",
    });
    expect(sourceInspections).toBe(1);
    expect(credentialReads).toBe(1);
    expect(clientConstructions).toBe(0);
    await expect(readFile(join(root, "attempts", `${authBody.authorization_id}.invoked.json`), "utf8")).resolves.toContain(authBody.authorization_id);
    await expect(readFile(join(root, "attempts", `${authBody.authorization_id}.refusal.json`), "utf8")).resolves.toContain("credential_set_mismatch");
    await expect(readFile(join(root, "budget", "qualification-v3.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint })).resolves.toMatchObject({
      invoked_attempts: 1,
      refused_attempts: 1,
      stranded_invocations: 0,
      complete_attempts: 0,
      partial_attempts: 0,
    });

    const sourceAuthorization = createLc4QualificationV3AuthorizationArtifact({
      body: Object.freeze({
        ...authBody,
        authorization_id: "qualification-v3-source-refusal-001",
        authorization_nonce_sha256: "9".repeat(64),
      }),
      authorityPrivateKeyPem: authority.privatePem,
    });
    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization: sourceAuthorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies: {
        ...dependencies,
        inspectGitSource: async () => {
          sourceInspections += 1;
          return Object.freeze({ ...SOURCE, source_tree_sha256: "d".repeat(64) });
        },
      },
    })).rejects.toMatchObject({ stage: "source", code: "source_mismatch" });
    expect(sourceInspections).toBe(2);
    expect(credentialReads).toBe(1);
    expect(clientConstructions).toBe(0);
    await expect(reportLc4QualificationV3({ root, trustRootFingerprint: authority.fingerprint })).resolves.toMatchObject({
      invoked_attempts: 2,
      refused_attempts: 2,
      stranded_invocations: 0,
      complete_attempts: 0,
      partial_attempts: 0,
    });

    await expect(runLc4QualificationV3({
      root,
      repositoryRoot,
      authorization,
      trustRootFingerprint: authority.fingerprint,
      terminalPrivateKeyPem: terminalKey.privatePem,
      now: () => NOW,
      dependencies,
    })).rejects.toMatchObject({ stage: "invocation", code: "authorization_already_invoked" });
    expect(sourceInspections).toBe(2);
    expect(credentialReads).toBe(1);
    expect(clientConstructions).toBe(0);
  });
});
