import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  createLc4XaiFiniteManualGateDProductionAdapter,
} from "../lc4-production-provider-adapter";
import {
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "../lc4-production-provider-contract";
import { LC4_DEV_TIMEOUT_CONTRACT } from "../lc4-development-timeout-contract";
import {
  assertLc4XaiFiniteManualGateDExecutionEvidence,
  createLc4XaiFiniteManualGateDAuthorization,
  createLc4XaiFiniteManualGateDPlan,
  createLc4XaiFiniteManualGateDSigner,
  lc4XaiFiniteManualGateDExecutionReplaySha256,
  type Lc4XaiFiniteManualGateDExecutionEvidence,
} from "../lc4-xai.manual-qualification";
import type { TrialSessionConfiguration } from "../orchestrator";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
  type NormalizedRealtimeClient,
  type NormalizedRealtimeEvent,
  type Pcm16Audio,
  type RealtimeEventListener,
  type RealtimeResponsePreparation,
  type RealtimeToolResult,
  type RealtimeWireEventListener,
  type RealtimeWireObservation,
  type RealtimeWireObservationListener,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";

const production = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("../production-realtime-provider", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../production-realtime-provider")
  >();
  return {
    ...actual,
    createProductionRealtimeClient: production.createClient,
  };
});

const NOW = new Date("2026-07-28T23:00:00.000Z");
const SOURCE_COMMIT = "d".repeat(40);
const SOURCE_TREE = sha256Hex("gate-d-concrete-adapter-source-tree");
const ROOT_RESPONSE_ID = "provider-root-response";
const POST_TOOL_RESPONSE_ID = "provider-post-tool-response";
const GATEWAY_CALL_ID = "provider-gateway-call";
const API_KEY = "credential-value-never-log";
const CALLER_PCM = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
const INITIAL_PCM = new Uint8Array([11, 0, 12, 0]);
const POST_TOOL_PCM = new Uint8Array([21, 0, 22, 0]);

type Fault =
  | "none"
  | "unsolicited_vad"
  | "tool_on_foreign_response"
  | "foreign_tool_call_wire_identity"
  | "foreign_continuation_origin"
  | "post_response_before_continuation"
  | "reused_post_response"
  | "duplicate_tool_dispatch"
  | "foreign_post_audio"
  | "foreign_terminal";

function signer() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return createLc4XaiFiniteManualGateDSigner(
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
}

