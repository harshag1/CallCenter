import industrialFieldServiceJson from "../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import {
  AgentFlowSchema,
  type AgentFlow,
} from "../flow";
import {
  canonicalJson,
  immutableJson,
  sha256Hex,
} from "./artifacts";
import {
  assertBenchmarkJsonResourceBounds,
  compileConditionSuite,
  createConditionSuiteTrustAnchor,
  type BenchmarkJsonResourceBounds,
  type CanonicalConditionCompilerInput,
  type ConditionSuiteTrustAnchor,
} from "./condition-compiler";
import {
  industrialFieldServiceCompilerInput,
} from "./industrial-field-service-source";
import {
  LONG_HORIZON_SCENARIO_SUITE,
  type LongHorizonFamily,
} from "./long-horizon-scenario-suite";
import {
  BenchmarkScenarioSchema,
  type BenchmarkScenario,
} from "./scenario-schema";
import {
  TRANSPORT_SMOKE_SCENARIO,
  transportSmokeCompilerInput,
} from "./transport-smoke-scenario";

export const SCENARIO_SOURCE_REGISTRY_VERSION = "voice-scenario-source-registry.v1" as const;

export type BenchmarkScenarioFamily = "industrial-field-service" | "transport-smoke" | LongHorizonFamily;
export type BenchmarkScenarioStudyRole = "development" | "confirmatory-held-out";
export type BenchmarkScenarioExecutionScope = "benchmark" | "c3-transport-smoke-only";

export type RegisteredScenarioSource = Readonly<{
  registryVersion: typeof SCENARIO_SOURCE_REGISTRY_VERSION;
  registryKey: string;
  family: BenchmarkScenarioFamily;
  studyRole: BenchmarkScenarioStudyRole;
  executionScope: BenchmarkScenarioExecutionScope;
  heldOut: boolean;
  scenarioId: string;
  scenarioVersion: string;
  scenarioContentHash: string;
  /**
   * Hash of the scenario plus the exact Flow v2, instructions, disclosure
   * schedule, and oracle route selected by this registry entry.
   */
  registryEntryHash: string;
  /** Exact deterministic compiler output trusted for transported-suite audits. */
  conditionSuiteTrustAnchor: ConditionSuiteTrustAnchor;
  scenario: BenchmarkScenario;
  compilerInput: CanonicalConditionCompilerInput;
  flow: AgentFlow;
}>;

export type ScenarioSourceCatalogEntry = Readonly<{
  registryKey: string;
  registryEntryHash: string;
  family: BenchmarkScenarioFamily;
  studyRole: BenchmarkScenarioStudyRole;
  executionScope: BenchmarkScenarioExecutionScope;
  heldOut: boolean;
  scenarioId: string;
  scenarioVersion: string;
  scenarioContentHash: string;
  conditionSuiteTrustAnchor: ConditionSuiteTrustAnchor;
  title: string;
  domain: string;
  maxTurns: number;
  callerTurns: number;
}>;

export type MaterializedScenarioSource = Readonly<{
  catalogEntry: ScenarioSourceCatalogEntry;
  scenario: BenchmarkScenario;
  /** One canonical JSON object followed by one newline. */
  canonicalScenarioJson: string;
  /** SHA-256 of the canonical JSON object bytes, excluding the final newline. */
  canonicalScenarioSha256: string;
}>;

export class ScenarioSourceRegistryError extends Error {
  readonly code:
    | "invalid_scenario"
    | "unknown_source"
    | "content_hash_mismatch"
    | "registry_invariant";

  constructor(code: ScenarioSourceRegistryError["code"], message: string) {
    super(message);
    this.name = "ScenarioSourceRegistryError";
    this.code = code;
  }
}

const ENTRY_HASH_DOMAIN = "harshas-amazing-call-center/scenario-source-entry/v1\n";
const CATALOG_HASH_DOMAIN = "harshas-amazing-call-center/scenario-source-catalog/v1\n";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SCENARIO_RESOURCE_BOUNDS: BenchmarkJsonResourceBounds = Object.freeze({
  maxDepth: 96,
  maxNodes: 100_000,
  maxArrayLength: 5_000,
  maxObjectKeys: 10_000,
  maxStringLength: 512 * 1024,
  maxAggregateStringLength: 2 * 1024 * 1024,
});

function identityKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

