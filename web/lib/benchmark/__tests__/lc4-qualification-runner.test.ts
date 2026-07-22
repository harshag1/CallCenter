import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LC4_QUALIFICATION_AUTHORIZATION_VERSION,
  LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
  LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
  LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
  assertLc4QualificationAuthorization,
  assertLc4QualificationPlan,
  lc4QualificationAuthorizationArtifactSha256,
  lc4QualificationAuthorizationSigningBytes,
  prepareLc4Qualification,
  reportLc4Qualification,
  runLc4Qualification,
  runLc4QualificationCli,
  type Lc4QualificationAuthorizationArtifact,
  type Lc4QualificationAuthorizationBody,
  type Lc4QualificationGitSource,
  type Lc4QualificationPlan,
  type Lc4QualificationTrustRoot,
} from "../lc4-qualification-runner";
import {
  LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
  createLc4DevAudioCanaryPcm,
  lc4DevAudioCanaryFailureEvidenceSha256,
  lc4DevAudioCanarySpecification,
  type Lc4DevAudioCanaryExecution,
} from "../provider-dev-audio-canary";
import { canonicalJson, sha256Hex } from "../artifacts";
import { LIVE_STS_PROVIDER_SPECS, type LiveStsProvider } from "../live-sts-development-experiment";
import { DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE, trialAudioDeliveryProfileHash } from "../orchestrator";
import { packetizeRealtimePcm16 } from "../../realtime/audio-delivery";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeEventListener,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";