function gateArtifacts() {
  const authority = signer();
  const terminal = signer();
  const plan = createLc4XaiFiniteManualGateDPlan({
    gate_id: "concrete-adapter-test",
    prepared_at: NOW.toISOString(),
    source_commit: SOURCE_COMMIT,
    source_tree_sha256: SOURCE_TREE,
    harmless_clip_pcm: CALLER_PCM,
    signer: authority,
  });
  const authorization = createLc4XaiFiniteManualGateDAuthorization({
    plan,
    plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
    authorization_id: "concrete-adapter-authorization",
    authorization_nonce_sha256: sha256Hex("concrete-adapter-nonce"),
    credential_identity_sha256: sha256Hex("synthetic-credential-identity"),
    terminal_signer: terminal,
    not_before: new Date(NOW.getTime() - 1_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    authority_signer: authority,
  });
  return { plan, authorization };
}

function reference(observation: RealtimeWireObservation) {
  return Object.freeze({
    availability: "observed" as const,
    connectionEpoch: observation.connectionEpoch,
    sequence: observation.sequence,
    observationSha256: observation.observationSha256,
    payloadSha256: observation.payloadSha256,
    projectionSha256: observation.projectionSha256,
    ...(observation.identities.callIdSha256 === undefined
      ? {}
      : { callIdSha256: observation.identities.callIdSha256 }),
  });
}

/**
 * Provider-free implementation of the same NormalizedRealtimeClient contract
 * used by createProductionRealtimeClient. It emits only redacted, hash-chained
 * wire evidence and records every outbound side effect for exact assertions.
 */
class GateDProductionClientFixture implements NormalizedRealtimeClient {
  readonly provider = "xai" as const;
  state: "idle" | "ready" | "closed" = "idle";
  readonly operations: string[] = [];
  readonly commitAckTimeouts: number[] = [];
  readonly appendedAudio: Pcm16Audio[] = [];
  readonly preparations: RealtimeResponsePreparation[] = [];
  readonly submittedResults: Array<Readonly<{
    results: readonly RealtimeToolResult[];
    createResponse: boolean | undefined;
  }>> = [];
  readonly #fault: Fault;
  readonly #events = new Set<RealtimeEventListener>();
  readonly #wireEvents = new Set<RealtimeWireEventListener>();
  readonly #wireObservations = new Set<RealtimeWireObservationListener>();
  #sequence = 0;
  #predecessor: string | null = null;
  #responseCreates = 0;

  constructor(fault: Fault = "none") {
    this.#fault = fault;
  }

  async connect() {
    this.operations.push("connect");
    this.state = "ready";
  }

  close(code?: number, reason?: string) {
    this.operations.push(`close:${String(code)}:${String(reason)}`);
    this.state = "closed";
  }

  onEvent(listener: RealtimeEventListener) {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onWireEvent(listener: RealtimeWireEventListener) {
    this.#wireEvents.add(listener);
    return () => this.#wireEvents.delete(listener);
  }

  onWireObservation(listener: RealtimeWireObservationListener) {
    this.#wireObservations.add(listener);
    return () => this.#wireObservations.delete(listener);
  }

  appendInputAudio(audio: Pcm16Audio) {
    this.operations.push("append_input_audio");
    this.appendedAudio.push(Object.freeze({
      ...audio,
      data: Uint8Array.from(audio.data),
    }));
    this.#wire("outbound", "input_audio_buffer.append");
    if (this.#fault === "unsolicited_vad") {
      const observation = this.#wire(
        "inbound",
        "input_audio_buffer.speech_started",
      );
      this.#emit({
        type: "input.speech_activity",
        provider: "xai",
        receivedAtMs: observation.sequence,
        wireType: observation.wireType,
        phase: "started",
        wireObservation: reference(observation),
      });
    }
  }

  prepareResponse(preparation: RealtimeResponsePreparation) {
    this.operations.push("prepare_initial_response");
    this.preparations.push(preparation);
  }

  prepareToolContinuation(preparation: RealtimeResponsePreparation) {
    this.operations.push("prepare_tool_continuation");
    this.preparations.push(preparation);
  }

  commitInputAudio() {
    this.operations.push("commit_input_audio");
    this.#wire("outbound", "input_audio_buffer.commit");
  }

  async waitForInputAudioCommit(timeoutMs?: number) {
    this.commitAckTimeouts.push(timeoutMs ?? -1);
    this.operations.push("wait_for_commit_ack");
    if (this.#fault !== "unsolicited_vad") {
      const started = this.#wire(
        "inbound",
        "input_audio_buffer.speech_started",
      );
      this.#emit({
        type: "input.speech_activity",
        provider: "xai",
        receivedAtMs: started.sequence,
        wireType: started.wireType,
        phase: "started",
        wireObservation: reference(started),
      });
      const stopped = this.#wire(
        "inbound",
        "input_audio_buffer.speech_stopped",
      );
      this.#emit({
        type: "input.speech_activity",
        provider: "xai",
        receivedAtMs: stopped.sequence,
        wireType: stopped.wireType,
        phase: "stopped",
        wireObservation: reference(stopped),
      });
    }
    const acknowledgement = this.#wire(
      "inbound",
      "input_audio_buffer.committed",
    );
    return Object.freeze({
      provider: "xai" as const,
      connectionEpoch: 1,
      commitOrdinal: 1,
      status: "acknowledged" as const,
      wireObservation: reference(acknowledgement),
    });
  }

  createResponse() {
    this.#responseCreates += 1;
    const phase = this.#responseCreates === 1 ? "initial" : "continuation";
    this.operations.push(`create_response:${phase}`);
    this.#wire("outbound", "response.create");
    if (phase === "initial") {
      queueMicrotask(() => this.#emitInitialResponse());
      return;
    }
    const originResponseId = this.#fault === "foreign_continuation_origin"
      ? "foreign-continuation-origin"
      : ROOT_RESPONSE_ID;
    this.#emit({
      type: "tool.continuation.requested",
      provider: "xai",
      receivedAtMs: this.#sequence,
      wireType: "response.create",
      originResponseId,
      responseIdSource: "provider",
    });
    queueMicrotask(() => this.#emitPostToolResponse());
  }

  sendTurn() {
    throw new Error("Gate D must use explicit append/commit/ack/create");
  }

  submitToolResults(
    results: readonly RealtimeToolResult[],
    createResponse?: boolean,
  ) {
    this.operations.push(`submit_tool_result:${String(createResponse)}`);
    const detached = results.map((result) => Object.freeze({
      callId: result.callId,
      output: structuredClone(result.output),
    }));
    this.submittedResults.push(Object.freeze({
      results: Object.freeze(detached),
      createResponse,
    }));
    const callId = results[0]?.callId ?? "missing-call-id";
    this.#wire("outbound", "conversation.item.create", {
      callId,
    });
    this.#emit({
      type: "tool.results.submitted",
      provider: "xai",
      receivedAtMs: this.#sequence,
      wireType: "client.tool_results.submitted",
      responseId: ROOT_RESPONSE_ID,
      responseIdSource: "provider",
      callIds: results.map((result) => result.callId),
      continuationRequested: createResponse === true,
    });
  }

  #emitInitialResponse() {
    const started = this.#wire("inbound", "response.created", {
      responseId: ROOT_RESPONSE_ID,
    });
    this.#emit({
      type: "response.started",
      provider: "xai",
      receivedAtMs: started.sequence,
      wireType: started.wireType,
      responseId: ROOT_RESPONSE_ID,
      responseIdSource: "provider",
      wireObservation: reference(started),
    });
    const audio = this.#wire("inbound", "response.output_audio.delta", {
      responseId: ROOT_RESPONSE_ID,
    });
    this.#emit({
      type: "output.audio",
      provider: "xai",
      receivedAtMs: audio.sequence,
      wireType: audio.wireType,
      responseId: ROOT_RESPONSE_ID,
      audio: Uint8Array.from(INITIAL_PCM),
      format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      wireObservation: reference(audio),
    });
    if (this.#fault === "post_response_before_continuation") {
      const early = this.#wire("inbound", "response.created", {
        responseId: POST_TOOL_RESPONSE_ID,
      });
      this.#emit({
        type: "response.started",
        provider: "xai",
        receivedAtMs: early.sequence,
        wireType: early.wireType,
        responseId: POST_TOOL_RESPONSE_ID,
        responseIdSource: "provider",
        wireObservation: reference(early),
      });
    }
    this.#emitGatewayDispatch();
  }

  #emitGatewayDispatch() {
    const eventResponseId = this.#fault === "tool_on_foreign_response"
      ? "foreign-tool-response"
      : ROOT_RESPONSE_ID;
    const wireCallId = this.#fault === "foreign_tool_call_wire_identity"
      ? "foreign-wire-call"
      : GATEWAY_CALL_ID;
    this.#wire(
      "inbound",
      "response.function_call_arguments.done",
      {
        responseId: ROOT_RESPONSE_ID,
        callId: wireCallId,
      },
    );
    const observation = this.#wire("inbound", "response.done", {
      responseId: ROOT_RESPONSE_ID,
      callId: wireCallId,
    });
    const provenance = Object.freeze({
      schemaVersion: 1 as const,
      provider: "xai" as const,
      nativeCallId: GATEWAY_CALL_ID,
      nativeResponseId: eventResponseId,
      terminalWireType: observation.wireType,
    });
    const event = Object.freeze({
      type: "tool.dispatch" as const,
      provider: "xai" as const,
      receivedAtMs: observation.sequence,
      wireType: observation.wireType,
      responseId: eventResponseId,
      gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      dispatches: Object.freeze([Object.freeze({
        callId: GATEWAY_CALL_ID,
        provenance,
        request: Object.freeze({
          method: "tools/call" as const,
          params: Object.freeze({
            name: "transport.probe",
            arguments: Object.freeze({}),
            _meta: Object.freeze({
              [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: GATEWAY_CALL_ID,
              [PROVIDER_PROVENANCE_META_KEY]: provenance,
            }),
          }),
        }),
      })]),
      wireObservation: reference(observation),
    });
    this.#emit(event);
    if (this.#fault === "duplicate_tool_dispatch") this.#emit(event);
    this.#emit({
      type: "response.completed",
      provider: "xai",
      receivedAtMs: observation.sequence,
      wireType: observation.wireType,
      responseId: ROOT_RESPONSE_ID,
      responseIdSource: "provider",
      status: "completed",
      wireObservation: reference(observation),
    });
  }

  #emitPostToolResponse() {
    const responseId = this.#fault === "reused_post_response"
      ? ROOT_RESPONSE_ID
      : POST_TOOL_RESPONSE_ID;
    const started = this.#wire("inbound", "response.created", { responseId });
    this.#emit({
      type: "response.started",
      provider: "xai",
      receivedAtMs: started.sequence,
      wireType: started.wireType,
      responseId,
      responseIdSource: "provider",
      wireObservation: reference(started),
    });
    const audioResponseId = this.#fault === "foreign_post_audio"
      ? "foreign-post-audio-response"
      : responseId;
    const audio = this.#wire("inbound", "response.output_audio.delta", {
      responseId: audioResponseId,
    });
    this.#emit({
      type: "output.audio",
      provider: "xai",
      receivedAtMs: audio.sequence,
      wireType: audio.wireType,
      responseId: audioResponseId,
      audio: Uint8Array.from(POST_TOOL_PCM),
      format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      wireObservation: reference(audio),
    });
    const terminalResponseId = this.#fault === "foreign_terminal"
      ? "foreign-terminal-response"
      : responseId;
    const terminal = this.#wire("inbound", "response.done", {
      responseId: terminalResponseId,
    });
    this.#emit({
      type: "response.completed",
      provider: "xai",
      receivedAtMs: terminal.sequence,
      wireType: terminal.wireType,
      responseId: terminalResponseId,
      responseIdSource: "provider",
      status: "completed",
      wireObservation: reference(terminal),
    });
  }

  #emit(event: NormalizedRealtimeEvent) {
    for (const listener of this.#events) listener(event);
  }

  #wire(
    direction: "inbound" | "outbound",
    wireType: string,
    identities: Readonly<{
      responseId?: string;
      callId?: string;
    }> = {},
  ): RealtimeWireObservation {
    this.#sequence += 1;
    const identityHashes = Object.freeze({
      ...(identities.responseId === undefined
        ? {}
        : {
            responseIdSha256: realtimeWireIdentitySha256(
              "response",
              identities.responseId,
            ),
          }),
      ...(identities.callId === undefined
        ? {}
        : {
            callIdSha256: realtimeWireIdentitySha256(
              "call",
              identities.callId,
            ),
          }),
    });
    const projection = Object.freeze({
      phase: wireType,
      hasResponseIdentity: identities.responseId !== undefined,
      hasCallIdentity: identities.callId !== undefined,
    });
    const payloadSha256 = sha256Hex(canonicalJson({
      direction,
      wireType,
      sequence: this.#sequence,
      identityHashes,
    }));
    const core = Object.freeze({
      schemaVersion: 1 as const,
      provider: "xai" as const,
      direction,
      connectionEpoch: 1,
      sequence: this.#sequence,
      observedAtMs: this.#sequence,
      observedAtMonotonicMs: this.#sequence,
      wireType,
      payloadSha256,
      payloadBytes: 64,
      projectionSha256: realtimeWireProjectionSha256(projection),
      previousObservationSha256: this.#predecessor,
      identities: identityHashes,
      projection,
    });
    const observation = Object.freeze({
      ...core,
      observationSha256: realtimeWireObservationSha256(core),
    });
    this.#predecessor = observation.observationSha256;
    for (const listener of this.#wireObservations) listener(observation);
    return observation;
  }
}