function assertScenarioResourceBounds(input: unknown, code: "invalid_scenario" | "registry_invariant"): void {
  try {
    assertBenchmarkJsonResourceBounds(input, "benchmark scenario source", SCENARIO_RESOURCE_BOUNDS);
  } catch (error) {
    throw new ScenarioSourceRegistryError(
      code,
      error instanceof Error ? error.message : "scenario exceeds resource bounds"
    );
  }
}

function validIdentityPart(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function firstStrippedPath(input: unknown, projected: unknown, path = "$"): string | null {
  if (input === null || typeof input !== "object") return null;
  if (Array.isArray(input)) {
    if (!Array.isArray(projected)) return path;
    for (let index = 0; index < input.length; index += 1) {
      const stripped = firstStrippedPath(input[index], projected[index], `${path}[${index}]`);
      if (stripped) return stripped;
    }
    return null;
  }
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)) return path;
  const output = projected as Record<string, unknown>;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) return `${path}.${key}`;
    const stripped = firstStrippedPath(value, output[key], `${path}.${key}`);
    if (stripped) return stripped;
  }
  return null;
}

/**
 * A printable, unambiguous key used in plans and diagnostics. Resolution does
 * not trust this string; the three independently computed fields are checked.
 */
export function scenarioSourceRegistryKey(input: Readonly<{
  id: string;
  version: string;
  contentHash: string;
}>): string {
  if (
    !validIdentityPart(input.id, 256)
    || !validIdentityPart(input.version, 128)
    || typeof input.contentHash !== "string"
    || !SHA256_PATTERN.test(input.contentHash)
  ) {
    throw new ScenarioSourceRegistryError("invalid_scenario", "scenario registry key fields are malformed");
  }
  return `${encodeURIComponent(input.id)}@${encodeURIComponent(input.version)}#sha256:${input.contentHash}`;
}

function canonicalCompilerInput(
  input: CanonicalConditionCompilerInput,
  expectedScenario: BenchmarkScenario
): CanonicalConditionCompilerInput {
  assertScenarioResourceBounds(input, "registry_invariant");
  const parsedFlow = AgentFlowSchema.parse(input.flow);
  const strippedFlowPath = firstStrippedPath(input.flow, parsedFlow);
  if (strippedFlowPath) {
    throw new ScenarioSourceRegistryError(
      "registry_invariant",
      `registered compiler flow contains schema-stripped content at ${strippedFlowPath}`
    );
  }
  const flow = immutableJson(parsedFlow);
  const factDisclosures = immutableJson(input.factDisclosures);
  const oracleRoute = immutableJson(input.oracleRoute);
  return Object.freeze({
    scenario: expectedScenario,
    flow,
    baseInstructions: input.baseInstructions,
    factDisclosures,
    oracleRoute,
  }) as unknown as CanonicalConditionCompilerInput;
}

function buildEntry(
  family: BenchmarkScenarioFamily,
  scenarioInput: unknown,
  compilerInputFactory: (scenario: BenchmarkScenario) => CanonicalConditionCompilerInput,
  studyRole: BenchmarkScenarioStudyRole = "development",
  heldOut = false,
  executionScope: BenchmarkScenarioExecutionScope = "benchmark"
): RegisteredScenarioSource {
  if (heldOut !== (studyRole === "confirmatory-held-out")) {
    throw new ScenarioSourceRegistryError(
      "registry_invariant",
      `${family} source has inconsistent held-out metadata`
    );
  }
  assertScenarioResourceBounds(scenarioInput, "registry_invariant");
  const result = BenchmarkScenarioSchema.safeParse(scenarioInput);
  if (!result.success) {
    throw new ScenarioSourceRegistryError(
      "registry_invariant",
      `${family} registered scenario failed validation: ${result.error.issues[0]?.message ?? "invalid scenario"}`
    );
  }
  const parsed = result.data;
  if (!validIdentityPart(parsed.version, 128)) {
    throw new ScenarioSourceRegistryError("registry_invariant", `${family} has an invalid scenario version`);
  }
  const strippedScenarioPath = firstStrippedPath(scenarioInput, parsed);
  if (strippedScenarioPath) {
    throw new ScenarioSourceRegistryError(
      "registry_invariant",
      `${family} registered scenario contains schema-stripped content at ${strippedScenarioPath}`
    );
  }
  const scenario = immutableJson(parsed) as unknown as BenchmarkScenario;
  const scenarioContentHash = sha256Hex(canonicalJson(scenario));
  const compilerInput = canonicalCompilerInput(compilerInputFactory(scenario), scenario);
  const flow = compilerInput.flow as AgentFlow;
  const conditionSuiteTrustAnchor = createConditionSuiteTrustAnchor(compileConditionSuite(compilerInput));
  const registryKey = scenarioSourceRegistryKey({
    id: scenario.id,
    version: scenario.version,
    contentHash: scenarioContentHash,
  });
  const registryEntryHash = sha256Hex(`${ENTRY_HASH_DOMAIN}${canonicalJson({
    registry_version: SCENARIO_SOURCE_REGISTRY_VERSION,
    registry_key: registryKey,
    family,
    study_role: studyRole,
    execution_scope: executionScope,
    held_out: heldOut,
    scenario,
    flow,
    base_instructions: compilerInput.baseInstructions,
    fact_disclosures: compilerInput.factDisclosures,
    oracle_route: compilerInput.oracleRoute,
    condition_suite_trust_anchor: conditionSuiteTrustAnchor,
  })}`);

  return Object.freeze({
    registryVersion: SCENARIO_SOURCE_REGISTRY_VERSION,
    registryKey,
    family,
    studyRole,
    executionScope,
    heldOut,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    scenarioContentHash,
    registryEntryHash,
    conditionSuiteTrustAnchor,
    scenario,
    compilerInput,
    flow,
  });
}

