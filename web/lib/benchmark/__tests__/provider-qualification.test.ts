import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRecentPassingProviderQualification,
  qualifyProviders,
  recordProviderResponseToolCanary,
  type ProviderQualificationTarget,
} from "../provider-qualification";
import { canonicalJson, sha256Hex } from "../artifacts";
import { createProductionRealtimeClient } from "../production-realtime-provider";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeEventListener,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";
import type { TrialSessionConfiguration } from "../orchestrator";

const roots: string[] = [];
const H = (character: string) => character.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function exactAcknowledgement(): SessionConfigurationAcknowledgement {
  const verified = Object.freeze({ status: "verified" as const, requestedSha256: H("a"), acknowledgedSha256: H("a"), acknowledgedBy: "session.updated" as const });
  return Object.freeze({
    schemaVersion: 1,
    strictParityVerified: true,
    paidBenchmarkReady: true,
    session: verified,
    fields: Object.freeze({
      model: verified,
      voice: verified,
      instructions: verified,
      tools: verified,
      tool_choice: verified,
      input_audio: verified,
      output_audio: verified,
      turn_detection: verified,
    }),
  });
}

function geminiAcknowledgement(): SessionConfigurationAcknowledgement {
  const unverifiable = Object.freeze({ status: "unverifiable" as const, requestedSha256: H("b"), reason: "setupComplete has no fields" });
  return Object.freeze({
    schemaVersion: 1,
    strictParityVerified: false,
    paidBenchmarkReady: false,
    session: unverifiable,
    fields: Object.freeze({
      model: unverifiable,
      voice: unverifiable,
      instructions: unverifiable,
      tools: unverifiable,
      tool_choice: Object.freeze({ status: "not_requested" as const }),
      input_audio: unverifiable,
      output_audio: unverifiable,
      turn_detection: unverifiable,
    }),
  });
}

function xaiAcknowledgement(): SessionConfigurationAcknowledgement {
  const verified = Object.freeze({ status: "verified" as const, requestedSha256: H("a"), acknowledgedSha256: H("a"), acknowledgedBy: "session.updated" as const });
  const unverifiable = Object.freeze({ status: "unverifiable" as const, requestedSha256: H("b"), reason: "xAI accepted but omitted the field from session.updated" });
  return Object.freeze({
    schemaVersion: 1,
    strictParityVerified: false,
    paidBenchmarkReady: false,
    session: unverifiable,
    fields: Object.freeze({
      model: verified,
      voice: unverifiable,
      instructions: verified,
      tools: unverifiable,
      tool_choice: verified,
      input_audio: unverifiable,
      output_audio: verified,
      turn_detection: verified,
    }),
  });
}

