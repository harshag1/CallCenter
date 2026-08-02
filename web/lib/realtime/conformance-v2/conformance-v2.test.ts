import { describe, expect, it } from "vitest";
import {
  FAKE_GEMINI_LIFECYCLE_TRACE,
  FAKE_OPENAI_LIFECYCLE_TRACE,
  FAKE_XAI_LIFECYCLE_TRACE,
  RealtimeLifecycleConformanceValidator,
  validateRealtimeLifecycleTrace,
  type RealtimeLifecycleEvent,
} from ".";

const TRACES = [
  ["OpenAI", FAKE_OPENAI_LIFECYCLE_TRACE],
  ["Gemini", FAKE_GEMINI_LIFECYCLE_TRACE],
  ["xAI", FAKE_XAI_LIFECYCLE_TRACE],
] as const;

function replace(
  trace: readonly RealtimeLifecycleEvent[],
  index: number,
  event: RealtimeLifecycleEvent,
): readonly RealtimeLifecycleEvent[] {
  return [...trace.slice(0, index), event, ...trace.slice(index + 1)];
}

describe("realtime provider lifecycle evidence conformance v2", () => {
  it.each(TRACES)("accepts a complete fake %s lifecycle with acknowledged config, tools, usage, interruption, and reconnect", (_, trace) => {
    const report = validateRealtimeLifecycleTrace(trace);

    expect(report.passed).toBe(true);
    expect(report.eventCount).toBe(24);
    expect(report.snapshot).toMatchObject({
      phase: "terminal",
      connectionEpoch: 1,
      providerSessionId: expect.any(String),
      openTurnIds: [],
      openResponseIds: [],
      completedToolCallIds: ["tool-call-1"],
      acknowledgedToolResultIds: ["tool-result-1"],
      violations: [],
    });
    expect(report.snapshot.acknowledgedConfiguration).toMatchObject({
      model: expect.any(String),
      voice: expect.any(String),
      settingsSha256: "a".repeat(64),
    });
  });

  it("rejects a request-only configuration identity claim", () => {
    const event = FAKE_OPENAI_LIFECYCLE_TRACE[2];
    if (event.type !== "session.configuration.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      evidence: {
        authority: "client_request" as const,
        requestId: event.requestId,
        wireType: "session.update",
        observedAtMs: event.occurredAtMs,
      },
    } satisfies RealtimeLifecycleEvent;

    const report = validateRealtimeLifecycleTrace(replace(FAKE_OPENAI_LIFECYCLE_TRACE, 2, hostile));
    expect(report.passed).toBe(false);
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "request_only_acknowledgement", eventType: "session.configuration.acknowledged" }),
    ]));
  });

  it.each(TRACES)("rejects a fake %s trace when the provider acknowledges a different model", (_, trace) => {
    const event = trace[2];
    if (event.type !== "session.configuration.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      acknowledged: { ...event.acknowledged, model: "different-model" },
    } satisfies RealtimeLifecycleEvent;

    const report = validateRealtimeLifecycleTrace(replace(trace, 2, hostile));
    expect(report.passed).toBe(false);
    expect(report.snapshot.providerSessionId).toBeNull();
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "configuration_mismatch",
        eventType: "session.configuration.acknowledged",
        message: "provider-acknowledged model differs from the request",
      }),
    ]));
  });

  it.each(TRACES)("rejects a fake %s trace when the provider acknowledges a different voice", (_, trace) => {
    const event = trace[2];
    if (event.type !== "session.configuration.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      acknowledged: { ...event.acknowledged, voice: "different-voice" },
    } satisfies RealtimeLifecycleEvent;

    const report = validateRealtimeLifecycleTrace(replace(trace, 2, hostile));
    expect(report.passed).toBe(false);
    expect(report.snapshot.providerSessionId).toBeNull();
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "configuration_mismatch",
        eventType: "session.configuration.acknowledged",
        message: "provider-acknowledged voice differs from the request",
      }),
    ]));
  });

  it.each(TRACES)("rejects a fake %s trace when acknowledged model identity is unverifiable", (_, trace) => {
    const event = trace[2];
    if (event.type !== "session.configuration.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      acknowledged: { ...event.acknowledged, model: "" },
    } as RealtimeLifecycleEvent;

    const report = validateRealtimeLifecycleTrace(replace(trace, 2, hostile));
    expect(report.passed).toBe(false);
    expect(report.snapshot.providerSessionId).toBeNull();
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_event", eventType: "session.configuration.acknowledged" }),
    ]));
  });

  it.each(TRACES)("rejects a fake %s trace when acknowledged settings differ", (_, trace) => {
    const event = trace[2];
    if (event.type !== "session.configuration.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      acknowledged: { ...event.acknowledged, settingsSha256: "9".repeat(64) },
    } satisfies RealtimeLifecycleEvent;

    const report = validateRealtimeLifecycleTrace(replace(trace, 2, hostile));
    expect(report.passed).toBe(false);
    expect(report.snapshot.providerSessionId).toBeNull();
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "configuration_mismatch",
        eventType: "session.configuration.acknowledged",
        message: "provider-acknowledged settings differ from the request",
      }),
    ]));
  });

  it.each(TRACES)("rejects a fake %s resume when provider-acknowledged identity changes", (_, trace) => {
    const event = trace[16];
    if (event.type !== "session.resume.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      acknowledged: { ...event.acknowledged, model: "different-model-after-reconnect" },
    } satisfies RealtimeLifecycleEvent;

    const report = validateRealtimeLifecycleTrace(replace(trace, 16, hostile));
    expect(report.passed).toBe(false);
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "configuration_mismatch",
        eventType: "session.resume.acknowledged",
        message: "provider-acknowledged model differs from the request",
      }),
    ]));
  });

  it("rejects response audio before a provider-identified response", () => {
    const trace = [...FAKE_GEMINI_LIFECYCLE_TRACE];
    const audio = trace[5];
    trace.splice(4, 0, audio);
    const report = validateRealtimeLifecycleTrace(trace);

    expect(report.passed).toBe(false);
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_lifecycle_order", eventType: "response.audio.delta" }),
    ]));
  });

  it("rejects events from stale connection epochs after reconnect", () => {
    const event = FAKE_XAI_LIFECYCLE_TRACE[17];
    const stale = { ...event, connectionId: "connection-0", connectionEpoch: 0 } satisfies RealtimeLifecycleEvent;
    const report = validateRealtimeLifecycleTrace(replace(FAKE_XAI_LIFECYCLE_TRACE, 17, stale));

    expect(report.passed).toBe(false);
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale_connection_epoch" }),
    ]));
  });

  it("fails closed when a required feature is unsupported", () => {
    const event = FAKE_OPENAI_LIFECYCLE_TRACE[2];
    if (event.type !== "session.configuration.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      acknowledged: {
        ...event.acknowledged,
        features: event.acknowledged.features.map((feature) => feature.id === "tool_calls"
          ? { ...feature, status: "unsupported" as const, reasonCode: "not_available" }
          : feature),
      },
    } satisfies RealtimeLifecycleEvent;
    const report = validateRealtimeLifecycleTrace(replace(FAKE_OPENAI_LIFECYCLE_TRACE, 2, hostile));

    expect(report.passed).toBe(false);
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_required_feature" }),
    ]));
  });

  it("allows a preferred feature to be explicitly unsupported with provider evidence", () => {
    const trace = [...FAKE_GEMINI_LIFECYCLE_TRACE];
    for (const index of [2, 16]) {
      const event = trace[index];
      if (event.type !== "session.configuration.acknowledged" && event.type !== "session.resume.acknowledged") {
        throw new Error("fixture drift");
      }
      trace[index] = {
        ...event,
        acknowledged: {
          ...event.acknowledged,
          features: event.acknowledged.features.map((feature) => feature.id === "session_resumption"
            ? { ...feature, status: "unsupported" as const, reasonCode: "provider_disabled" }
            : feature),
        },
      };
    }
    // A trace cannot exercise reconnect after negotiating resumption as unsupported.
    const initialOnly = [...trace.slice(0, 13), {
      ...trace[23],
      connectionId: "connection-0",
      connectionEpoch: 0,
    } as RealtimeLifecycleEvent];
    const report = validateRealtimeLifecycleTrace(initialOnly);
    expect(report.passed).toBe(true);
  });

  it("rejects incomplete feature negotiation and acknowledged settings drift", () => {
    const event = FAKE_XAI_LIFECYCLE_TRACE[2];
    if (event.type !== "session.configuration.acknowledged") throw new Error("fixture drift");
    const hostile = {
      ...event,
      acknowledged: {
        ...event.acknowledged,
        settingsSha256: "9".repeat(64),
        features: event.acknowledged.features.filter(({ id }) => id !== "interruption"),
      },
    } satisfies RealtimeLifecycleEvent;
    const report = validateRealtimeLifecycleTrace(replace(FAKE_XAI_LIFECYCLE_TRACE, 2, hostile));

    expect(report.snapshot.violations.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "feature_negotiation_incomplete",
      "configuration_mismatch",
    ]));
  });

  it("rejects duplicate provider event identities with conflicting meanings", () => {
    const response = FAKE_OPENAI_LIFECYCLE_TRACE[4];
    const audio = FAKE_OPENAI_LIFECYCLE_TRACE[5];
    if (response.type !== "response.started" || audio.type !== "response.audio.delta") throw new Error("fixture drift");
    const hostile = { ...audio, evidence: response.evidence } satisfies RealtimeLifecycleEvent;
    const report = validateRealtimeLifecycleTrace(replace(FAKE_OPENAI_LIFECYCLE_TRACE, 5, hostile));

    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "identity_conflict", message: expect.stringContaining("provider event identity") }),
    ]));
  });

  it("rejects skipped audio sequences and interruption boundaries not proven by deltas", () => {
    const audio = FAKE_OPENAI_LIFECYCLE_TRACE[6];
    const terminal = FAKE_OPENAI_LIFECYCLE_TRACE[21];
    if (audio.type !== "response.audio.delta" || terminal.type !== "response.terminal") throw new Error("fixture drift");
    const skipped = { ...audio, sequence: 4 } satisfies RealtimeLifecycleEvent;
    const badBoundary = {
      ...terminal,
      interruption: { lastReleasedSequence: 0, releasedDurationMs: 100 },
    } satisfies RealtimeLifecycleEvent;

    expect(validateRealtimeLifecycleTrace(replace(FAKE_OPENAI_LIFECYCLE_TRACE, 6, skipped)).snapshot.violations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_event", eventType: "response.audio.delta" })]));
    expect(validateRealtimeLifecycleTrace(replace(FAKE_OPENAI_LIFECYCLE_TRACE, 21, badBoundary)).snapshot.violations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_interruption_evidence" })]));
  });

  it("rejects tool result acknowledgements that have no submitted result", () => {
    const trace = FAKE_GEMINI_LIFECYCLE_TRACE.filter((_, index) => index !== 8);
    const report = validateRealtimeLifecycleTrace(trace);

    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_lifecycle_order", eventType: "tool.result.acknowledged" }),
    ]));
  });

  it("rejects decreasing cumulative provider usage", () => {
    const trace = [...FAKE_XAI_LIFECYCLE_TRACE];
    const usage = trace[20];
    if (usage.type !== "usage.reported") throw new Error("fixture drift");
    if (usage.evidence.authority !== "provider_wire") throw new Error("fixture drift");
    const earlier = {
      ...usage,
      inputTextTokens: 100,
      inputAudioTokens: 200,
      outputTextTokens: 30,
      outputAudioTokens: 70,
      totalTokens: 400,
      evidence: { ...usage.evidence, providerEventId: "xai-usage-earlier" },
    } satisfies RealtimeLifecycleEvent;
    trace.splice(20, 0, earlier);

    const report = validateRealtimeLifecycleTrace(trace);
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "non_monotonic_usage" }),
    ]));
  });

  it("rejects reconnect without a resumable disconnect and exact parent identity", () => {
    const opened = FAKE_OPENAI_LIFECYCLE_TRACE[14];
    if (opened.type !== "connection.opened") throw new Error("fixture drift");
    const trace = FAKE_OPENAI_LIFECYCLE_TRACE.filter((_, index) => index !== 13);
    const report = validateRealtimeLifecycleTrace(trace);
    expect(report.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_lifecycle_order", eventType: "connection.opened" }),
    ]));

    const wrongParent = { ...opened, reconnectOfConnectionId: "other-connection" } satisfies RealtimeLifecycleEvent;
    const wrongParentReport = validateRealtimeLifecycleTrace(replace(FAKE_OPENAI_LIFECYCLE_TRACE, 14, wrongParent));
    expect(wrongParentReport.snapshot.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "identity_conflict" }),
    ]));
  });

  it("supports streaming validation while preserving all violations for quarantine evidence", () => {
    const validator = new RealtimeLifecycleConformanceValidator();
    for (const event of FAKE_OPENAI_LIFECYCLE_TRACE) validator.push(event);
    expect(validator.snapshot().phase).toBe("terminal");

    const terminal = FAKE_OPENAI_LIFECYCLE_TRACE.at(-1)!;
    const added = validator.push(terminal);
    expect(added).toEqual([
      expect.objectContaining({ code: "invalid_lifecycle_order", eventType: "session.terminal" }),
    ]);
    expect(validator.report()).toMatchObject({ passed: false, eventCount: 25, snapshot: { phase: "invalid" } });
  });
});
