import { describe, expect, it } from "vitest";
import {
  LONG_CALL_FAMILIES,
  LONG_CALL_PROTOCOL_ID,
  LONG_CALL_SCHEDULED_CALLER_TURNS,
  LONG_CALL_TTS_VOICES,
  assertLongCallBudgetLedgerMatchesSchedule,
  classifyLongCallFailure,
  createLongCallBudgetLedger,
  createLongCallCells,
  createLongCallPairs,
  isStrictLongCallPass,
  longCallScheduleArtifact,
  longUsefulnessTask,
  scoreLongCallExperiment,
  type LongCallSummary,
} from "../long-call-live-experiment";

describe("HACC-LC3-v1 long-call live experiment", () => {
  it("freezes 27 paired strata, 54 episodes, and 1,080 caller turns", () => {
    const pairs = createLongCallPairs();
    const cells = createLongCallCells();
    expect(pairs).toHaveLength(27);
    expect(cells).toHaveLength(54);
    expect(cells.reduce((sum, cell) => sum + cell.turnsPlanned, 0)).toBe(LONG_CALL_SCHEDULED_CALLER_TURNS);
    expect(new Set(pairs.map((pair) => pair.provider))).toEqual(new Set(["openai", "gemini", "xai"]));
    expect(new Set(pairs.map((pair) => pair.family))).toEqual(new Set(LONG_CALL_FAMILIES));
    expect(new Set(pairs.map((pair) => pair.ttsVoice))).toEqual(new Set(LONG_CALL_TTS_VOICES));
    for (const pair of pairs) {
      expect(new Set(pair.armOrder)).toEqual(new Set(["raw-memory", "full-harness"]));
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
    expect(schedule.maximumAggregateUsd).toBe("270");
    expect(schedule.providers).toMatchObject({
      openai: { model: "gpt-realtime-2.1", voice: "marin", sampleRateHz: 24_000 },
      gemini: { model: "gemini-3.1-flash-live-preview", voice: "Aoede", sampleRateHz: 16_000 },
      xai: { model: "grok-voice-think-fast-1.0", voice: "ara", sampleRateHz: 24_000 },
    });
    expect(schedule.scheduleSha256).toMatch(/^[a-f0-9]{64}$/);
    const ledger = createLongCallBudgetLedger("2026-07-21T19:00:00.000Z");
    expect(ledger.authorization_ceiling_micro_usd).toBe(270_000_000);
    expect(ledger.scheduling_stop_micro_usd).toBe(270_000_000);
    expect(ledger.reservations).toHaveLength(54);
    expect(ledger.reservations.every((reservation) =>
      reservation.status === "active" && reservation.maximum_micro_usd === 5_000_000
    )).toBe(true);
    expect(() => assertLongCallBudgetLedgerMatchesSchedule(ledger)).not.toThrow();
    expect(() => assertLongCallBudgetLedgerMatchesSchedule({
      ...ledger,
      reservations: ledger.reservations.slice(1),
    })).toThrow("exactly 54 reservations");
  });

  it("defines strict pass and transport/world/system failure precedence", () => {
    const pass = { transportTerminal: true, worldOutcomePass: true, systemIntegrityPass: true, audioSemanticPass: true, turnsPlanned: 20, turnsSent: 20, outputAudioTurns: 20 };
    expect(isStrictLongCallPass(pass)).toBe(true);
    expect(isStrictLongCallPass({ ...pass, outputAudioTurns: 19 })).toBe(false);
    expect(classifyLongCallFailure(pass)).toBeNull();
    expect(classifyLongCallFailure({ ...pass, transportTerminal: false })).toBe("transport");
    expect(classifyLongCallFailure({ ...pass, systemIntegrityPass: false })).toBe("system");
    expect(classifyLongCallFailure({ ...pass, worldOutcomePass: false })).toBe("world");
    expect(classifyLongCallFailure({ ...pass, audioSemanticPass: false })).toBe("audio");
  });

  it("reports exact paired McNemar results separately by provider", () => {
    const summaries: LongCallSummary[] = createLongCallCells().map((cell) => {
      const strict = cell.condition === "full-harness" || cell.pairOrdinal % 3 === 0;
      const core = {
        transportTerminal: true,
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
      expect(effect.scheduledPairs).toBe(9);
      expect(effect.harnessPasses).toBe(9);
      expect(effect.rawPasses).toBe(3);
      expect(effect.harnessOnly).toBe(6);
      expect(effect.rawOnly).toBe(0);
      expect(effect.exactMcNemarTwoSidedP).toBe(0.03125);
    }
  });
});
