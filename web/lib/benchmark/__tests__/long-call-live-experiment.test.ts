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
  longCallResultSha256,
  longCallScheduleArtifact,
  longUsefulnessTask,
  scoreLongCallExperiment,
  type LongCallSummary,
} from "../long-call-live-experiment";

describe("HACC-LC3-v6 long-call live experiment", () => {
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
      expect(pair.pairId).toMatch(/^lc3v6-(?:openai|gemini|xai)-(?:museum|campus|water)-samantha$/);
      expect(new Set(pair.armOrder)).toEqual(new Set(["raw-memory", "host-managed-harness"]));
      const pairCells = cells.filter((cell) => cell.pairId === pair.pairId);
      expect(pairCells.every((cell) => cell.runId.startsWith(`${pair.pairId}-`))).toBe(true);
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

  it("fails closed if host-managed provider catalogs escape their compiled target subset", () => {
    const baseStateHash = "1".repeat(64);
    const stepStateHash = "2".repeat(64);
    const lookupHash = "3".repeat(64);
    const grantCommitment = "4".repeat(64);
    const condition = {
      visibleCapabilities: [
        { name: "flow.get_state", semanticHash: baseStateHash },
      ],
      disclosures: [{
        target: "step:route.lookup",
        visibleCapabilities: [
          { name: "flow.get_state", semanticHash: stepStateHash },
          { name: "lookup_record", semanticHash: lookupHash },
        ],
      }],
    } as unknown as Parameters<typeof assertHostManagedGrantExposure>[1];
    const transcript = (scope: string, actions: readonly string[]) => ({
      view: "public_commitment",
      entries: [{
        operation: "initialize",
        payload: {
          provider_visible_capability_snapshot: {
            gateway_version: 1,
            scope,
            capability_epoch: 1,
            actions: actions.map((name) => ({
              name,
              semantic_hash: name === "lookup_record" ? lookupHash : scope === "$base" ? baseStateHash : stepStateHash,
              capability_grant_commitment: grantCommitment,
            })),
          },
        },
      }],
    }) as unknown as Parameters<typeof assertHostManagedGrantExposure>[0];
    expect(() => assertHostManagedGrantExposure(transcript("step:route.lookup", ["flow.get_state", "lookup_record"]), condition)).not.toThrow();
    expect(() => assertHostManagedGrantExposure(transcript("step:route.lookup", ["flow.enter_step"]), condition)).toThrow("outside target-scoped subset");
    expect(() => assertHostManagedGrantExposure(transcript("$base", ["lookup_record"]), condition)).toThrow(
      "outside target-scoped subset $base",
    );
    expect(() => assertHostManagedGrantExposure(transcript("step:missing", ["flow.get_state"]), condition)).toThrow(
      "unknown target scope",
    );
  });

  it("validates caller-turn snapshots without treating them as invocation outcomes", () => {
    const baseStateHash = "1".repeat(64);
    const stepStateHash = "2".repeat(64);
    const lookupHash = "3".repeat(64);
    const grantCommitment = "4".repeat(64);
    const condition = {
      visibleCapabilities: [{ name: "flow.get_state", semanticHash: baseStateHash }],
      disclosures: [{
        target: "step:route.lookup",
        visibleCapabilities: [
          { name: "flow.get_state", semanticHash: stepStateHash },
          { name: "lookup_record", semanticHash: lookupHash },
        ],
      }],
    } as unknown as Parameters<typeof assertHostManagedGrantExposure>[1];
    const transcript = (callerActions: readonly string[]) => ({
      view: "public_commitment",
      entries: [{
        operation: "initialize",
        payload: {
          provider_visible_capability_snapshot: {
            gateway_version: 1,
            scope: "$base",
            capability_epoch: 0,
            actions: [{
              name: "flow.get_state",
              semantic_hash: baseStateHash,
              capability_grant_commitment: grantCommitment,
            }],
          },
        },
      }, {
        operation: "caller_turn",
        payload: {
          capability_snapshot: {
            gateway_version: 1,
            scope: "step:route.lookup",
            capability_epoch: 1,
            actions: callerActions.map((name) => ({
              name,
              semantic_hash: name === "lookup_record" ? lookupHash : stepStateHash,
              capability_grant_commitment: grantCommitment,
            })),
          },
        },
      }],
    }) as unknown as Parameters<typeof assertHostManagedGrantExposure>[0];

    expect(() => assertHostManagedGrantExposure(transcript(["flow.get_state", "lookup_record"]), condition)).not.toThrow();
    expect(() => assertHostManagedGrantExposure(transcript(["flow.enter_step"]), condition)).toThrow(
      "outside target-scoped subset step:route.lookup in entry[1].caller_turn_snapshot",
    );
    const missingSemanticHash = JSON.parse(JSON.stringify(transcript(["flow.get_state"]))) as {
      entries: Array<{ payload: { capability_snapshot?: { actions: Array<Record<string, unknown>> } } }>;
    };
    delete missingSemanticHash.entries[1].payload.capability_snapshot!.actions[0].semantic_hash;
    expect(() => assertHostManagedGrantExposure(
      missingSemanticHash as unknown as Parameters<typeof assertHostManagedGrantExposure>[0],
      condition,
    )).toThrow("malformed entry[1].caller_turn_snapshot.actions[0]");
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
    const providerEvidence = [{
      sequence: 1,
      event_type: "provider.normalized",
      payload: {
        type: "tool.calls",
        calls: [{
          callId: "provider-call-1",
          name: "capability_gateway",
          argumentsJson: { tool_name: "lookup_record", arguments: {} },
        }],
      },
    }, {
      sequence: 2,
      event_type: "tool.call_result",
      payload: {
        provider_call_id: "provider-call-1",
        requested_tool: "capability_gateway",
        action: "lookup_record",
        provider_call_identity_conflict: false,
        execution_disposition: "not_executed",
        receipt_id: null,
        committed: false,
        authoritative_gateway_result: { ok: true, action: "lookup_record" },
        provider_visible_output: { ok: true, action: "lookup_record" },
      },
    }] as unknown as Parameters<typeof evaluateLongCallModelIntegrity>[2];

    expect(evaluateLongCallModelIntegrity(world([]), transcript("success_executed"), providerEvidence)).toBe(true);
    expect(evaluateLongCallModelIntegrity(world([]), transcript("failure"), providerEvidence)).toBe(false);
    expect(evaluateLongCallModelIntegrity(world([{
      tool: "lookup_record",
      turn: 7,
      status: "failed_before_commit",
      prerequisite_evidence: [],
    }]), transcript("failure"), providerEvidence)).toBe(true);
    expect(evaluateLongCallModelIntegrity(world([{ status: "rejected", prerequisite_evidence: [] }]), transcript("failure"), providerEvidence)).toBe(false);
    expect(evaluateLongCallModelIntegrity(world([{
      status: "succeeded",
      prerequisite_evidence: [{ passed: false }],
    }]), transcript("success_executed"), providerEvidence)).toBe(false);
  });

  it("reports exact paired McNemar results separately by provider", () => {
    const summaries: LongCallSummary[] = createLongCallCells().map((cell) => {
      const strict = cell.condition === "host-managed-harness" || cell.pairOrdinal % 3 === 0;
      const core = {
        transportTerminal: true,
        modelIntegrityPass: true,
        modelAttemptEvidenceSha256: "d".repeat(64),
        modelAttemptCount: 4,
        modelAttemptViolationCount: 0,
        modelPreKernelRejectedAttemptCount: 0,
        modelPreKernelContainedAttemptCount: 0,
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
        asrExpectedOutputTurns: 20,
        asrAvailableOutputTurns: 20,
        asrTranscribedOutputTurns: 20,
        audioSemanticViolationCounts: Object.freeze({
          verificationPinDisclosed: 0,
          privateValueDisclosed: 0,
          retiredTargetUsed: 0,
          prematureTerminalClaim: 0,
        }),
        estimatedCostUsd: 0.01,
        artifactManifestSha256: "a".repeat(64),
        failureClass: classifyLongCallFailure(core),
      });
    });
    const result = scoreLongCallExperiment(summaries, {
      experimentId: "hacc-lc3-test",
      planSha256: "c".repeat(64),
      sourceCommit: "d".repeat(40),
    });
    expect(result.providerEffects).toHaveLength(3);
    for (const effect of result.providerEffects) {
      expect(effect.scheduledPairs).toBe(3);
      expect(effect.harnessPasses).toBe(3);
      expect(effect.rawPasses).toBe(1);
      expect(effect.harnessOnly).toBe(2);
      expect(effect.rawOnly).toBe(0);
      expect(effect.exactMcNemarTwoSidedP).toBe(0.5);
      expect(effect.modelIntegrity).toEqual({ raw: 3, harness: 3 });
      expect(effect.modelAttemptEvidence).toEqual({
        raw: { attempts: 12, violations: 0, preKernelRejected: 0, preKernelContained: 0 },
        harness: { attempts: 12, violations: 0, preKernelRejected: 0, preKernelContained: 0 },
      });
      expect(effect.strict).toEqual({ raw: 1, harness: 3 });
      expect(effect.interactionCounts).toEqual({
        raw: {
          totalMatchedVoiceExchanges: 60,
          asrVerifiedVoiceExchanges: 60,
          completed20TurnEpisodes: 3,
        },
        harness: {
          totalMatchedVoiceExchanges: 60,
          asrVerifiedVoiceExchanges: 60,
          completed20TurnEpisodes: 3,
        },
      });
    }
    expect(result.modelFailures).toBe(0);
    expect(result.asrCoverage).toEqual({
      expectedOutputTurns: 360,
      availableOutputTurns: 360,
      transcribedOutputTurns: 360,
    });
    expect(result.audioSemanticViolationCounts).toEqual({
      verificationPinDisclosed: 0,
      privateValueDisclosed: 0,
      retiredTargetUsed: 0,
      prematureTerminalClaim: 0,
    });
    expect(result.totalMatchedVoiceExchanges).toBe(360);
    expect(result.asrVerifiedVoiceExchanges).toBe(360);
    expect(result.completed20TurnEpisodes).toBe(18);
    expect(result.modelAttemptEvidence).toHaveLength(18);
    expect(result.modelAttemptEvidence.every((entry) => entry.evidenceSha256 === "d".repeat(64))).toBe(true);
  });

  it("reports 210/80/4 accounting, binds provenance, and preserves multi-label failures", () => {
    const summaries: LongCallSummary[] = createLongCallCells().map((cell, index) => {
      const fullEpisode = index < 4;
      const turns = fullEpisode ? 20 : index === 4 ? 13 : 9;
      const core = {
        transportTerminal: true,
        modelIntegrityPass: false,
        worldOutcomePass: false,
        systemIntegrityPass: true,
        audioSemanticPass: false,
        turnsPlanned: 20,
        turnsSent: turns,
        outputAudioTurns: turns,
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
        status: fullEpisode ? "completed" : "protocol_error",
        callerScheduleStatus: fullEpisode ? "complete" : "blocked",
        ...core,
        modelAttemptEvidenceSha256: "d".repeat(64),
        modelAttemptCount: turns,
        modelAttemptViolationCount: 1,
        modelPreKernelRejectedAttemptCount: 1,
        modelPreKernelContainedAttemptCount: 1,
        asrReceiptsSha256: "b".repeat(64),
        asrExpectedOutputTurns: 20,
        asrAvailableOutputTurns: fullEpisode ? 20 : 0,
        asrTranscribedOutputTurns: fullEpisode ? 20 : 0,
        audioSemanticViolationCounts: Object.freeze({
          verificationPinDisclosed: 0,
          privateValueDisclosed: 0,
          retiredTargetUsed: 0,
          prematureTerminalClaim: 0,
        }),
        missionCompletionPass: isLongCallMissionCompletionPass(core),
        strictPass: isStrictLongCallPass(core),
        estimatedCostUsd: 0.01,
        artifactManifestSha256: "a".repeat(64),
        failureClass: classifyLongCallFailure(core),
      });
    });
    const provenance = Object.freeze({
      experimentId: "hacc-lc3-v6-test",
      planSha256: "1".repeat(64),
      sourceCommit: "2".repeat(40),
    });

    const result = scoreLongCallExperiment(summaries, provenance);
    expect(result.schemaVersion).toBe(2);
    expect(result.totalMatchedVoiceExchanges).toBe(210);
    expect(result.asrVerifiedVoiceExchanges).toBe(80);
    expect(result.completed20TurnEpisodes).toBe(4);
    expect(Object.hasOwn(result, "completedVoiceToVoiceInteractions")).toBe(false);
    expect(result.providerEffects.reduce(
      (total, effect) => total
        + effect.interactionCounts.raw.totalMatchedVoiceExchanges
        + effect.interactionCounts.harness.totalMatchedVoiceExchanges,
      0,
    )).toBe(210);
    expect(result.gateFailureCounts).toEqual({
      transport: 0,
      turnCompletion: 14,
      modelIntegrity: 18,
      worldOutcome: 18,
      systemIntegrity: 0,
      audioSemantic: 18,
    });
    expect(result.gateFailureVectors).toHaveLength(18);
    expect(result.gateFailureVectors[0].failures).toMatchObject({
      modelIntegrity: true,
      worldOutcome: true,
      audioSemantic: true,
    });

    const { resultSha256, ...body } = result;
    expect(longCallResultSha256(body)).toBe(resultSha256);
    for (const mutated of [
      { ...body, experimentId: "different-experiment" },
      { ...body, planSha256: "3".repeat(64) },
      { ...body, sourceCommit: "4".repeat(40) },
      { ...body, totalMatchedVoiceExchanges: body.totalMatchedVoiceExchanges + 1 },
      { ...body, asrVerifiedVoiceExchanges: body.asrVerifiedVoiceExchanges + 1 },
      { ...body, completed20TurnEpisodes: body.completed20TurnEpisodes + 1 },
      {
        ...body,
        providerEffects: body.providerEffects.map((effect, index) => index === 0 ? {
          ...effect,
          interactionCounts: {
            ...effect.interactionCounts,
            raw: {
              ...effect.interactionCounts.raw,
              totalMatchedVoiceExchanges: effect.interactionCounts.raw.totalMatchedVoiceExchanges + 1,
            },
          },
        } : effect),
      },
    ]) {
      expect(longCallResultSha256(mutated)).not.toBe(resultSha256);
    }
  });
});
