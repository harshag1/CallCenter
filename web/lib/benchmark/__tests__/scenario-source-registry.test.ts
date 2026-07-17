import industrialFieldServiceJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  assertConditionParity,
  compileConditionSuite,
  createConditionSuiteTrustAnchor,
} from "../condition-compiler";
import {
  REGISTERED_SCENARIO_SOURCES,
  SCENARIO_SOURCE_CATALOG,
  SCENARIO_SOURCE_REGISTRY_HASH,
  ScenarioSourceRegistryError,
  conditionSuiteTrustAnchorForSource,
  listScenarioSources,
  materializeScenarioSource,
  resolveScenarioSource,
  resolveScenarioSourceByKey,
} from "../scenario-source-registry";

function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("scenario source registry", () => {
  it("binds industrial and every long-horizon fixture to an exact canonical compiler source", () => {
    expect(REGISTERED_SCENARIO_SOURCES).toHaveLength(10);
    expect(new Set(REGISTERED_SCENARIO_SOURCES.map((entry) => entry.family))).toEqual(new Set([
      "industrial-field-service",
      "travel-disruption",
      "home-health-coordination",
      "field-service-escalation",
    ]));
    expect(new Set(REGISTERED_SCENARIO_SOURCES.map((entry) => entry.registryKey)).size).toBe(10);
    expect(SCENARIO_SOURCE_CATALOG).toHaveLength(10);
    expect(listScenarioSources()).toBe(SCENARIO_SOURCE_CATALOG);
    expect(Object.isFrozen(SCENARIO_SOURCE_CATALOG)).toBe(true);
    expect(SCENARIO_SOURCE_REGISTRY_HASH).toMatch(/^[a-f0-9]{64}$/);

    for (const registered of REGISTERED_SCENARIO_SOURCES) {
      const resolved = resolveScenarioSource(detached(registered.scenario));
      expect(resolved).toBe(registered);
      expect(resolveScenarioSourceByKey(registered.registryKey)).toBe(registered);
      expect(registered.scenarioContentHash).toBe(sha256Hex(canonicalJson(registered.scenario)));
      expect(registered.registryKey).toContain(`#sha256:${registered.scenarioContentHash}`);
      expect(registered.compilerInput.scenario).toBe(registered.scenario);
      expect(registered.compilerInput.flow).toBe(registered.flow);
      expect(conditionSuiteTrustAnchorForSource(registered.registryKey)).toBe(registered.conditionSuiteTrustAnchor);
      expect(Object.isFrozen(registered.scenario)).toBe(true);
      expect(Object.isFrozen(registered.flow)).toBe(true);

      const materialized = materializeScenarioSource(registered.registryKey);
      expect(materialized.scenario).toBe(registered.scenario);
      expect(materialized.catalogEntry.registryEntryHash).toBe(registered.registryEntryHash);
      expect(materialized.canonicalScenarioJson).toBe(`${canonicalJson(registered.scenario)}\n`);
      expect(materialized.canonicalScenarioSha256).toBe(registered.scenarioContentHash);
      expect(materialized.canonicalScenarioJson.split("\n")).toHaveLength(2);
      expect(resolveScenarioSource(JSON.parse(materialized.canonicalScenarioJson))).toBe(registered);

      const suite = compileConditionSuite(registered.compilerInput);
      expect(() => assertConditionParity(suite)).not.toThrow();
      expect(registered.conditionSuiteTrustAnchor).toEqual(createConditionSuiteTrustAnchor(suite));
      expect(materialized.catalogEntry.conditionSuiteTrustAnchor).toEqual(registered.conditionSuiteTrustAnchor);
      expect(suite.scenarioId).toBe(registered.scenarioId);
      expect(suite.scenarioVersion).toBe(registered.scenarioVersion);
    }

    expect(SCENARIO_SOURCE_CATALOG.filter((entry) => entry.heldOut)).toHaveLength(3);
    expect(SCENARIO_SOURCE_CATALOG.filter((entry) => entry.heldOut).every((entry) =>
      entry.studyRole === "confirmatory-held-out" && entry.maxTurns === 120
    )).toBe(true);
    expect(SCENARIO_SOURCE_CATALOG.filter((entry) => !entry.heldOut).every((entry) =>
      entry.studyRole === "development"
    )).toBe(true);
  });

  it("returns the registry-owned detached source instead of an equivalent caller object", () => {
    const callerOwned = detached(industrialFieldServiceJson);
    const resolved = resolveScenarioSource(callerOwned);
    expect(resolved.scenario).not.toBe(callerOwned);
    expect(resolved.compilerInput.scenario).toBe(resolved.scenario);
  });

  it("rejects changed content under an otherwise registered id and version", () => {
    const changed = detached(industrialFieldServiceJson);
    changed.objective = `${changed.objective} silently altered`;

    try {
      resolveScenarioSource(changed);
      throw new Error("expected content mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioSourceRegistryError);
      expect((error as ScenarioSourceRegistryError).code).toBe("content_hash_mismatch");
    }
  });

  it("does not let schema-stripped unknown fields bypass exact content binding", () => {
    const changed = detached(industrialFieldServiceJson) as typeof industrialFieldServiceJson & {
      unregistered_override?: string;
    };
    changed.unregistered_override = "silently ignored by a non-strict top-level schema";

    expect(() => resolveScenarioSource(changed)).toThrowError(
      expect.objectContaining({ code: "content_hash_mismatch" })
    );

    const nested = detached(industrialFieldServiceJson) as typeof industrialFieldServiceJson;
    (nested.tools[0] as typeof nested.tools[0] & { unregistered_override?: string }).unregistered_override =
      "silently ignored by a non-strict nested schema";
    expect(() => resolveScenarioSource(nested)).toThrowError(
      expect.objectContaining({ code: "content_hash_mismatch" })
    );
  });

  it("rejects a changed long-horizon fixture under its registered identity", () => {
    const registered = REGISTERED_SCENARIO_SOURCES.find((entry) => entry.family === "home-health-coordination");
    if (!registered) throw new Error("home-health source missing");
    const changed = detached(registered.scenario);
    changed.caller.goal = `${changed.caller.goal} altered`;

    expect(() => resolveScenarioSource(changed)).toThrowError(
      expect.objectContaining({ code: "content_hash_mismatch" })
    );
  });

  it("rejects unknown identities and exact keys", () => {
    const unknown = detached(industrialFieldServiceJson);
    unknown.id = "unknown-benchmark-source.v1";
    expect(() => resolveScenarioSource(unknown)).toThrowError(
      expect.objectContaining({ code: "unknown_source" })
    );

    const wrongVersion = detached(industrialFieldServiceJson);
    wrongVersion.version = "999.0.0";
    expect(() => resolveScenarioSource(wrongVersion)).toThrowError(
      expect.objectContaining({ code: "unknown_source" })
    );

    expect(() => resolveScenarioSourceByKey("not-a-registered-key")).toThrowError(
      expect.objectContaining({ code: "unknown_source" })
    );
    expect(() => materializeScenarioSource("not-a-registered-key")).toThrowError(
      expect.objectContaining({ code: "unknown_source" })
    );
    expect(() => resolveScenarioSourceByKey("x".repeat(1_025))).toThrowError(
      expect.objectContaining({ code: "unknown_source" })
    );
  });

  it("rejects hostile source structures before recursive schema parsing or hashing", () => {
    const tooDeep = detached(industrialFieldServiceJson) as unknown as {
      initial_facts: Record<string, unknown>;
    };
    let nested: Record<string, unknown> = {};
    tooDeep.initial_facts.hostile_depth = nested;
    for (let depth = 0; depth < 110; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.next = child;
      nested = child;
    }
    expect(() => resolveScenarioSource(tooDeep)).toThrowError(expect.objectContaining({
      code: "invalid_scenario",
      message: expect.stringContaining("exceeds maximum depth"),
    }));

    const cyclic = detached(industrialFieldServiceJson) as typeof industrialFieldServiceJson & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(() => resolveScenarioSource(cyclic)).toThrowError(expect.objectContaining({
      code: "invalid_scenario",
      message: expect.stringContaining("contains a cycle"),
    }));

    const protoKey = detached(industrialFieldServiceJson) as unknown as {
      initial_facts: Record<string, unknown>;
    };
    protoKey.initial_facts = JSON.parse('{"__proto__":{"forged":true}}') as Record<string, unknown>;
    expect(() => resolveScenarioSource(protoKey)).toThrowError(expect.objectContaining({
      code: "invalid_scenario",
      message: expect.stringContaining("forbidden key __proto__"),
    }));
  });
});