const roots: string[] = [];
const SOURCE: Lc4QualificationGitSource = Object.freeze({
  source_commit: "a".repeat(40),
  source_tree_oid: "b".repeat(40),
  source_tree_sha256: "c".repeat(64),
  worktree_clean: true,
});
const CREDENTIALS = Object.freeze({
  openai: "openai-test-secret-value",
  gemini: "gemini-test-secret-value",
  xai: "xai-test-secret-value",
});
const NOW = new Date("2026-07-21T22:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function acknowledgement(provider: LiveStsProvider): SessionConfigurationAcknowledgement {
  const verified = Object.freeze({
    status: "verified" as const,
    requestedSha256: "d".repeat(64),
    acknowledgedSha256: "d".repeat(64),
    acknowledgedBy: "session.updated" as const,
  });
  const unverifiable = Object.freeze({
    status: "unverifiable" as const,
    requestedSha256: "e".repeat(64),
    reason: "provider setup accepted without an exact field echo",
  });
  if (provider === "openai") {
    return Object.freeze({
      schemaVersion: 1,
      strictParityVerified: true,
      paidBenchmarkReady: true,
      session: verified,
      fields: Object.freeze({
        model: verified, voice: verified, instructions: verified, tools: verified,
        tool_choice: verified, input_audio: verified, output_audio: verified, turn_detection: verified,
      }),
    });
  }
  if (provider === "gemini") {
    return Object.freeze({
      schemaVersion: 1,
      strictParityVerified: false,
      paidBenchmarkReady: false,
      session: unverifiable,
      fields: Object.freeze({
        model: unverifiable, voice: unverifiable, instructions: unverifiable, tools: unverifiable,
        tool_choice: Object.freeze({ status: "not_requested" as const }),
        input_audio: unverifiable, output_audio: unverifiable, turn_detection: unverifiable,
      }),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    strictParityVerified: false,
    paidBenchmarkReady: false,
    session: unverifiable,
    fields: Object.freeze({
      model: verified, voice: unverifiable, instructions: verified, tools: unverifiable,
      tool_choice: verified, input_audio: unverifiable, output_audio: verified, turn_detection: verified,
    }),
  });
}

class ReadyQualificationClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly sessionConfigurationAcknowledgement;
  readonly #listeners = new Set<RealtimeEventListener>();
  forbiddenAudioCalls = 0;

  constructor(provider: LiveStsProvider) {
    this.provider = provider;
    this.sessionConfigurationAcknowledgement = acknowledgement(provider);
  }

  async connect(): Promise<void> {
    this.state = "ready";
    const event = Object.freeze({
      type: "session.ready" as const,
      provider: this.provider,
      receivedAtMs: 1,
      wireType: this.provider === "gemini" ? "setupComplete" : "session.updated",
      configuration: this.sessionConfigurationAcknowledgement,
    });
    for (const listener of this.#listeners) listener(event as NormalizedRealtimeEvent);
  }

  close(): void { this.state = "closed"; }
  onEvent(listener: RealtimeEventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent(): () => void { return () => undefined; }
  appendInputAudio(): void { this.forbiddenAudioCalls += 1; throw new Error("caller audio forbidden"); }
  prepareResponse(): void { throw new Error("not used by handshake mock"); }
  commitInputAudio(): void { throw new Error("not used by handshake mock"); }
  createResponse(): void { throw new Error("not used by handshake mock"); }
  sendTurn(): void { this.forbiddenAudioCalls += 1; throw new Error("caller audio forbidden"); }
  submitToolResults(): void { throw new Error("not used by handshake mock"); }
}

async function testRoots() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-test-repo-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-test-evidence-"));
  roots.push(repositoryRoot, evidenceRoot);
  return { repositoryRoot, evidenceRoot };
}

const preparationDependencies = Object.freeze({
  inspectGitSource: async () => SOURCE,
  loadCredentials: async () => CREDENTIALS,
});

function authorize(plan: Lc4QualificationPlan): Readonly<{
  authorization: Lc4QualificationAuthorizationArtifact;
  trustRoot: Lc4QualificationTrustRoot;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyBytes = publicKey.export({ format: "der", type: "spki" });
  const fingerprint = sha256Hex(keyBytes);
  const body: Lc4QualificationAuthorizationBody = Object.freeze({
    schema_version: 1,
    authorization_version: LC4_QUALIFICATION_AUTHORIZATION_VERSION,
    authorization_id: "development-static-gateway-canary-001",
    authorization_nonce_sha256: "f".repeat(64),
    protocol_id: "HACC-LC4-v1",
    purpose: "lc4_development_exact_model_zero_audio_and_exact_dev_schema_audio_canaries",
    plan_sha256: plan.plan_sha256,
    source_commit: plan.source_commit,
    source_tree_sha256: plan.source_tree_sha256,
    provider_profile_manifest_sha256: plan.provider_profile_manifest_sha256,
    configuration_matrix_sha256: plan.configuration_matrix_sha256,
    dev_configuration_matrix_sha256: plan.dev_configuration_matrix_sha256,
    credential_set_sha256: plan.credential_set_sha256,
    authorized_providers: Object.freeze(["openai", "gemini", "xai"] as const),
    authorized_models: Object.freeze({
      openai: LIVE_STS_PROVIDER_SPECS.openai.model,
      gemini: LIVE_STS_PROVIDER_SPECS.gemini.model,
      xai: LIVE_STS_PROVIDER_SPECS.xai.model,
    }),
    maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
    caller_audio_bytes: LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
    maximum_response_generations: LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
    paid_retry_allowed: false,
    not_before: "2026-07-21T21:00:00.000Z",
    expires_at: "2026-07-21T23:00:00.000Z",
  });
  const withoutHash = Object.freeze({
    body,
    authority_public_key_spki_base64: Buffer.from(keyBytes).toString("base64"),
    authority_public_key_fingerprint_sha256: fingerprint,
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(null, lc4QualificationAuthorizationSigningBytes(body), privateKey).toString("base64"),
  });
  return Object.freeze({
    authorization: Object.freeze({
      ...withoutHash,
      artifact_sha256: lc4QualificationAuthorizationArtifactSha256(withoutHash),
    }),
    trustRoot: Object.freeze({ schema_version: 1 as const, authority_public_key_fingerprint_sha256: fingerprint }),
  });
}

function passingDevAudioExecution(provider: LiveStsProvider, model: string): Lc4DevAudioCanaryExecution {
  const sampleRateHz = LIVE_STS_PROVIDER_SPECS[provider].sampleRateHz;
  const specification = lc4DevAudioCanarySpecification(provider, model, sampleRateHz);
  const audio = createLc4DevAudioCanaryPcm(sampleRateHz);
  const plan = packetizeRealtimePcm16(audio, DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE);
  const sanitizedFailureEvidence = Object.freeze({
    schema_version: 1 as const,
    provider,
    model,
    status: "passed" as const,
    code: "dev_gateway_tool_call_observed" as const,
    failure_class: "none" as const,
    primary: true as const,
    operation_order: Object.freeze([
      "session_ready",
      "caller_pcm_packetized_and_paced",
      "maximum_control_prepared",
      "caller_pcm_committed",
      "response_generation_requested",
    ]),
    input_audio: Object.freeze({
      bytes: specification.audio_bytes,
      chunks: plan.frames.length,
      sha256: specification.audio_sha256,
      complete: true,
    }),
    response: Object.freeze({ requested: true, gateway_call_observed: true }),
    wire: Object.freeze({ count: 0, terminal_type: null, terminal_observation_sha256: null }),
  });
  return Object.freeze({
    provider,
    model,
    attemptedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    status: "passed" as const,
    code: "dev_gateway_tool_call_observed" as const,
    specification,
    delivery: Object.freeze({
      packetizer_version: "HACC-REALTIME-AUDIO-DELIVERY-v1",
      packetizer_sha256: LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
      delivery_profile_sha256: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
      audio_sha256: specification.audio_sha256,
      audio_bytes: specification.audio_bytes,
      chunk_count: plan.frames.length,
      chunk_bytes: Object.freeze(plan.frames.map((frame) => frame.data.byteLength)),
      chunk_sha256: Object.freeze(plan.frames.map((frame) => sha256Hex(frame.data))),
      scheduled_offset_ms: Object.freeze(plan.frames.map((_, index) => index * DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE.chunkMs)),
    }),
    callerAudioBytes: specification.audio_bytes,
    responseGenerationRequested: true,
    responseGenerationEvidenceSha256: sha256Hex(`${provider}/dev-response`),
    providerToolCallEvidenceSha256: sha256Hex(`${provider}/dev-tool`),
    sanitizedFailureEvidence,
    failureEvidenceSha256: lc4DevAudioCanaryFailureEvidenceSha256(sanitizedFailureEvidence),
    wireObservations: Object.freeze([]),
    usage: Object.freeze([]),
  });
}

describe("LC4 exact-model qualification runner", () => {
  it("reports the source-frozen authorization and bounded dual-canary scope without touching a provider", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const providerCalls: string[] = [];
    const code = await runLc4QualificationCli(["status"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      now: () => NOW,
    }, {
      ...preparationDependencies,
      createClient: (provider) => { providerCalls.push(provider); return new ReadyQualificationClient(provider); },
      executeCanary: async () => { throw new Error("status must not execute a canary"); },
      executeDevAudioCanary: async () => { throw new Error("status must not execute a DEV audio canary"); },
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(providerCalls).toEqual([]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      execution_authorized_by_source: false,
      environment_override_authorizes_execution: false,
      caller_audio_bytes: LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
      maximum_response_generations: LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
      paid_retry_allowed: false,
      maximum_total_usd: 3,
    });
  });

  it("prepares one immutable plan bound to exact source, credentials, models, and gateway without retaining keys", async () => {
    const { repositoryRoot, evidenceRoot } = await testRoots();
    const plan = await prepareLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      now: () => NOW,
      planId: "qualification-plan-001",
      dependencies: preparationDependencies,
    });
    expect(plan.source_commit).toBe(SOURCE.source_commit);
    expect(plan.targets.map((target) => [target.provider, target.model])).toEqual([
      ["openai", LIVE_STS_PROVIDER_SPECS.openai.model],
      ["gemini", LIVE_STS_PROVIDER_SPECS.gemini.model],
      ["xai", LIVE_STS_PROVIDER_SPECS.xai.model],
    ]);
    expect(plan.targets.map((target) => target.caller_audio_bytes)).toEqual([1_920, 1_280, 1_920]);
    expect(plan.targets.every((target) => target.response_generations === 2 && !target.paid_retry_allowed)).toBe(true);
    expect(plan.targets.every((target) => target.zero_audio_tool_schema_sha256 !== target.dev_audio_tool_schema_sha256)).toBe(true);
    const encoded = await readFile(join(evidenceRoot, "lc4-qualification-plan.json"), "utf8");
    for (const secret of Object.values(CREDENTIALS)) expect(encoded).not.toContain(secret);
    await expect(prepareLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      now: () => NOW,
      planId: "qualification-plan-002",
      dependencies: preparationDependencies,
    })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects a legacy zero-audio-only plan and any DEV gateway-schema substitution", async () => {
    const { repositoryRoot, evidenceRoot } = await testRoots();
    const plan = await prepareLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      now: () => NOW,
      planId: "qualification-plan-contract-test",
      dependencies: preparationDependencies,
    });
    const zeroAudioOnly = {
      ...plan,
      runner_version: "HACC-LC4-QUALIFICATION-RUNNER-v1",
      execution_scope: "development_only_exact_model_handshake_and_zero_audio_static_gateway_canary",
      targets: plan.targets.map(({ provider, model, maximum_micro_usd, paid_retry_allowed }) => ({
        provider, model, caller_audio_bytes: 0, maximum_micro_usd, paid_retry_allowed,
      })),
    } as unknown as Lc4QualificationPlan;
    expect(() => assertLc4QualificationPlan(zeroAudioOnly)).toThrow();

    const substitutedSchema = {
      ...plan,
      targets: plan.targets.map((target, index) => index === 0
        ? { ...target, dev_audio_tool_schema_sha256: "0".repeat(64) }
        : target),
    } as Lc4QualificationPlan;
    expect(() => assertLc4QualificationPlan(substitutedSchema)).toThrow();
  });

  it("rejects tampered or stale development authorization before constructing any provider client", async () => {
    const { repositoryRoot, evidenceRoot } = await testRoots();
    const plan = await prepareLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      now: () => NOW,
      planId: "qualification-plan-auth-test",
      dependencies: preparationDependencies,
    });
    const valid = authorize(plan);
    expect(() => assertLc4QualificationAuthorization({ artifact: valid.authorization, trustRoot: valid.trustRoot, plan, now: NOW })).not.toThrow();
    const clients: string[] = [];
    const tampered = {
      ...valid.authorization,
      body: { ...valid.authorization.body, maximum_total_micro_usd: 3_000_001 },
    } as unknown as Lc4QualificationAuthorizationArtifact;
    await expect(runLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      authorization: tampered,
      trustRoot: valid.trustRoot,
      now: () => NOW,
      dependencies: {
        ...preparationDependencies,
        createClient: (provider) => { clients.push(provider); return new ReadyQualificationClient(provider); },
        executeCanary: async () => { throw new Error("must not execute"); },
        executeDevAudioCanary: async () => { throw new Error("must not execute"); },
      },
    })).rejects.toThrow("weakened the frozen development-only boundary");
    expect(clients).toEqual([]);
  });

  it("retains exact zero-audio and packetized DEV canaries, sanitized evidence, and blocks paid retry", async () => {
    const { repositoryRoot, evidenceRoot } = await testRoots();
    const plan = await prepareLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      now: () => NOW,
      planId: "qualification-plan-run-test",
      dependencies: preparationDependencies,
    });
    const valid = authorize(plan);
    const clients: ReadyQualificationClient[] = [];
    const canaryProviders: LiveStsProvider[] = [];
    const devCanaryProviders: LiveStsProvider[] = [];
    const dependencies = {
      ...preparationDependencies,
      createClient: (provider: LiveStsProvider) => {
        const client = new ReadyQualificationClient(provider);
        clients.push(client);
        return client;
      },
      executeCanary: async (input: Readonly<{ provider: LiveStsProvider; model: string }>) => {
        canaryProviders.push(input.provider);
        const evidence = sha256Hex(`${input.provider}/tool`);
        return Object.freeze({
          provider: input.provider,
          model: input.model,
          attemptedAt: NOW.toISOString(),
          completedAt: NOW.toISOString(),
          status: "passed" as const,
          code: "gateway_tool_call_observed" as const,
          callerAudioBytes: 0 as const,
          responseGenerationEvidenceSha256: sha256Hex(`${input.provider}/response`),
          providerToolCallEvidenceSha256: evidence,
          wireObservations: Object.freeze([]),
          usage: Object.freeze([Object.freeze({
            totalTokens: 7,
            raw: Object.freeze({ provider_meter: 7, hidden_key: "never-retained-verbatim" }),
          })]),
        });
      },
      executeDevAudioCanary: async (input: Readonly<{ provider: LiveStsProvider; model: string }>) => {
        devCanaryProviders.push(input.provider);
        return passingDevAudioExecution(input.provider, input.model);
      },
    };
    const terminal = await runLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      authorization: valid.authorization,
      trustRoot: valid.trustRoot,
      now: () => NOW,
      dependencies,
    });
    expect(terminal.status).toBe("passed");
    expect(terminal.response_generations_attempted).toBe(LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS);
    expect(terminal.caller_audio_bytes).toBe(LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES);
    expect(terminal.paid_retries_attempted).toBe(0);
    expect(canaryProviders).toEqual(["openai", "gemini", "xai"]);
    expect(devCanaryProviders).toEqual(["openai", "gemini", "xai"]);
    expect(clients).toHaveLength(9);
    expect(clients.every((client) => client.forbiddenAudioCalls === 0)).toBe(true);
    const complete = join(evidenceRoot, "attempts", `${valid.authorization.body.authorization_id}.complete`);
    const retainedUsage = await readFile(join(complete, "openai-usage.jsonl"), "utf8");
    expect(retainedUsage).not.toContain("never-retained-verbatim");
    expect(retainedUsage).toContain("raw_usage_sha256");
    const retainedOutcome = JSON.parse(await readFile(join(complete, "openai-dev-audio-outcome.json"), "utf8"));
    expect(retainedOutcome).toMatchObject({
      status: "passed",
      failure_class: "none",
      primary: true,
      input_audio: { bytes: 1_920, chunks: 2, complete: true },
      response: { requested: true, gateway_call_observed: true },
    });
    expect(canonicalJson(retainedOutcome)).not.toContain("dev-call-secret");
    const report = await reportLc4Qualification(evidenceRoot);
    expect(report).toMatchObject({
      completed_attempts: 1,
      incomplete_attempts: 0,
      maximum_total_usd: 3,
      caller_audio_bytes: LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
      maximum_response_generations: LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
    });
    await expect(runLc4Qualification({
      root: evidenceRoot,
      repositoryRoot,
      authorization: valid.authorization,
      trustRoot: valid.trustRoot,
      now: () => NOW,
      dependencies,
    })).rejects.toMatchObject({ code: "EEXIST" });
    const encodedTerminal = await readFile(join(complete, "terminal.json"), "utf8");
    for (const secret of Object.values(CREDENTIALS)) expect(encodedTerminal).not.toContain(secret);
    expect(canonicalJson(terminal)).toContain("gateway_tool_call_observed");
    expect(terminal.dev_audio_results.every((result) => result.delivery_complete && result.chunk_count === 2)).toBe(true);
  });
});
