import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLogger } from "../lib/logger.js";
import { BridgeSession } from "../lib/session.js";
import {
  ACCOUNT_SID,
  CALL_SID,
  EVENT_CAPABILITY_TOKEN,
  FakeJournal,
  FakeSocket,
  MCP_CAPABILITY_TOKEN,
  RENEWAL_CAPABILITY_TOKEN,
  STREAM_SID,
  bridgeConfig,
  connected,
  mark,
  media,
  providerConfiguration,
  start,
  waitFor,
} from "./support.js";

function quietLogger() {
  const sink = { log() {}, warn() {}, error() {} };
  return createLogger({ sink, now: () => "2026-07-16T00:00:00.000Z" });
}

function logicalClock(startMs) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map();
  const timeout = (callback, delay = 0) => {
    const handle = {
      id: nextId += 1,
      dueAt: nowMs + Math.max(0, Number(delay) || 0),
      callback,
      unref() { return this; },
    };
    timers.set(handle.id, handle);
    return handle;
  };
  const clear = (handle) => {
    if (handle?.id !== undefined) timers.delete(handle.id);
  };
  const settle = async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };
  return {
    now: () => nowMs,
    setTimeout: timeout,
    clearTimeout: clear,
    // Maintenance is irrelevant to these deterministic authority-clock tests;
    // an inert interval avoids replaying 150,000 drain ticks over 25 minutes.
    setInterval: () => ({ unref() { return this; } }),
    clearInterval() {},
    async advance(ms) {
      const target = nowMs + ms;
      while (true) {
        const due = [...timers.values()]
          .filter((timer) => timer.dueAt <= target)
          .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
        if (!due) break;
        timers.delete(due.id);
        nowMs = due.dueAt;
        due.callback();
        await settle();
      }
      nowMs = target;
      await settle();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bootstrapFixture({
  config = bridgeConfig(),
  requested = providerConfiguration(),
  now = Date.now(),
} = {}) {
  const expiresAt = new Date(now + 30 * 60_000).toISOString();
  const refreshAfter = new Date(Date.parse(expiresAt) - 5 * 60_000).toISOString();
  return {
    sessionId: "bridge-test-session",
    bridgeInstanceId: config.instanceId,
    callId: "application-call-1",
    connection: {
      account_sid: ACCOUNT_SID,
      call_sid: CALL_SID,
      stream_sid: STREAM_SID,
      mode: "agent",
    },
    ...requested,
    eventCapability: {
      token: EVENT_CAPABILITY_TOKEN,
      audience: "telephony_events",
      purpose: "event_journal",
      expiresAt,
    },
    mcpCapability: {
      token: MCP_CAPABILITY_TOKEN,
      audience: "bridge_mcp",
      purpose: "tool_invocation",
      expiresAt,
    },
    renewalCapability: {
      token: RENEWAL_CAPABILITY_TOKEN,
      audience: "bridge_refresh",
      purpose: "capability_rotation",
      expiresAt,
    },
    activeCatalogAuthority: {
      catalogDigest: "a".repeat(64),
      capabilityEpoch: 0,
    },
    rotation: 0,
    rotationEndpoint: "/api/telephony/bridge/capabilities/rotate",
    refreshAfter,
    expiresAt,
  };
}

function harness({
  config = bridgeConfig(),
  authorityCall,
  authorityFactory,
  bootstrapError,
  bootstrapResult,
  journal = new FakeJournal(),
  sessionOptions = {},
} = {}) {
  const twilio = new FakeSocket();
  const provider = new FakeSocket({ readyState: 0 });
  const requested = providerConfiguration();
  const authorityCalls = [];
  let authorityCapability;
  let journalCapability;
  let journalSessionId;
  const session = new BridgeSession({
    twilioSocket: twilio,
    config,
    bootstrapClient: {
    createSession: async () => {
      if (bootstrapError) throw bootstrapError;
      if (typeof bootstrapResult === "function") return bootstrapResult();
      if (bootstrapResult) return bootstrapResult;
      const clockNow = typeof sessionOptions.now === "function" ? sessionOptions.now() : Date.now();
      return bootstrapFixture({ config, requested, now: clockNow });
      },
    },
    createProviderSocket: () => provider,
    createAuthorityClient: authorityFactory ?? ((capability) => {
      authorityCapability = capability;
      return {
        callCapabilityGateway: async (call) => {
          authorityCalls.push(call);
          const result = authorityCall
            ? await authorityCall(call)
            : { output: { ok: true, membership: "gold" }, isError: false };
          return {
            ...result,
            activeCatalogAuthority: result.activeCatalogAuthority ?? {
              ...call.activeCatalogAuthority,
              availability: "active",
            },
          };
        },
      };
    }),
    createJournal: ({ capability, sessionId }) => {
      journalCapability = capability;
      journalSessionId = sessionId;
      return journal;
    },
    logger: quietLogger(),
    randomId: () => "00000000-0000-4000-8000-000000000001",
    ...sessionOptions,
  });
  return {
    session,
    twilio,
    provider,
    requested,
    journal,
    authorityCalls,
    get authorityCapability() { return authorityCapability; },
    get journalCapability() { return journalCapability; },
    get journalSessionId() { return journalSessionId; },
  };
}

function completedToolOutput({ responseId, itemId, callId, argumentsText, name = "capability_gateway" }) {
  return {
    type: "response.done",
    response: {
      id: responseId,
      status: "completed",
      output: [{
        type: "function_call",
        id: itemId,
        call_id: callId,
        name,
        arguments: argumentsText,
        status: "completed",
      }],
    },
  };
}

async function begin(h, { withMedia = false } = {}) {
  h.twilio.receive(connected());
  h.twilio.receive(start());
  if (withMedia) h.twilio.receive(media(2));
  await waitFor(
    () => h.session.state === "connecting_provider" || h.session.state === "closed",
    "provider construction",
  );
  assert.equal(h.session.state, "connecting_provider", JSON.stringify(h.journal.events));
  h.provider.open();
  await waitFor(() => h.session.state === "awaiting_provider_ack", "session update send");
}

async function ready(h, options) {
  await begin(h, options);
  const acknowledged = structuredClone(h.requested.sessionUpdate.session);
  acknowledged.id = "provider-session-1";
  h.provider.receive({ type: "session.updated", session: acknowledged });
  await waitFor(() => h.session.state === "ready", "provider readiness");
}

describe("BridgeSession", () => {
  it("holds bounded caller audio until an exact provider session acknowledgement", async () => {
    const h = harness();
    await begin(h, { withMedia: true });

    assert.deepEqual(h.provider.sent.map((event) => event.type), ["session.update"]);
    const acknowledged = structuredClone(h.requested.sessionUpdate.session);
    acknowledged.id = "provider-session-1";
    h.provider.receive({ type: "session.updated", session: acknowledged });
    await waitFor(() => h.provider.sent.length === 3, "queued media drain");

    assert.deepEqual(h.provider.sent.map((event) => event.type), [
      "session.update",
      "input_audio_buffer.append",
      "response.create",
    ]);
    assert.equal(h.session.state, "ready");
    assert.equal(h.journalCapability.token, EVENT_CAPABILITY_TOKEN);
    assert.equal(h.journalCapability.audience, "telephony_events");
    assert.equal(h.journalSessionId, STREAM_SID);
    assert.equal(h.authorityCapability.token, MCP_CAPABILITY_TOKEN);
    assert.equal(h.authorityCapability.audience, "bridge_mcp");
    assert.notEqual(h.journalCapability.token, h.authorityCapability.token);
    assert(h.journal.events.some((event) => event.type === "provider.ready"));
    await h.session.shutdown("test_complete");
  });

  it("fails closed on Twilio sequence gaps before provider traffic can escape", async () => {
    const h = harness();
    h.twilio.receive(connected());
    h.twilio.receive(start());
    h.twilio.receive(media(3));

    await waitFor(() => h.session.state === "closed", "protocol shutdown");
    assert.equal(h.twilio.closeCalls[0].code, 1008);
    assert.equal(h.provider.sent.length, 0);
  });

  it("bounds pre-readiness input and closes rather than accumulating media", async () => {
    const h = harness({
      config: bridgeConfig({ limits: { inputQueueMessages: 1, inputQueueBytes: 64 * 1024 } }),
    });
    h.twilio.receive(connected());
    h.twilio.receive(start());
    h.twilio.receive(media(2));
    h.twilio.receive(media(3));

    await waitFor(() => h.session.state === "closed", "backpressure shutdown");
    assert.equal(h.twilio.closeCalls[0].code, 1011);
    assert.equal(h.provider.sent.length, 0);
  });

  it("tracks played audio per item and truncates the current item at mark-derived time", async () => {
    const h = harness();
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_audio", status: "in_progress" } });
    h.provider.receive({
      type: "response.output_audio.delta",
      response_id: "r_audio",
      item_id: "item_a",
      delta: Buffer.alloc(1_600, 1).toString("base64"),
    });
    h.provider.receive({
      type: "response.output_audio.delta",
      response_id: "r_audio",
      item_id: "item_b",
      delta: Buffer.alloc(1_600, 2).toString("base64"),
    });

    const marks = h.twilio.sent.filter((event) => event.event === "mark").map((event) => event.mark.name);
    assert.deepEqual(marks, ["hacc_0_1", "hacc_0_2", "hacc_0_3", "hacc_0_4"]);
    h.twilio.receive(mark(2, "hacc_0_3"));
    h.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "caller_1", audio_start_ms: 100 });

    const cancel = h.provider.sent.find((event) => event.type === "response.cancel");
    const truncate = h.provider.sent.find((event) => event.type === "conversation.item.truncate");
    assert.equal(cancel.response_id, "r_audio");
    assert.deepEqual(truncate, {
      type: "conversation.item.truncate",
      item_id: "item_b",
      content_index: 0,
      audio_end_ms: 100,
    });
    assert(h.twilio.sent.some((event) => event.event === "clear"));

    h.twilio.receive(mark(3, "hacc_0_2"));
    assert.equal(h.session.state, "ready");
    const barge = h.journal.events.find((event) => event.type === "playback.barge_in");
    assert.equal(barge.payload.output_item_id, "item_b");
    assert.equal(barge.payload.acknowledged_played_ms, 100);
    await h.session.shutdown("test_complete");
  });

  it("repairs every partially heard or unheard item when one response queues multiple audio items", async () => {
    const h = harness();
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_multi", status: "in_progress" } });
    h.provider.receive({
      type: "response.output_audio.delta",
      response_id: "r_multi",
      item_id: "item_first",
      delta: Buffer.alloc(1_600, 1).toString("base64"),
    });
    h.provider.receive({
      type: "response.output_audio.delta",
      response_id: "r_multi",
      item_id: "item_second",
      delta: Buffer.alloc(800, 2).toString("base64"),
    });

    h.twilio.receive(mark(2, "hacc_0_1"));
    h.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "caller_multi", audio_start_ms: 100 });

    const cancellation = h.provider.sent.find((event) => event.type === "response.cancel");
    const truncations = h.provider.sent.filter((event) => event.type === "conversation.item.truncate");
    assert.equal(cancellation.response_id, "r_multi");
    assert.deepEqual(truncations, [
      {
        type: "conversation.item.truncate",
        item_id: "item_first",
        content_index: 0,
        audio_end_ms: 100,
      },
      {
        type: "conversation.item.truncate",
        item_id: "item_second",
        content_index: 0,
        audio_end_ms: 0,
      },
    ]);
    const barge = h.journal.events.find((event) => event.type === "playback.barge_in");
    assert.deepEqual(barge.payload.truncations, [
      {
        response_id: "r_multi",
        item_id: "item_first",
        generated_ms: 200,
        acknowledged_played_ms: 100,
      },
      {
        response_id: "r_multi",
        item_id: "item_second",
        generated_ms: 100,
        acknowledged_played_ms: 0,
      },
    ]);
    assert.equal(h.session.snapshot().pending_truncations, 2);
    await h.session.shutdown("test_complete");
  });

  it("retires and repairs tool calls when cancellation races a provider completion", async () => {
    let authorityCount = 0;
    const h = harness({ authorityCall: async () => { authorityCount += 1; return { output: { ok: true }, isError: false }; } });
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_cancel", status: "in_progress" } });
    h.provider.receive({
      type: "response.function_call_arguments.done",
      response_id: "r_cancel",
      item_id: "tool_item",
      call_id: "tool_call_1",
      name: "capability_gateway",
      arguments: '{"tool_name":"renew_membership","arguments":{}}',
    });
    h.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "caller_2" });

    const repair = h.provider.sent.find((event) => event.type === "conversation.item.create");
    assert.equal(repair.item.call_id, "tool_call_1");
    assert.match(repair.item.output, /interrupted_before_execution/);
    assert(h.journal.events.some((event) => event.type === "tool.batch_retired"));

    h.provider.receive(completedToolOutput({
      responseId: "r_cancel",
      itemId: "tool_item",
      callId: "tool_call_1",
      argumentsText: '{"tool_name":"renew_membership","arguments":{}}',
    }));
    await waitFor(() => h.session.state === "closed", "late completion rejection");
    assert.equal(authorityCount, 0);
  });

  it("executes only a completed provider batch through the scoped gateway and continues once", async () => {
    const h = harness();
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_tool", status: "in_progress" } });
    h.provider.receive({
      type: "response.function_call_arguments.done",
      response_id: "r_tool",
      item_id: "tool_item",
      call_id: "tool_call_2",
      name: "capability_gateway",
      arguments: '{"tool_name":"membership_lookup","arguments":{}}',
    });
    assert.equal(h.authorityCalls.length, 0);
    h.provider.receive(completedToolOutput({
      responseId: "r_tool",
      itemId: "tool_item",
      callId: "tool_call_2",
      argumentsText: '{"tool_name":"membership_lookup","arguments":{}}',
    }));
    await waitFor(
      () => h.provider.sent.some((event) => event.type === "conversation.item.create") || h.session.state === "closed",
      "tool output",
    );
    assert.notEqual(h.session.state, "closed", JSON.stringify(h.journal.events));

    assert.equal(h.authorityCapability.token, MCP_CAPABILITY_TOKEN);
    assert.deepEqual(h.authorityCalls, [{
      provider: "openai",
      callId: "tool_call_2",
      responseId: "r_tool",
      itemId: "tool_item",
      name: "capability_gateway",
      arguments: { tool_name: "membership_lookup", arguments: {} },
      activeCatalogAuthority: {
        catalogDigest: "a".repeat(64),
        capabilityEpoch: 0,
      },
    }]);
    const continuation = h.provider.sent.slice(-2);
    assert.deepEqual(continuation.map((event) => event.type), ["conversation.item.create", "response.create"]);
    assert.deepEqual(JSON.parse(continuation[0].item.output), { ok: true, membership: "gold" });
    await h.session.shutdown("test_complete");
  });

  it("executes a multi-tool batch serially so each flow transition can authorize the next call", async () => {
    let resolveFirst;
    let firstTransitionCommitted = false;
    let secondObservedTransition = false;
    const h = harness({
      authorityCall: async (call) => {
        if (call.arguments.tool_name === "classify_intent") {
          return new Promise((resolve) => {
            resolveFirst = () => {
              firstTransitionCommitted = true;
              resolve({ output: { ok: true, flow: "membership" }, isError: false });
            };
          });
        }
        secondObservedTransition = firstTransitionCommitted;
        return { output: { ok: true, expires_at: "2027-01-01" }, isError: false };
      },
    });
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_serial", status: "in_progress" } });
    const calls = [
      {
        itemId: "classify_item",
        callId: "classify_call",
        argumentsText: '{"tool_name":"classify_intent","arguments":{"utterance":"membership"}}',
      },
      {
        itemId: "lookup_item",
        callId: "lookup_call",
        argumentsText: '{"tool_name":"lookup_membership","arguments":{}}',
      },
    ];
    for (const call of calls) {
      h.provider.receive({
        type: "response.function_call_arguments.done",
        response_id: "r_serial",
        item_id: call.itemId,
        call_id: call.callId,
        name: "capability_gateway",
        arguments: call.argumentsText,
      });
    }
    h.provider.receive({
      type: "response.done",
      response: {
        id: "r_serial",
        status: "completed",
        output: calls.map((call) => ({
          type: "function_call",
          id: call.itemId,
          call_id: call.callId,
          name: "capability_gateway",
          arguments: call.argumentsText,
          status: "completed",
        })),
      },
    });

    await waitFor(() => h.authorityCalls.length === 1, "first progressive flow operation");
    assert.equal(h.authorityCalls[0].arguments.tool_name, "classify_intent");
    resolveFirst();
    await waitFor(() => h.authorityCalls.length === 2, "second progressive flow operation");
    assert.equal(h.authorityCalls[1].arguments.tool_name, "lookup_membership");
    assert.equal(secondObservedTransition, true);
    await waitFor(
      () => h.provider.sent.filter((event) => event.type === "conversation.item.create").length >= 2,
      "ordered tool outputs",
    );
    const outputs = h.provider.sent
      .filter((event) => event.type === "conversation.item.create")
      .slice(-2)
      .map((event) => event.item.call_id);
    assert.deepEqual(outputs, ["classify_call", "lookup_call"]);
    await h.session.shutdown("test_complete");
  });

  it("pins one catalog snapshot per terminal batch and commits only the last verified envelope", async () => {
    const initial = { catalogDigest: "a".repeat(64), capabilityEpoch: 0 };
    const advanced = { catalogDigest: "b".repeat(64), capabilityEpoch: 1, availability: "active" };
    const blocked = { catalogDigest: "c".repeat(64), capabilityEpoch: 2, availability: "blocked" };
    const observedCatalogs = [];
    let dispatches = 0;
    const envelope = (outcome, authority) => ({
      schema_version: 1,
      outcome,
      active_capability_catalog: {
        schema_version: 1,
        availability: authority.availability ?? "active",
        runtime_digest: "d".repeat(64),
        capability_epoch: authority.capabilityEpoch,
        state_revision: authority.capabilityEpoch,
        scope: { status: "active", topic: "membership", step: "membership.lookup", attempt: 1 },
        active_context: {},
        catalog_digest: authority.catalogDigest,
        tools: [],
      },
    });
    const h = harness({
      authorityCall: async (call) => {
        dispatches += 1;
        observedCatalogs.push(call.activeCatalogAuthority);
        if (dispatches === 1) {
          return { output: envelope({ ok: true, classified: "membership" }, advanced), isError: false, activeCatalogAuthority: advanced };
        }
        if (dispatches === 2) {
          return {
            output: envelope({ error: "stale catalog", code: "stale_active_capability_catalog" }, advanced),
            isError: true,
            activeCatalogAuthority: advanced,
          };
        }
        return { output: envelope({ ok: true }, blocked), isError: false, activeCatalogAuthority: blocked };
      },
    });
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_catalog_batch", status: "in_progress" } });
    const calls = [
      { itemId: "catalog_item_1", callId: "catalog_call_1", toolName: "classify" },
      { itemId: "catalog_item_2", callId: "catalog_call_2", toolName: "lookup_membership" },
    ];
    for (const call of calls) {
      h.provider.receive({
        type: "response.function_call_arguments.done",
        response_id: "r_catalog_batch",
        item_id: call.itemId,
        call_id: call.callId,
        name: "capability_gateway",
        arguments: JSON.stringify({ tool_name: call.toolName, arguments: {} }),
      });
    }
    h.provider.receive({
      type: "response.done",
      response: {
        id: "r_catalog_batch",
        status: "completed",
        output: calls.map((call) => ({
          type: "function_call",
          id: call.itemId,
          call_id: call.callId,
          name: "capability_gateway",
          arguments: JSON.stringify({ tool_name: call.toolName, arguments: {} }),
          status: "completed",
        })),
      },
    });
    await waitFor(() => dispatches === 2, "catalog-pinned batch settlement");
    assert.deepEqual(observedCatalogs, [initial, initial]);
    assert.equal(h.session.snapshot().active_catalog_digest, advanced.catalogDigest);
    assert.equal(h.session.snapshot().active_catalog_capability_epoch, 1);
    const batchOutputs = h.provider.sent
      .filter((event) => event.type === "conversation.item.create")
      .slice(-2)
      .map((event) => JSON.parse(event.item.output));
    assert.equal(batchOutputs[0].outcome.classified, "membership");
    assert.equal(batchOutputs[1].outcome.code, "stale_active_capability_catalog");

    h.provider.receive({ type: "response.created", response: { id: "r_catalog_block", status: "in_progress" } });
    h.provider.receive(completedToolOutput({
      responseId: "r_catalog_block",
      itemId: "catalog_block_item",
      callId: "catalog_block_call",
      argumentsText: '{"tool_name":"get_flow_state","arguments":{}}',
    }));
    await waitFor(
      () => h.session.snapshot().active_catalog_availability === "blocked",
      "blocked catalog result",
    );
    assert.deepEqual(observedCatalogs[2], {
      catalogDigest: advanced.catalogDigest,
      capabilityEpoch: advanced.capabilityEpoch,
      availability: "active",
    });
    assert.equal(h.session.snapshot().active_catalog_availability, "blocked");

    h.provider.receive({ type: "response.created", response: { id: "r_after_block", status: "in_progress" } });
    h.provider.receive(completedToolOutput({
      responseId: "r_after_block",
      itemId: "after_block_item",
      callId: "after_block_call",
      argumentsText: '{"tool_name":"get_flow_state","arguments":{}}',
    }));
    await waitFor(() => h.session.state === "closed", "blocked catalog rejection");
    assert.equal(dispatches, 3, "blocked authority never reaches MCP");
    assert(h.journal.events.some((event) => event.type === "session.failure" && event.payload.code === "active_catalog_blocked"));
  });

  it("suppresses a stale continuation when caller speech races an authorized tool result", async () => {
    let resolveAuthority;
    const h = harness({
      authorityCall: () => new Promise((resolve) => { resolveAuthority = resolve; }),
    });
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_tool_race", status: "in_progress" } });
    h.provider.receive({
      type: "response.function_call_arguments.done",
      response_id: "r_tool_race",
      item_id: "tool_race_item",
      call_id: "tool_race",
      name: "capability_gateway",
      arguments: '{"tool_name":"lookup_member","arguments":{}}',
    });
    h.provider.receive(completedToolOutput({
      responseId: "r_tool_race",
      itemId: "tool_race_item",
      callId: "tool_race",
      argumentsText: '{"tool_name":"lookup_member","arguments":{}}',
    }));
    await waitFor(() => h.authorityCalls.length === 1, "tool authorization");
    const responsesBeforeRace = h.provider.sent.filter((event) => event.type === "response.create").length;

    h.provider.receive({ type: "input_audio_buffer.speech_started", item_id: "caller_after_tool" });
    resolveAuthority({ output: { ok: true }, isError: false });
    await waitFor(
      () => h.provider.sent.some((event) => event.type === "conversation.item.create" && event.item.call_id === "tool_race"),
      "raced tool output",
    );

    assert.equal(
      h.provider.sent.filter((event) => event.type === "response.create").length,
      responsesBeforeRace,
    );
    assert(h.journal.events.some((event) => event.type === "tool.response_create_suppressed"));
    await h.session.shutdown("test_complete");
  });

  it("records an explicit unknown authority outcome before deadline-bounded shutdown", async () => {
    const h = harness({
      config: bridgeConfig({ limits: { shutdownMs: 20 } }),
      authorityCall: () => new Promise(() => {}),
    });
    await ready(h);
    h.provider.receive({ type: "response.created", response: { id: "r_hung", status: "in_progress" } });
    h.provider.receive({
      type: "response.function_call_arguments.done",
      response_id: "r_hung",
      item_id: "tool_hung_item",
      call_id: "tool_hung",
      name: "capability_gateway",
      arguments: '{"tool_name":"slow_lookup","arguments":{}}',
    });
    h.provider.receive(completedToolOutput({
      responseId: "r_hung",
      itemId: "tool_hung_item",
      callId: "tool_hung",
      argumentsText: '{"tool_name":"slow_lookup","arguments":{}}',
    }));
    await waitFor(() => h.authorityCalls.length === 1 || h.session.state === "closed", "hung authority dispatch");
    assert.notEqual(h.session.state, "closed", JSON.stringify(h.journal.events));
    const result = await h.session.shutdown("test_shutdown");

    assert.equal(result.journal.drained, true);
    const unknown = h.journal.events.find((event) => event.type === "tool.outcome_unknown_at_shutdown");
    assert.deepEqual(unknown.payload.call_ids, ["tool_hung"]);
    assert.equal(unknown.terminal, true);
    assert(h.journal.events.some((event) => event.type === "session.ended" && event.terminal));
  });

  it("rotates capabilities twice and keeps tool authority live beyond thirty minutes", async () => {
    const startedAt = Date.parse("2026-07-16T20:00:00.000Z");
    const clock = logicalClock(startedAt);
    const requested = providerConfiguration();
    const connection = {
      account_sid: ACCOUNT_SID,
      call_sid: CALL_SID,
      stream_sid: STREAM_SID,
      mode: "agent",
    };
    const expiry = (base) => new Date(base + 30 * 60_000).toISOString();
    const refresh = (base) => new Date(base + 25 * 60_000).toISOString();
    const cap = (kind, generation, expiresAt) => ({
      token: `${kind}-generation-${generation}.token.signature`,
      expiresAt,
      audience: kind === "event" ? "telephony_events" : kind === "mcp" ? "bridge_mcp" : "bridge_refresh",
      purpose: kind === "event" ? "event_journal" : kind === "mcp" ? "tool_invocation" : "capability_rotation",
    });
    const bootstrapExpiresAt = expiry(startedAt);
    const authorityClients = [];
    const authorityCalls = [];
    const rotationCalls = [];
    const h = harness({
      config: bridgeConfig({ limits: { maximumCallMs: 2 * 60 * 60_000, idleTimeoutMs: 2 * 60 * 60_000 } }),
      bootstrapResult: {
        sessionId: "bridge-test-session",
        bridgeInstanceId: "bridge-test-instance",
        callId: "application-call-1",
        connection,
        ...requested,
        eventCapability: cap("event", 0, bootstrapExpiresAt),
        mcpCapability: cap("mcp", 0, bootstrapExpiresAt),
        renewalCapability: cap("renewal", 0, bootstrapExpiresAt),
        activeCatalogAuthority: {
          catalogDigest: "a".repeat(64),
          capabilityEpoch: 0,
        },
        rotation: 0,
        rotationEndpoint: "/api/telephony/bridge/capabilities/rotate",
        refreshAfter: refresh(startedAt),
        expiresAt: bootstrapExpiresAt,
      },
      authorityFactory: (capability) => {
        const client = {
          token: capability.token,
          closed: false,
          async callCapabilityGateway(call) {
            authorityCalls.push({ token: this.token, call });
            return {
              output: { ok: true, authority_token: this.token },
              isError: false,
              activeCatalogAuthority: { ...call.activeCatalogAuthority, availability: "active" },
            };
          },
          close() { this.closed = true; },
        };
        authorityClients.push(client);
        return client;
      },
      sessionOptions: {
        now: clock.now,
        setTimeoutImpl: clock.setTimeout,
        clearTimeoutImpl: clock.clearTimeout,
        setIntervalImpl: clock.setInterval,
        clearIntervalImpl: clock.clearInterval,
        createCapabilityRotationClient: () => ({
          async rotate(input) {
            rotationCalls.push(structuredClone(input));
            const issuedAt = clock.now();
            const expiresAt = expiry(issuedAt);
            return {
              sessionId: input.sessionId,
              bridgeInstanceId: input.bridgeInstanceId,
              callId: input.expectedCallId,
              connection: input.connection,
              rotation: input.rotation,
              refreshAfter: refresh(issuedAt),
              expiresAt,
              eventCapability: cap("event", input.rotation, expiresAt),
              mcpCapability: cap("mcp", input.rotation, expiresAt),
              renewalCapability: cap("renewal", input.rotation, expiresAt),
            };
          },
        }),
      },
    });
    await ready(h);

    await clock.advance(25 * 60_000);
    await waitFor(() => h.session.snapshot().capability_rotation === 1, "first logical-clock rotation");
    assert.equal(h.session.snapshot().active_catalog_digest, "a".repeat(64));
    assert.equal(h.session.snapshot().active_catalog_capability_epoch, 0);
    assert.equal(authorityClients.length, 2);
    assert.equal(authorityClients[0].closed, false, "old authority remains during overlap");
    assert.deepEqual(h.journal.scopeRotations, ["event-generation-1.token.signature"]);

    await clock.advance(6 * 60_000);
    assert.equal(authorityClients[0].closed, true, "old authority retires at its exact expiry");
    h.provider.receive({ type: "response.created", response: { id: "r_after_30m", status: "in_progress" } });
    h.provider.receive(completedToolOutput({
      responseId: "r_after_30m",
      itemId: "item_after_30m",
      callId: "call_after_30m",
      argumentsText: '{"tool_name":"membership_lookup","arguments":{}}',
    }));
    await waitFor(() => authorityCalls.length === 1, "post-thirty-minute authority call");
    assert.equal(authorityCalls[0].token, "mcp-generation-1.token.signature");

    await clock.advance(25 * 60_000);
    await waitFor(() => h.session.snapshot().capability_rotation === 2, "second logical-clock rotation");
    assert.deepEqual(rotationCalls.map((call) => call.rotation), [1, 2]);
    assert.deepEqual(rotationCalls.map((call) => call.renewalToken), [
      "renewal-generation-0.token.signature",
      "renewal-generation-1.token.signature",
    ]);
    assert.deepEqual(h.journal.scopeRotations, [
      "event-generation-1.token.signature",
      "event-generation-2.token.signature",
    ]);
    assert.equal(h.session.state, "ready");
    assert.equal(h.session.snapshot().active_catalog_digest, "a".repeat(64));
    assert.equal(h.session.snapshot().active_catalog_capability_epoch, 0);
    assert.equal(clock.now() - startedAt, 56 * 60_000);
    await h.session.shutdown("test_complete");
    assert(authorityClients.every((client) => client.closed));
  });

  it("fails closed at capability expiry when renewal never settles", async () => {
    const startedAt = Date.parse("2026-07-16T20:00:00.000Z");
    const clock = logicalClock(startedAt);
    const authorityClients = [];
    const h = harness({
      config: bridgeConfig({ limits: { maximumCallMs: 2 * 60 * 60_000, idleTimeoutMs: 2 * 60 * 60_000 } }),
      authorityFactory: (capability) => {
        const client = {
          token: capability.token,
          closed: false,
          calls: 0,
          async callCapabilityGateway(call) {
            this.calls += 1;
            return {
              output: { ok: true },
              isError: false,
              activeCatalogAuthority: { ...call.activeCatalogAuthority, availability: "active" },
            };
          },
          close() { this.closed = true; },
        };
        authorityClients.push(client);
        return client;
      },
      sessionOptions: {
        now: clock.now,
        setTimeoutImpl: clock.setTimeout,
        clearTimeoutImpl: clock.clearTimeout,
        setIntervalImpl: clock.setInterval,
        clearIntervalImpl: clock.clearInterval,
        createCapabilityRotationClient: () => ({
          rotate: (_input, { signal } = {}) => new Promise((_, reject) => {
            signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("rotation aborted"), { code: "rotation_aborted" }));
            }, { once: true });
          }),
        }),
      },
    });
    await ready(h);
    await clock.advance(30 * 60_000);
    await waitFor(() => h.session.state === "closed", "capability expiry shutdown");

    assert.equal(authorityClients.length, 1);
    assert.equal(authorityClients[0].closed, true);
    assert.equal(authorityClients[0].calls, 0);
    assert(h.journal.events.some((event) => event.type === "session.failure" &&
      event.payload.code === "capability_authority_expired"));
  });

  it("owns a deferred bootstrap commit through terminal journal shutdown", async () => {
    const pendingBootstrap = deferred();
    let bootstrapSignal;
    const h = harness({
      sessionOptions: {
        bootstrapClient: {
          createSession: (_input, { signal } = {}) => {
            bootstrapSignal = signal;
            return pendingBootstrap.promise;
          },
        },
      },
    });
    h.twilio.receive(connected());
    h.twilio.receive(start());
    await waitFor(() => bootstrapSignal, "deferred bootstrap dispatch");

    let shutdownSettled = false;
    const shutdown = h.session.shutdown("test_during_bootstrap");
    void shutdown.then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bootstrapSignal.aborted, false, "bootstrap remains observable during the settlement window");
    assert.equal(shutdownSettled, false, "shutdown owns the pending bootstrap response");

    pendingBootstrap.resolve(bootstrapFixture({ config: bridgeConfig(), requested: h.requested }));
    const result = await shutdown;

    assert.equal(h.session.state, "closed");
    assert.deepEqual(result.pendingOwnedOperations, []);
    assert.equal(h.provider.sent.length, 0, "a closing session never connects the provider");
    assert.equal(h.journal.shutdownCalls, 1);
    assert(h.journal.events.some((event) =>
      event.type === "session.bootstrap_committed_during_shutdown" && event.terminal));
    assert(h.journal.events.some((event) => event.type === "session.ended" && event.terminal));
  });

  it("bounds an uncooperative bootstrap and rejects its post-close mutation", async () => {
    const pendingBootstrap = deferred();
    let bootstrapSignal;
    const config = bridgeConfig({ limits: { shutdownMs: 20 } });
    const h = harness({
      config,
      sessionOptions: {
        bootstrapClient: {
          createSession: (_input, { signal } = {}) => {
            bootstrapSignal = signal;
            return pendingBootstrap.promise;
          },
        },
      },
    });
    h.twilio.receive(connected());
    h.twilio.receive(start());
    await waitFor(() => bootstrapSignal, "uncooperative bootstrap dispatch");

    const result = await h.session.shutdown("test_bootstrap_deadline");
    assert.equal(bootstrapSignal.aborted, true, "deadline aborts the owned request");
    assert.deepEqual(result.pendingOwnedOperations, ["bootstrap"]);
    assert.equal(h.session.state, "closed");
    assert.equal(h.session.snapshot().capability_rotation, null);

    pendingBootstrap.resolve(bootstrapFixture({ config, requested: h.requested }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.session.snapshot().capability_rotation, null, "late bootstrap cannot mutate a closed session");
    assert.equal(h.journal.events.length, 0, "no journal is created from a post-deadline response");
    assert.equal(h.journal.shutdownCalls, 0);
    assert.equal(h.provider.sent.length, 0);
  });

  it("keeps a deadline-aborted bootstrap classified as remotely indeterminate", async () => {
    let bootstrapSignal;
    const config = bridgeConfig({ limits: { shutdownMs: 20 } });
    const h = harness({
      config,
      sessionOptions: {
        bootstrapClient: {
          createSession: (_input, { signal } = {}) => {
            bootstrapSignal = signal;
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                reject(Object.assign(new Error("bootstrap aborted"), { code: "bootstrap_aborted" }));
              }, { once: true });
            });
          },
        },
      },
    });
    h.twilio.receive(connected());
    h.twilio.receive(start());
    await waitFor(() => bootstrapSignal, "abort-aware bootstrap dispatch");

    const result = await h.session.shutdown("test_bootstrap_abort_deadline");
    assert.equal(bootstrapSignal.aborted, true);
    assert.deepEqual(result.pendingOwnedOperations, ["bootstrap"],
      "a local abort cannot prove that the remote authority did not commit");
    assert.equal(h.session.state, "closed");
    assert.equal(h.session.snapshot().capability_rotation, null);
  });

  it("classifies a committed bootstrap without a constructible journal as unterminated", async () => {
    const h = harness({
      sessionOptions: {
        createJournal: () => {
          throw Object.assign(new Error("synthetic journal construction failure"), {
            code: "journal_constructor_failed",
          });
        },
      },
    });
    h.twilio.receive(connected());
    h.twilio.receive(start());
    await waitFor(() => h.session.state === "closed", "journal construction failure shutdown");

    const result = await h.session.shutdown("same_shutdown");
    assert.deepEqual(result.pendingOwnedOperations, ["bootstrap"]);
    assert.equal(h.session.snapshot().capability_rotation, 0, "the remote bootstrap response was accepted");
    assert.equal(h.provider.sent.length, 0);
  });

  it("settles a deferred rotation before sealing the terminal journal without applying it", async () => {
    const pendingRotation = deferred();
    const authorityClients = [];
    let rotationInput;
    let rotationSignal;
    const h = harness({
      authorityFactory: (capability) => {
        const client = {
          token: capability.token,
          closed: false,
          close() { this.closed = true; },
          async callCapabilityGateway(call) {
            return {
              output: { ok: true },
              isError: false,
              activeCatalogAuthority: { ...call.activeCatalogAuthority, availability: "active" },
            };
          },
        };
        authorityClients.push(client);
        return client;
      },
      sessionOptions: {
        createCapabilityRotationClient: () => ({
          rotate: (input, { signal } = {}) => {
            rotationInput = structuredClone(input);
            rotationSignal = signal;
            return pendingRotation.promise;
          },
        }),
      },
    });
    await ready(h);
    h.session.capabilityState = Object.freeze({
      ...h.session.capabilityState,
      refreshAfterMs: Date.now() - 1,
    });
    const rotation = h.session.rotateCapabilities();
    await waitFor(() => rotationSignal, "deferred capability rotation");
    assert.equal(rotationInput.eventToken, EVENT_CAPABILITY_TOKEN);
    assert.equal(rotationInput.mcpToken, MCP_CAPABILITY_TOKEN);
    assert.equal(rotationInput.renewalToken, RENEWAL_CAPABILITY_TOKEN);

    let shutdownSettled = false;
    const shutdown = h.session.shutdown("test_during_rotation");
    void shutdown.then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rotationSignal.aborted, true);
    assert.equal(shutdownSettled, false, "shutdown owns the pending rotation promise");

    const nextExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    pendingRotation.resolve({
      sessionId: rotationInput.sessionId,
      bridgeInstanceId: rotationInput.bridgeInstanceId,
      callId: rotationInput.expectedCallId,
      connection: rotationInput.connection,
      rotation: rotationInput.rotation,
      refreshAfter: new Date(Date.parse(nextExpiresAt) - 5 * 60_000).toISOString(),
      expiresAt: nextExpiresAt,
      eventCapability: {
        token: "event-generation-1.token.signature",
        audience: "telephony_events",
        purpose: "event_journal",
        expiresAt: nextExpiresAt,
      },
      mcpCapability: {
        token: "mcp-generation-1.token.signature",
        audience: "bridge_mcp",
        purpose: "tool_invocation",
        expiresAt: nextExpiresAt,
      },
      renewalCapability: {
        token: "renewal-generation-1.token.signature",
        audience: "bridge_refresh",
        purpose: "capability_rotation",
        expiresAt: nextExpiresAt,
      },
    });
    await rotation;
    const result = await shutdown;

    assert.deepEqual(result.pendingOwnedOperations, []);
    assert.equal(h.session.state, "closed");
    assert.equal(h.session.snapshot().capability_rotation, 0, "closed session keeps its original authority generation");
    assert.deepEqual(h.journal.scopeRotations, []);
    assert.equal(authorityClients.length, 1, "no replacement authority is constructed while closing");
    assert.equal(authorityClients[0].closed, true);
    assert(h.journal.events.some((event) =>
      event.type === "capability.rotation_committed_during_shutdown" && event.terminal));
    assert(h.journal.events.some((event) => event.type === "session.ended" && event.terminal));
  });

  it("keeps an immediately aborted rotation classified as remotely indeterminate", async () => {
    let rotationSignal;
    const h = harness({
      sessionOptions: {
        createCapabilityRotationClient: () => ({
          rotate: (_input, { signal } = {}) => {
            rotationSignal = signal;
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                reject(Object.assign(new Error("rotation aborted"), { code: "rotation_aborted" }));
              }, { once: true });
            });
          },
        }),
      },
    });
    await ready(h);
    h.session.capabilityState = Object.freeze({
      ...h.session.capabilityState,
      refreshAfterMs: Date.now() - 1,
    });
    void h.session.rotateCapabilities();
    await waitFor(() => rotationSignal, "abort-aware capability rotation");

    const result = await h.session.shutdown("test_rotation_abort");
    assert.equal(rotationSignal.aborted, true);
    assert.deepEqual(result.pendingOwnedOperations, ["capability_rotation"],
      "a local rotation abort cannot prove the authority did not commit");
    assert.equal(h.session.snapshot().capability_rotation, 0);
    assert(h.journal.events.some((event) =>
      event.type === "capability.rotation_settled_during_shutdown" &&
      event.payload.code === "rotation_aborted" && event.terminal));
    assert(h.journal.events.some((event) =>
      event.type === "capability_rotation.outcome_unknown_at_shutdown" && event.terminal));
    const ended = h.journal.events.find((event) => event.type === "session.ended");
    assert.deepEqual(ended.payload.pending_owned_operations, ["capability_rotation"]);
  });

  it("maps a rejected bootstrap capability exchange to a policy close", async () => {
    const error = Object.assign(new Error("bootstrap rejected"), { code: "bootstrap_http_401" });
    const h = harness({ bootstrapError: error });
    h.twilio.receive(connected());
    h.twilio.receive(start());

    await waitFor(() => h.session.state === "closed", "bootstrap rejection shutdown");
    assert.equal(h.twilio.closeCalls[0].code, 1008);
    assert.equal(h.provider.sent.length, 0);
  });
});