const entries: RegisteredScenarioSource[] = [
  buildEntry(
    "industrial-field-service",
    industrialFieldServiceJson,
    industrialFieldServiceCompilerInput
  ),
  ...LONG_HORIZON_SCENARIO_SUITE.map((source) => buildEntry(
    source.family,
    source.scenario,
    () => source.compilerInput,
    source.studyRole,
    source.heldOut
  )),
  buildEntry(
    "transport-smoke",
    TRANSPORT_SMOKE_SCENARIO,
    transportSmokeCompilerInput,
    "development",
    false,
    "c3-transport-smoke-only"
  ),
];

const byIdentity = new Map<string, RegisteredScenarioSource>();
const byRegistryKey = new Map<string, RegisteredScenarioSource>();
for (const entry of entries) {
  const identity = identityKey(entry.scenarioId, entry.scenarioVersion);
  if (byIdentity.has(identity)) {
    throw new ScenarioSourceRegistryError(
      "registry_invariant",
      `duplicate scenario source identity ${entry.scenarioId}@${entry.scenarioVersion}`
    );
  }
  if (byRegistryKey.has(entry.registryKey)) {
    throw new ScenarioSourceRegistryError(
      "registry_invariant",
      `duplicate exact scenario source key ${entry.registryKey}`
    );
  }
  byIdentity.set(identity, entry);
  byRegistryKey.set(entry.registryKey, entry);
}

export const REGISTERED_SCENARIO_SOURCES: readonly RegisteredScenarioSource[] = Object.freeze(
  [...entries].sort((left, right) => left.registryKey < right.registryKey ? -1 : left.registryKey > right.registryKey ? 1 : 0)
);

export const SCENARIO_SOURCE_CATALOG = immutableJson(
  REGISTERED_SCENARIO_SOURCES.map((entry) => ({
    registryKey: entry.registryKey,
    registryEntryHash: entry.registryEntryHash,
    family: entry.family,
    studyRole: entry.studyRole,
    executionScope: entry.executionScope,
    heldOut: entry.heldOut,
    scenarioId: entry.scenarioId,
    scenarioVersion: entry.scenarioVersion,
    scenarioContentHash: entry.scenarioContentHash,
    conditionSuiteTrustAnchor: entry.conditionSuiteTrustAnchor,
    title: entry.scenario.title,
    domain: entry.scenario.domain,
    maxTurns: entry.scenario.max_turns,
    callerTurns: entry.scenario.caller.turns.length,
  }))
) as unknown as readonly ScenarioSourceCatalogEntry[];

const catalogByRegistryKey = new Map(
  SCENARIO_SOURCE_CATALOG.map((entry) => [entry.registryKey, entry] as const)
);

/** Hash frozen into evidence plans to bind the complete accepted source set. */
export const SCENARIO_SOURCE_REGISTRY_HASH = sha256Hex(`${CATALOG_HASH_DOMAIN}${canonicalJson({
  registry_version: SCENARIO_SOURCE_REGISTRY_VERSION,
  entries: SCENARIO_SOURCE_CATALOG,
})}`);