function configuration(
  provider: "openai" | "gemini" | "xai",
  model: string,
  withTool = false,
): TrialSessionConfiguration {
  return Object.freeze({
    provider,
    model,
    conditionId: "raw-memory",
    instructions: `qualification-${provider}`,
    initialPrompt: "qualification",
    renderedCapabilitySnapshot: "<capability_snapshot>{}</capability_snapshot>",
    providerTools: Object.freeze(withTool ? [Object.freeze({
      type: "function" as const,
      name: "capability_gateway",
      description: "Invoke an authorized local capability.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    })] : []),
    conditionHash: H("c"),
    inputAudioFormat: Object.freeze({ encoding: "pcm16", sampleRateHz: provider === "gemini" ? 16_000 : 24_000, channels: 1 }),
    audioDeliveryProfile: Object.freeze({ schemaVersion: 1, chunkMs: 20, pace: "realtime" }),
    audioDeliveryProfileHash: H("d"),
  });
}

function targets(withTool = false): readonly ProviderQualificationTarget[] {
  return Object.freeze([
    Object.freeze({ provider: "openai", model: "gpt-realtime-test", configuration: configuration("openai", "gpt-realtime-test", withTool) }),
    Object.freeze({ provider: "gemini", model: "gemini-live-test", configuration: configuration("gemini", "gemini-live-test", withTool) }),
    Object.freeze({ provider: "xai", model: "grok-voice-test", configuration: configuration("xai", "grok-voice-test", withTool) }),
  ]);
}

class QualificationClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly sessionConfigurationAcknowledgement;
  readonly #listeners = new Set<RealtimeEventListener>();
  readonly #error: Error | null;
  readonly #markReady: boolean;
  closeCalls = 0;
  forbiddenCalls = 0;

  constructor(target: ProviderQualificationTarget, error: Error | null = null, markReady = true) {
    this.provider = target.provider;
    this.#error = error;
    this.#markReady = markReady;
    this.sessionConfigurationAcknowledgement = target.provider === "gemini"
      ? geminiAcknowledgement()
      : target.provider === "xai"
        ? xaiAcknowledgement()
        : exactAcknowledgement();
  }

  async connect(): Promise<void> {
    if (this.#error) throw this.#error;
    if (this.#markReady) this.state = "ready";
    const event = Object.freeze({
      type: "session.ready" as const,
      provider: this.provider,
      receivedAtMs: 1,
      wireType: this.provider === "gemini" ? "setupComplete" : "session.updated",
      configuration: this.sessionConfigurationAcknowledgement,
    });
    for (const listener of this.#listeners) listener(event as NormalizedRealtimeEvent);
  }
  close(): void { this.closeCalls += 1; this.state = "closed"; }
  onEvent(listener: RealtimeEventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent(): () => void { return () => undefined; }
  appendInputAudio(): void { this.forbiddenCalls += 1; throw new Error("qualification sent caller audio"); }
  prepareResponse(): void { this.forbiddenCalls += 1; throw new Error("qualification prepared a response"); }
  commitInputAudio(): void { this.forbiddenCalls += 1; throw new Error("qualification committed caller audio"); }
  createResponse(): void { this.forbiddenCalls += 1; throw new Error("qualification generated a response"); }
  sendTurn(): void { this.forbiddenCalls += 1; throw new Error("qualification sent a turn"); }
  submitToolResults(): void { this.forbiddenCalls += 1; throw new Error("qualification submitted tool results"); }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hacc-provider-qualification-"));
  roots.push(root);
  const created: QualificationClient[] = [];
  const input = {
    root,
    protocolId: "HACC-LC3-test",
    planSha256: H("e"),
    sourceCommit: H("f").slice(0, 40),
    targets: targets(),
    credentials: { openai: "openai-secret-test", gemini: "gemini-secret-test", xai: "xai-secret-test" },
    createClient: (target: ProviderQualificationTarget) => {
      const client = new QualificationClient(target);
      created.push(client);
      return client;
    },
    now: () => new Date("2026-07-21T18:00:00.000Z"),
  } as const;
  return { root, created, input };
}

describe("provider qualification", () => {
  it("handshakes every exact target, retains only sanitized hashes, and admits a bound paid run", async () => {
    const prepared = await setup();
    const artifact = await qualifyProviders(prepared.input);
    expect(artifact.status).toBe("passed");
    expect(artifact.results).toHaveLength(3);
    expect(artifact.results.find((result) => result.provider === "gemini")).toMatchObject({
      code: "setup_accepted_without_field_echo",
      acknowledgementMode: "setup_complete_no_field_echo",
    });
    expect(artifact.results.find((result) => result.provider === "xai")).toMatchObject({
      code: "configuration_accepted_partial_echo",
      acknowledgementMode: "partial_provider_echo",
    });
    expect(prepared.created).toHaveLength(3);
    expect(prepared.created.every((client) => client.closeCalls === 1 && client.forbiddenCalls === 0)).toBe(true);

    const names = await readdir(join(prepared.root, "qualifications"));
    expect(names).toHaveLength(1);
    const encoded = await readFile(join(prepared.root, "qualifications", names[0]!), "utf8");
    expect(encoded).not.toContain("secret-test");
    expect(encoded).not.toContain("qualification-openai");
    await expect(assertRecentPassingProviderQualification({
      root: prepared.root,
      protocolId: prepared.input.protocolId,
      planSha256: prepared.input.planSha256,
      sourceCommit: prepared.input.sourceCommit,
      targets: prepared.input.targets,
      credentials: prepared.input.credentials,
      now: prepared.input.now,
    })).resolves.toMatchObject({ artifactSha256: artifact.artifactSha256 });
  });

  it("retains failed authentication attempts immutably and refuses the paid gate", async () => {
    const prepared = await setup();
    const artifact = await qualifyProviders({
      ...prepared.input,
      qualificationId: "failed-auth-attempt",
      createClient: (target) => new QualificationClient(
        target,
        target.provider === "openai" ? new Error("HTTP 401 invalid API key") : null,
      ),
    });
    expect(artifact.status).toBe("failed");
    expect(artifact.results.find((result) => result.provider === "openai")?.code).toBe("unauthenticated");
    await expect(assertRecentPassingProviderQualification({
      root: prepared.root,
      protocolId: prepared.input.protocolId,
      planSha256: prepared.input.planSha256,
      sourceCommit: prepared.input.sourceCommit,
      targets: prepared.input.targets,
      credentials: prepared.input.credentials,
      now: prepared.input.now,
    })).rejects.toThrow("paid run requires a recent passing provider qualification");
    const names = await readdir(join(prepared.root, "qualifications"));
    expect(names).toHaveLength(1);
    const original = await readFile(join(prepared.root, "qualifications", names[0]!), "utf8");
    await expect(qualifyProviders({
      ...prepared.input,
      qualificationId: "failed-auth-attempt",
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(prepared.root, "qualifications", names[0]!), "utf8")).toBe(original);
    const recovered = await qualifyProviders({
      ...prepared.input,
      qualificationId: "recovered-attempt",
    });
    expect(recovered.status).toBe("passed");
    expect(await readFile(join(prepared.root, "qualifications", names[0]!), "utf8")).toBe(original);
    expect(await readdir(join(prepared.root, "qualifications"))).toHaveLength(2);
    await expect(assertRecentPassingProviderQualification({
      root: prepared.root,
      protocolId: prepared.input.protocolId,
      planSha256: prepared.input.planSha256,
      sourceCommit: prepared.input.sourceCommit,
      targets: prepared.input.targets,
      credentials: prepared.input.credentials,
      now: prepared.input.now,
    })).resolves.toMatchObject({ qualificationId: "recovered-attempt" });
  });

  it("rejects stale and differently bound passing qualifications", async () => {
    const prepared = await setup();
    await qualifyProviders(prepared.input);
    const gate = (overrides: Partial<Parameters<typeof assertRecentPassingProviderQualification>[0]> = {}) => (
      assertRecentPassingProviderQualification({
        root: prepared.root,
        protocolId: prepared.input.protocolId,
        planSha256: prepared.input.planSha256,
        sourceCommit: prepared.input.sourceCommit,
        targets: prepared.input.targets,
        credentials: prepared.input.credentials,
        now: () => new Date("2026-07-21T18:31:00.001Z"),
        ...overrides,
      })
    );
    await expect(gate()).rejects.toThrow("paid run requires");
    await expect(gate({ now: prepared.input.now, planSha256: H("9") })).rejects.toThrow("paid run requires");
    const altered = [...prepared.input.targets];
    altered[0] = Object.freeze({
      ...altered[0]!,
      model: "different-model",
      configuration: configuration("openai", "different-model"),
    });
    await expect(gate({ now: prepared.input.now, targets: altered })).rejects.toThrow("paid run requires");
    await expect(gate({
      now: prepared.input.now,
      credentials: { ...prepared.input.credentials, openai: "rotated-openai-secret" },
    })).rejects.toThrow("paid run requires");
  });

  it("records missing credentials without constructing a provider client", async () => {
    const prepared = await setup();
    let calls = 0;
    const artifact = await qualifyProviders({
      ...prepared.input,
      credentials: { gemini: "gemini-secret-test", xai: "xai-secret-test" },
      createClient: (target) => { calls += 1; return new QualificationClient(target); },
    });
    expect(artifact.status).toBe("failed");
    expect(artifact.results.find((result) => result.provider === "openai")?.code).toBe("credential_missing");
    expect(calls).toBe(2);
  });

  it("does not trust a connect promise when the client never reaches ready", async () => {
    const prepared = await setup();
    const artifact = await qualifyProviders({
      ...prepared.input,
      createClient: (target) => new QualificationClient(target, null, target.provider !== "openai"),
    });
    expect(artifact.status).toBe("failed");
    expect(artifact.results.find((result) => result.provider === "openai")?.code).toBe("handshake_failed");
  });

  it("refuses a production client whose provider or model differs from the hashed configuration", () => {
    expect(() => createProductionRealtimeClient(
      "openai",
      configuration("xai", "gpt-realtime-2.1"),
      "openai-secret-test",
    )).toThrow("provider differs");
    expect(() => createProductionRealtimeClient(
      "openai",
      configuration("openai", "not-the-pinned-model"),
      "openai-secret-test",
    )).toThrow("model differs");
  });

  it("requires a separate paid response/tool-call canary when setup does not echo tool schemas", async () => {
    const prepared = await setup();
    const canaryTargets = targets(true);
    const qualification = await qualifyProviders({ ...prepared.input, targets: canaryTargets });
    expect(qualification.status).toBe("conditional");
    expect(qualification.results.find((result) => result.provider === "openai")?.toolSchemaVerification)
      .toBe("verified_by_provider_echo");
    expect(qualification.results.find((result) => result.provider === "gemini")?.toolSchemaVerification)
      .toBe("requires_paid_response_canary");
    expect(qualification.results.find((result) => result.provider === "xai")?.toolSchemaVerification)
      .toBe("requires_paid_response_canary");
    const gate = () => assertRecentPassingProviderQualification({
      root: prepared.root,
      protocolId: prepared.input.protocolId,
      planSha256: prepared.input.planSha256,
      sourceCommit: prepared.input.sourceCommit,
      targets: canaryTargets,
      credentials: prepared.input.credentials,
      now: prepared.input.now,
    });
    await expect(gate()).rejects.toThrow("paid response/tool-call canary");

    const toolSchemaSha256 = sha256Hex(
      `harshas-amazing-call-center/provider-tool-schema/v1\n${canonicalJson(canaryTargets[0]!.configuration.providerTools)}`,
    );
    const timestamp = prepared.input.now().toISOString();
    const canary = await recordProviderResponseToolCanary({
      root: prepared.root,
      protocolId: prepared.input.protocolId,
      planSha256: prepared.input.planSha256,
      sourceCommit: prepared.input.sourceCommit,
      targets: canaryTargets,
      credentials: prepared.input.credentials,
      attemptedAt: timestamp,
      completedAt: timestamp,
      canaryId: "paid-tool-call-canary",
      results: canaryTargets.map((target) => Object.freeze({
        provider: target.provider,
        model: target.model,
        toolSchemaSha256,
        attemptedAt: timestamp,
        completedAt: timestamp,
        status: "passed" as const,
        code: "gateway_tool_call_observed" as const,
        callerAudioBytes: 0 as const,
        responseGenerationEvidenceSha256: H("7"),
        providerToolCallEvidenceSha256: H("8"),
      })),
    });
    expect(canary).toMatchObject({
      status: "passed",
      probeScope: "paid_response_generation_tool_call_no_caller_audio",
    });
    await expect(gate()).resolves.toMatchObject({ status: "conditional" });
  });
});
