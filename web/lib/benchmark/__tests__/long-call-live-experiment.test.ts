import { describe, expect, it } from "vitest";
import {
  LONG_CALL_FAMILIES,
  LONG_CALL_PROTOCOL_ID,
  LONG_CALL_SCHEDULED_CALLER_TURNS,
  LONG_CALL_TTS_VOICES,
  assertHostManagedGrantExposure,
  assertLongCallBudgetLedgerMatchesSchedule,
  classifyLongCallFailure,
  createLongCallBudgetLedger,
  createLongCallCells,
  createLongCallPairs,
  evaluateLongCallModelIntegrity,
  evaluateLongCallSystemIntegrity,
  evaluateLongCallTransportIntegrity,
  isLongCallMissionCompletionPass,
  isStrictLongCallPass,
  longCallScheduleArtifact,
  longUsefulnessTask,
  scoreLongCallExperiment,
  type LongCallSummary,
} from "../long-call-live-experiment";

describe("HACC-LC3-v3 long-call live experiment", () => {
  it("freezes 9 paired strata, 18 episodes, and 360 caller turns", () => {
    const pairs = createLongCallPairs();
    const cells = createLongCallCells();
    expect(pairs).toHaveLength(9);
    expect(cells).toHaveLength(18);
    expect(cells.reduce((sum, cell) => sum + cell.turnsPlanned, 0)).toBe(LONG_CALL_SCHEDULED_CALLER_TURNS);
    expect(new Set(pairs.map((pair) => pair.provider))).toEqual(new Set(["openai", "gemini", "xai"]));
    expect(new Set(pairs.map((pair) => pair.family))).toEqual(new Set(LONG_CALL_FAMILIES));
    expect(new Set(pairs.map((pair) => pair.ttsVoice))).toEqual(new Set(LONG_CALL_TTS_VOICES));
    for (const pair of pairs) {
      expect(new Set(pair.armOrder)).toEqual(new Set(["raw-memory", "host-managed-harness"]));
      const pairCells = cells.filter((cell) => cell.pairId === pair.pairId);
      expect(pairCells.map((cell) => cell.condition)).toEqual([...pair.armOrder]);
      expect(new Set(pairCells.map((cell) => `${cell.provider}/${cell.family}/${cell.ttsVoice}`)).size).toBe(1);
    }
  });

  it("uses exactly the existing 20-turn long usefulness tasks", () => {
    for (const family of LONG_CALL_FAMILIES) {
      const task = longUsefulnessTask(family);
      expect(task.complexity_band).toBe("long");
      expect(task.scenario.caller.turns).toHaveLength(20);
      expect(task.scenario.max_turns).toBe(20);
    }
  });

  it("pins provider models, voices, rates, and hard budget caps", () => {
    const schedule = longCallScheduleArtifact();
    expect(schedule.protocolId).toBe(LONG_CALL_PROTOCOL_ID);
    expect(schedule.maximumUsdPerEpisode).toBe("5");
    expect(schedule.maximumAggregateUsd).toBe("90");
    expect(schedule.providers).toMatchObject({
      openai: { model: "gpt-realtime-2.1", voice: "marin", sampleRateHz: 24_000 },
      gemini: { model: "gemini-3.1-flash-live-preview", voice: "Aoede", sampleRateHz: 16_000 },
      xai: { model: "grok-voice-think-fast-1.0", voice: "ara", sampleRateHz: 24_000 },
    });
    expect(schedule.scheduleSha256).toMatch(/^[a-f0-9]{64}$/);
    const ledger = createLongCallBudgetLedger("2026-07-21T19:00:00.000Z");
    expect(ledger.authorization_ceiling_micro_usd).toBe(90_000_000);
    expect(ledger.scheduling_stop_micro_usd).toBe(90_000_000);
    expect(ledger.reservations).toHaveLength(18);
    expect(ledger.reservations.every((reservation) =>
      reservation.status === "active" && reservation.maximum_micro_usd === 5_000_000
    )).toBe(true);
    expect(() => assertLongCallBudgetLedgerMatchesSchedule(ledger)).not.toThrow();
    expect(() => assertLongCallBudgetLedgerMatchesSchedule({
      ...ledger,
      reservations: ledger.reservations.slice(1),
    })).toThrow("exactly 18 reservations");
  });

  it("defines strict pass and transport/world/system failure precedence", () => {
    const pass = { transportTerminal: true, modelIntegrityPass: true, worldOutcomePass: true, systemIntegrityPass: true, audioSemanticPass: true, turnsPlanned: 20, turnsSent: 20, outputAudioTurns: 20 };
    expect(isStrictLongCallPass(pass)).toBe(true);
    expect(isLongCallMissionCompletionPass(pass)).toBe(true);
    const missionCompletionInput = {
      transportTerminal: pass.transportTerminal,
      worldOutcomePass: pass.worldOutcomePass,
      systemIntegrityPass: pass.systemIntegrityPass,
      audioSemanticPass: pass.audioSemanticPass,
      turnsPlanned: pass.turnsPlanned,
      turnsSent: pass.turnsSent,
      outputAudioTurns: pass.outputAudioTurns,
    };
    expect(isLongCallMissionCompletionPass(missionCompletionInput)).toBe(true);
    expect(isStrictLongCallPass({ ...pass, outputAudioTurns: 19 })).toBe(false);
    expect(classifyLongCallFailure(pass)).toBeNull();
    expect(classifyLongCallFailure({ ...pass, transportTerminal: false })).toBe("transport");
    expect(classifyLongCallFailure({ ...pass, modelIntegrityPass: false })).toBe("model");
    expect(classifyLongCallFailure({ ...pass, systemIntegrityPass: false })).toBe("system");
    expect(classifyLongCallFailure({ ...pass, worldOutcomePass: false })).toBe("world");
    expect(classifyLongCallFailure({ ...pass, audioSemanticPass: false })).toBe("audio");
  });

  it("fails closed if host-managed provider catalogs expose model-owned linear transitions", () => {
    const transcript = (scope: string, actions: readonly string[]) => ({
      view: "public_commitment",
      entries: [{
        operation: "initialize",
        payload: {
          provider_visible_capability_snapshot: {
            gateway_version: 1,
            scope,
            capability_epoch: 1,
            actions: actions.map((name) => ({ name })),
          },
        },
      }],
    }) as unknown as Parameters<typeof assertHostManagedGrantExposure>[0];
    expect(() => assertHostManagedGrantExposure(transcript("step:route.lookup", ["flow.get_state", "lookup_record"]))).not.toThrow();
    expect(() => assertHostManagedGrantExposure(transcript("step:route.lookup", ["flow.enter_step"]))).toThrow("step-scoped flow.enter_step");
    expect(() => assertHostManagedGrantExposure(transcript("$base", ["flow.complete_step"]))).toThrow("flow.complete_step");
  });

  it("classifies a caller-policy stop as model evidence rather than a transport failure", () => {
    expect(evaluateLongCallTransportIntegrity({
      status: "protocol_error",
      callerScheduleStatus: "blocked",
      errors: [{ code: "caller_policy_blocked", fatal: true }],
    })).toBe(true);
    expect(evaluateLongCallTransportIntegrity({
      status: "protocol_error",
      callerScheduleStatus: "blocked",
      errors: [{ code: "provider_disconnected", fatal: true }],
    })).toBe(false);
  });

  it("scores runtime containment independently from required task completion", () => {
    const world = (overrides: Record<string, unknown> = {}) => ({
      receipts: [{
        receipt_id: "receipt-1",
        committed: true,
        prerequisite_evidence: [{ passed: true }],
        effect_ids: ["effect-1"],
      }],
      effects: [{
        effect_id: "effect-1",
        receipt_id: "receipt-1",
      }],
      ...overrides,
    }) as unknown as Parameters<typeof evaluateLongCallSystemIntegrity>[0];
    expect(evaluateLongCallSystemIntegrity(world())).toBe(true);
    expect(evaluateLongCallSystemIntegrity(world({
      receipts: [{
        receipt_id: "receipt-1",
        committed: true,
        prerequisite_evidence: [{ passed: false }],
        effect_ids: ["effect-1"],
      }],
    }))).toBe(false);
    expect(evaluateLongCallSystemIntegrity(world({
      effects: [{
        effect_id: "effect-1",
        receipt_id: "receipt-1",
        duplicate_of_effect_id: "effect-0",
      }],
    }))).toBe(false);
  });

  it("fails model integrity for rejected prerequisites and blocked gateway calls", () => {
    const transcript = (resultClass: string) => ({
      view: "public_commitment",
      entries: [{
        schema_version: 1,
        transcript_type: "benchmark_kernel_replay_public_commitment",
        run_id: "run",
        sequence: 1,
        operation: "invoke",
        payload: {
          input: { action: "lookup_record", turn: 7 },
          outcome: { result_class: resultClass },
          public_world_delta: { receipts_append_hmac_sha256: "c".repeat(64) },
        },
        previous_entry_sha256: "a".repeat(64),
        entry_sha256: "b".repeat(64),
      }],
    }) as unknown as Parameters<typeof evaluateLongCallModelIntegrity>[1];
    const world = (receipts: readonly unknown[]) => ({ receipts }) as unknown as Parameters<typeof evaluateLongCallModelIntegrity>[0];

    expect(evaluateLongCallModelIntegrity(world([]), transcript("success_executed"))).toBe(true);
    expect(evaluateLongCallModelIntegrity(world([]), transcript("failure"))).toBe(false);
    expect(evaluateLongCallModelIntegrity(world([{
      tool: "lookup_record",
      turn: 7,
      status: "failed_before_commit",
      prerequisite_evidence: [],
    }]), transcript("failure"))).toBe(true);
    expect(evaluateLongCallModelIntegrity(world([{ status: "rejected", prerequisite_evidence: [] }]), transcript("failure"))).toBe(false);
    expect(evaluateLongCallModelIntegrity(world([{
      status: "succeeded",
      prerequisite_evidence: [{ passed: false }],
    }]), transcript("success_executed"))).toBe(false);
  });

  it("reports exact paired McNemar results separately by provider", () => {
    const summaries: LongCallSummary[] = createLongCallCells().map((cell) => {
      const strict = cell.condition === "host-managed-harness" || cell.pairOrdinal % 3 === 0;
      const core = {
        transportTerminal: true,
        modelIntegrityPass: true,
        worldOutcomePass: strict,
        systemIntegrityPass: true,
        audioSemanticPass: true,
        turnsPlanned: 20,
        turnsSent: 20,
        outputAudioTurns: 20,
      };
      return Object.freeze({
        schemaVersion: 1 as const,
        protocolId: LONG_CALL_PROTOCOL_ID,
        runId: cell.runId,
        pairId: cell.pairId,
        provider: cell.provider,
        model: cell.model,
        family: cell.family,
        ttsVoice: cell.ttsVoice,
        condition: cell.condition,
        status: "completed",
        callerScheduleStatus: "complete",
        ...core,
        missionCompletionPass: isLongCallMissionCompletionPass(core),
        strictPass: isStrictLongCallPass(core),
        asrReceiptsSha256: "b".repeat(64),
        estimatedCostUsd: 0.01,
        artifactManifestSha256: "a".repeat(64),
        failureClass: classifyLongCallFailure(core),
      });
    });
    const result = scoreLongCallExperiment(summaries);
    expect(result.providerEffects).toHaveLength(3);
    for (const effect of result.providerEffects) {
      expect(effect.scheduledPairs).toBe(3);
      expect(effect.harnessPasses).toBe(3);
      expect(effect.rawPasses).toBe(1);
      expect(effect.harnessOnly).toBe(2);
      expect(effect.rawOnly).toBe(0);
      expect(effect.exactMcNemarTwoSidedP).toBe(0.5);
      expect(effect.modelIntegrity).toEqual({ raw: 3, harness: 3 });
      expect(effect.strict).toEqual({ raw: 1, harness: 3 });
    }
    expect(result.modelFailures).toBe(0);
  });
});