export function listScenarioSources(): readonly ScenarioSourceCatalogEntry[] {
  return SCENARIO_SOURCE_CATALOG;
}

/**
 * Resolve an untrusted scenario to the one canonical compiler source allowed
 * for its exact id, version, and parsed content hash.
 *
 * Looking up the identity before the full key deliberately distinguishes an
 * altered copy of a known fixture from a genuinely unknown source. Either
 * condition fails closed before compilation or provider spend.
 */
export function resolveScenarioSource(scenarioInput: unknown): RegisteredScenarioSource {
  assertScenarioResourceBounds(scenarioInput, "invalid_scenario");
  const parsed = BenchmarkScenarioSchema.safeParse(scenarioInput);
  if (!parsed.success) {
    const unregisteredContent = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
    throw new ScenarioSourceRegistryError(
      unregisteredContent ? "content_hash_mismatch" : "invalid_scenario",
      `scenario failed validation: ${parsed.error.issues[0]?.message ?? "invalid scenario"}`
    );
  }
  if (!validIdentityPart(parsed.data.version, 128)) {
    throw new ScenarioSourceRegistryError("invalid_scenario", "scenario version is malformed");
  }

  const knownIdentity = byIdentity.get(identityKey(parsed.data.id, parsed.data.version));
  if (!knownIdentity) {
    throw new ScenarioSourceRegistryError(
      "unknown_source",
      `scenario source ${parsed.data.id}@${parsed.data.version} is not registered`
    );
  }

  try {
    // Validate the full input as plain JSON before using the schema-normalized
    // form. Scenario schemas add explicit defaults, so raw and normalized
    // hashes need not match even for a valid checked-in fixture.
    canonicalJson(scenarioInput);
  } catch (error) {
    throw new ScenarioSourceRegistryError(
      "invalid_scenario",
      `scenario is not canonical JSON data: ${error instanceof Error ? error.message : "invalid JSON value"}`
    );
  }
  const strippedPath = firstStrippedPath(scenarioInput, parsed.data);
  if (strippedPath) {
    throw new ScenarioSourceRegistryError(
      "content_hash_mismatch",
      `scenario source ${parsed.data.id}@${parsed.data.version} contains unregistered content at ${strippedPath}`
    );
  }
  const contentHash = sha256Hex(canonicalJson(parsed.data));
  const exactKey = scenarioSourceRegistryKey({
    id: parsed.data.id,
    version: parsed.data.version,
    contentHash,
  });
  const exact = byRegistryKey.get(exactKey);
  if (!exact || exact !== knownIdentity) {
    throw new ScenarioSourceRegistryError(
      "content_hash_mismatch",
      `scenario source ${parsed.data.id}@${parsed.data.version} does not match its registered canonical content hash`
    );
  }
  return exact;
}

export function resolveScenarioSourceByKey(registryKey: string): RegisteredScenarioSource {
  if (typeof registryKey !== "string" || registryKey.length === 0 || registryKey.length > 1_024) {
    throw new ScenarioSourceRegistryError("unknown_source", "scenario source key is malformed");
  }
  const entry = byRegistryKey.get(registryKey);
  if (!entry) {
    throw new ScenarioSourceRegistryError(
      "unknown_source",
      `scenario source key ${registryKey} is not registered`
    );
  }
  return entry;
}

/** Trusted compiler anchor bound into the closed registry catalog. */
export function conditionSuiteTrustAnchorForSource(registryKey: string): ConditionSuiteTrustAnchor {
  return resolveScenarioSourceByKey(registryKey).conditionSuiteTrustAnchor;
}

/** Materialize a registry source without accepting caller-authored scenario data. */
export function materializeScenarioSource(registryKey: string): MaterializedScenarioSource {
  const source = resolveScenarioSourceByKey(registryKey);
  const catalogEntry = catalogByRegistryKey.get(registryKey);
  if (!catalogEntry) {
    throw new ScenarioSourceRegistryError(
      "registry_invariant",
      `scenario source catalog is missing ${registryKey}`
    );
  }
  return Object.freeze({
    catalogEntry,
    scenario: source.scenario,
    canonicalScenarioJson: `${canonicalJson(source.scenario)}\n`,
    canonicalScenarioSha256: source.scenarioContentHash,
  });
}