async function executeWithFixture(fault: Fault = "none") {
  const client = new GateDProductionClientFixture(fault);
  production.createClient.mockReturnValueOnce(client);
  const artifacts = gateArtifacts();
  const adapter = createLc4XaiFiniteManualGateDProductionAdapter(API_KEY);
  const evidence = await adapter.execute({
    caller_pcm: CALLER_PCM,
    plan: artifacts.plan,
    authorization: artifacts.authorization,
  });
  return { client, evidence, plan: artifacts.plan };
}

function replayRehashed(
  evidence: Lc4XaiFiniteManualGateDExecutionEvidence,
  wireObservations:
    Lc4XaiFiniteManualGateDExecutionEvidence["wire_observations"],
): Lc4XaiFiniteManualGateDExecutionEvidence {
  const { replay_sha256: claimedReplay, ...body } = evidence;
  void claimedReplay;
  const tamperedBody = Object.freeze({
    ...body,
    wire_observations: Object.freeze(wireObservations),
  });
  return Object.freeze({
    ...tamperedBody,
    replay_sha256:
      lc4XaiFiniteManualGateDExecutionReplaySha256(tamperedBody),
  });
}

describe("LC4 Gate D concrete xAI production adapter", () => {
  beforeEach(() => {
    production.createClient.mockReset();
  });

  it("executes one exact manual two-phase gateway lifecycle without provider I/O", async () => {
    const { client, evidence } = await executeWithFixture();
    expect(
      createLc4XaiFiniteManualGateDProductionAdapter(API_KEY)[
        LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY
      ],
    ).toBe(true);

    expect(production.createClient).toHaveBeenCalledTimes(1);
    expect(production.createClient).toHaveBeenCalledWith(
      "xai",
      expect.objectContaining({
        provider: "xai",
        model: evidence.model,
        providerTools: [expect.objectContaining({
          name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        })],
      } satisfies Partial<TrialSessionConfiguration>),
      API_KEY,
      { xaiTurnBoundary: "manual_commit" },
    );
    expect(client.appendedAudio).toEqual([{
      encoding: "pcm16",
      sampleRateHz: 24_000,
      channels: 1,
      data: CALLER_PCM,
    }]);
    expect(client.operations).toEqual([
      "connect",
      "append_input_audio",
      "prepare_initial_response",
      "commit_input_audio",
      "wait_for_commit_ack",
      "create_response:initial",
      "prepare_tool_continuation",
      "submit_tool_result:false",
      "create_response:continuation",
      "close:1000:LC4 Gate D complete",
    ]);
    expect(client.commitAckTimeouts).toEqual([
      LC4_DEV_TIMEOUT_CONTRACT.maximum_provider_control_or_commit_ack_ms,
    ]);
    expect(client.submittedResults).toEqual([{
      createResponse: false,
      results: [{
        callId: GATEWAY_CALL_ID,
        output: {
          ok: true,
          tool_name: "transport.probe",
          authority: "local_capability_gateway_transport_probe",
          side_effects: false,
        },
      }],
    }]);
    expect(evidence).toMatchObject({
      provider_sessions_opened: 1,
      generation_phases: 2,
      capability_gateway_tool_roundtrips: 1,
      retries: 0,
      reconnects: 0,
      fallbacks: 0,
      caller_pcm_sha256: sha256Hex(CALLER_PCM),
      caller_pcm_appended_sha256: sha256Hex(CALLER_PCM),
      caller_pcm_byte_length: CALLER_PCM.byteLength,
      caller_pcm_appended_byte_length: CALLER_PCM.byteLength,
      initial_assistant_pcm_sha256: sha256Hex(INITIAL_PCM),
      post_tool_assistant_pcm_sha256: sha256Hex(POST_TOOL_PCM),
      capability_gateway_call_id_sha256:
        realtimeWireIdentitySha256("call", GATEWAY_CALL_ID),
      post_tool_continuation_origin_response_id_sha256:
        realtimeWireIdentitySha256("response", ROOT_RESPONSE_ID),
      post_tool_response_id_sha256:
        realtimeWireIdentitySha256("response", POST_TOOL_RESPONSE_ID),
    });
    expect(canonicalJson(evidence)).not.toContain(ROOT_RESPONSE_ID);
    expect(canonicalJson(evidence)).not.toContain(POST_TOOL_RESPONSE_ID);
    expect(canonicalJson(evidence)).not.toContain(GATEWAY_CALL_ID);
  });

  it.each([
    ["unsolicited_vad", /manual speech telemetry/u],
    ["tool_on_foreign_response", /requires one tool call/u],
    ["foreign_tool_call_wire_identity", /foreign wire identities/u],
    ["foreign_continuation_origin", /foreign root response identity/u],
    ["post_response_before_continuation", /before its exact continuation/u],
    ["reused_post_response", /reused the initial response identity/u],
    ["duplicate_tool_dispatch", /requires one tool call/u],
    ["foreign_post_audio", /unbound response identity/u],
    ["foreign_terminal", /unbound response identity/u],
  ] satisfies readonly [Fault, RegExp][])(
    "fails closed for %s without reconnect, retry, or fallback",
    async (fault, message) => {
      const client = new GateDProductionClientFixture(fault);
      production.createClient.mockReturnValueOnce(client);
      const artifacts = gateArtifacts();
      const adapter = createLc4XaiFiniteManualGateDProductionAdapter(API_KEY);

      await expect(adapter.execute({
        caller_pcm: CALLER_PCM,
        plan: artifacts.plan,
        authorization: artifacts.authorization,
      })).rejects.toThrow(message);
      expect(production.createClient).toHaveBeenCalledTimes(1);
      expect(client.operations.filter((operation) => operation === "connect"))
        .toHaveLength(1);
      expect(client.operations.at(-1))
        .toBe("close:1000:LC4 Gate D complete");
    },
  );

  it.each([
    {
      name: "cross-response initial audio",
      target: "initial_assistant_pcm_observation_sha256" as const,
      identity: "responseIdSha256" as const,
      replacement: () => realtimeWireIdentitySha256(
        "response",
        POST_TOOL_RESPONSE_ID,
      ),
      error: /identities are not continuous/u,
    },
    {
      name: "cross-call tool result",
      target: "capability_gateway_tool_result_observation_sha256" as const,
      identity: "callIdSha256" as const,
      replacement: () => realtimeWireIdentitySha256(
        "call",
        "foreign-result-call",
      ),
      error: /identities are not continuous/u,
    },
    {
      name: "cross-response post-tool terminal",
      target: "terminal_observation_sha256" as const,
      identity: "responseIdSha256" as const,
      replacement: () => realtimeWireIdentitySha256(
        "response",
        ROOT_RESPONSE_ID,
      ),
      error: /identities are not continuous/u,
    },
  ])(
    "rejects replay-rehashed $name evidence",
    async ({ target, identity, replacement, error }) => {
      const { evidence, plan } = await executeWithFixture();
      const targetObservation = evidence[target];
      const tamperedWire = evidence.wire_observations.map((observation) => (
        observation.observation_sha256 !== targetObservation
          ? observation
          : Object.freeze({
              ...observation,
              identity_hashes: Object.freeze({
                ...observation.identity_hashes,
                [identity]: replacement(),
              }),
            })
      ));
      const tampered = replayRehashed(evidence, tamperedWire);

      expect(() => assertLc4XaiFiniteManualGateDExecutionEvidence({
        evidence: tampered,
        plan,
      })).toThrow(error);
    },
  );

  it("rejects replay-rehashed reordered and duplicated lifecycle evidence", async () => {
    const { evidence, plan } = await executeWithFixture();
    const callIndex = evidence.wire_observations.findIndex((observation) => (
      observation.observation_sha256
        === evidence.capability_gateway_tool_call_observation_sha256
    ));
    const resultIndex = evidence.wire_observations.findIndex((observation) => (
      observation.observation_sha256
        === evidence.capability_gateway_tool_result_observation_sha256
    ));
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(callIndex);

    const reordered = [...evidence.wire_observations];
    [reordered[callIndex], reordered[resultIndex]] = [
      reordered[resultIndex]!,
      reordered[callIndex]!,
    ];
    expect(() => assertLc4XaiFiniteManualGateDExecutionEvidence({
      evidence: replayRehashed(evidence, reordered),
      plan,
    })).toThrow(/reordered|order/u);

    const duplicated = [
      ...evidence.wire_observations.slice(0, resultIndex),
      evidence.wire_observations[callIndex]!,
      ...evidence.wire_observations.slice(resultIndex),
    ];
    expect(() => assertLc4XaiFiniteManualGateDExecutionEvidence({
      evidence: replayRehashed(evidence, duplicated),
      plan,
    })).toThrow(/duplicate|reordered|lifecycle role|role-correct/u);
  });
});
