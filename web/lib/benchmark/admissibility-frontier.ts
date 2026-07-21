import type { Predicate } from "./scenario-schema";
import type {
  CompiledBenchmarkCondition,
  CompiledCapability,
} from "./condition-compiler";
import type { BenchmarkKernelCapabilityHead } from "./kernel-attestation";
import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  evaluateToolWorldPredicate,
  type ToolWorldState,
} from "./tool-world";
import type { BenchmarkScenario, JsonValue, ToolDefinition, ValueSource } from "./scenario-schema";

export const ADMISSIBILITY_FRONTIER_VERSION = "host-admissibility-frontier.v1" as const;
const POLICY_DOMAIN = "harshas-amazing-call-center/benchmark-admissibility-policy/v1\n";
const EVIDENCE_DOMAIN = "harshas-amazing-call-center/benchmark-admissibility-evidence/v1\n";

export type AdmissibilityActionEvidence = Readonly<{
  action: string;
  host_prerequisite_ids: readonly string[];
  deferred_prerequisite_ids: readonly string[];
  failed_host_prerequisite_ids: readonly string[];
  admissible: boolean;
}>;

export type AdmissibilityFrontierEvidence = Readonly<{
  schema_version: 1;
  frontier_version: typeof ADMISSIBILITY_FRONTIER_VERSION;
  applicability: "host_managed_step" | "not_applicable";
  condition_hash: string;
  scenario_hash: string;
  turn: number;
  target: string;
  policy_sha256: string;
  actions: readonly AdmissibilityActionEvidence[];
  admissible_action_names: readonly string[];
  evidence_sha256: string;
}>;

export type AdmissibilityFrontier = Readonly<{
  capabilities: readonly CompiledCapability[];
  evidence: AdmissibilityFrontierEvidence;
}>;

function allConditionCapabilities(condition: CompiledBenchmarkCondition): Map<string, CompiledCapability> {
  return new Map(
    [...condition.visibleCapabilities, ...condition.disclosures.flatMap((item) => item.visibleCapabilities)]
      .map((capability) => [capability.name, capability])
  );
}

/** Exact compiler catalog before the host readiness subset is applied. */
export function compiledCapabilitiesAtHead(
  condition: CompiledBenchmarkCondition,
  target: string,
  catalogMode: BenchmarkKernelCapabilityHead["catalog_mode"]
): readonly CompiledCapability[] {
  const union = allConditionCapabilities(condition);
  if (!condition.behavior.progressiveDisclosure) return condition.visibleCapabilities;
  if (target === "$base") return condition.visibleCapabilities;
  if (catalogMode === "terminal") {
    const recovery = union.get("flow.get_state");
    return recovery ? Object.freeze([recovery]) : Object.freeze([]);
  }
  const disclosure = condition.disclosures.find((candidate) => candidate.target === target);
  if (!disclosure) throw new Error(`capability target ${target} is absent from the compiled condition`);
  return disclosure.visibleCapabilities;
}

function sources(predicate: Predicate): readonly ValueSource[] {
  return Object.freeze([predicate.left, ...(predicate.right ? [predicate.right] : [])]);
}

function root(path: string): string {
  return path.split(".")[0] ?? path;
}

function protectedWorldRoots(scenario: BenchmarkScenario): ReadonlySet<string> {
  return new Set([
    ...Object.keys(scenario.caller.private_facts),
    ...scenario.caller.turns.flatMap((turn) => turn.fact_updates.map((update) => update.fact)),
  ]);
}

function isProtectedWorldPath(path: string, protectedRoots: ReadonlySet<string>): boolean {
  const first = root(path);
  return protectedRoots.has(first)
    || first === "oracle"
    || first.startsWith("oracle_")
    || first === "expected"
    || first.startsWith("expected_");
}

function isHostDecidable(predicate: Predicate, protectedRoots: ReadonlySet<string>): boolean {
  return sources(predicate).every((source) => {
    if (!("source" in source)) return true;
    if (source.source === "arguments") return false;
    if (source.source === "world") return !isProtectedWorldPath(source.path, protectedRoots);
    // Runtime fields are evaluated against the deliberately tiny committed
    // boundary context below. Invocation-only runtime fields remain absent and
    // therefore fail closed rather than being guessed.
    return source.source === "runtime";
  });
}

function actionEvidence(
  tool: ToolDefinition,
  world: ToolWorldState,
  turn: number,
  protectedRoots: ReadonlySet<string>
): AdmissibilityActionEvidence {
  const host = tool.prerequisites.filter((predicate) => isHostDecidable(predicate, protectedRoots));
  const deferred = tool.prerequisites.filter((predicate) => !isHostDecidable(predicate, protectedRoots));
  const evaluated = host.map((predicate) => evaluateToolWorldPredicate(predicate, {
    world: world.facts,
    arguments: {},
    runtime: { turn },
  }));
  const failed = evaluated.filter((item) => !item.passed).map((item) => item.prerequisite_id).sort();
  return Object.freeze({
    action: tool.name,
    host_prerequisite_ids: Object.freeze(host.map((item) => item.id).sort()),
    deferred_prerequisite_ids: Object.freeze(deferred.map((item) => item.id).sort()),
    failed_host_prerequisite_ids: Object.freeze(failed),
    admissible: failed.length === 0,
  });
}

function withEvidenceHash(
  body: Omit<AdmissibilityFrontierEvidence, "evidence_sha256">
): AdmissibilityFrontierEvidence {
  return immutableJson({
    ...body,
    evidence_sha256: sha256Hex(`${EVIDENCE_DOMAIN}${canonicalJson(body)}`),
  }) as unknown as AdmissibilityFrontierEvidence;
}

/**
 * Compute the provider-visible subset from current authoritative state only.
 * The result contains no world values, caller text, ASR output, or oracle
 * values; it records predicate IDs and boolean readiness only.
 */
export function computeAdmissibilityFrontier(input: Readonly<{
  condition: CompiledBenchmarkCondition;
  scenario: BenchmarkScenario;
  world: ToolWorldState;
  turn: number;
  target: string;
  catalogMode: BenchmarkKernelCapabilityHead["catalog_mode"];
}>): AdmissibilityFrontier {
  if (!Number.isSafeInteger(input.turn) || input.turn < 0) {
    throw new Error("admissibility frontier turn must be a non-negative safe integer");
  }
  const compiled = compiledCapabilitiesAtHead(input.condition, input.target, input.catalogMode);
  const applies = input.condition.behavior.transitionOwnership === "host-managed-linear"
    && input.target.startsWith("step:")
    && input.catalogMode === "target";
  const policyBody = {
    frontier_version: ADMISSIBILITY_FRONTIER_VERSION,
    transition_ownership: input.condition.behavior.transitionOwnership,
    protected_source_policy: "defer_arguments_private_annotations_expected_and_oracle",
    target_scope: "active_step_leaf_capabilities",
  } as const;
  if (!applies) {
    const names = [...compiled].map((item) => item.name).sort();
    return Object.freeze({
      capabilities: Object.freeze([...compiled]),
      evidence: withEvidenceHash({
        schema_version: 1,
        frontier_version: ADMISSIBILITY_FRONTIER_VERSION,
        applicability: "not_applicable",
        condition_hash: input.condition.conditionHash,
        scenario_hash: input.condition.scenarioHash,
        turn: input.turn,
        target: input.target,
        policy_sha256: sha256Hex(`${POLICY_DOMAIN}${canonicalJson(policyBody)}`),
        actions: Object.freeze([]),
        admissible_action_names: Object.freeze(names),
      }),
    });
  }

  const protectedRoots = protectedWorldRoots(input.scenario);
  const toolByName = new Map(input.scenario.tools.map((tool) => [tool.name, tool]));
  const evaluations = compiled
    .filter((capability) => capability.category === "leaf")
    .map((capability) => {
      const tool = toolByName.get(capability.name);
      if (!tool) throw new Error(`compiled capability ${capability.name} has no bound scenario tool`);
      return actionEvidence(tool, input.world, input.turn, protectedRoots);
    })
    .sort((left, right) => left.action.localeCompare(right.action));
  const admissible = new Set(evaluations.filter((item) => item.admissible).map((item) => item.action));
  const capabilities = compiled.filter((capability) =>
    capability.category !== "leaf" || admissible.has(capability.name)
  );
  return Object.freeze({
    capabilities: Object.freeze([...capabilities]),
    evidence: withEvidenceHash({
      schema_version: 1,
      frontier_version: ADMISSIBILITY_FRONTIER_VERSION,
      applicability: "host_managed_step",
      condition_hash: input.condition.conditionHash,
      scenario_hash: input.condition.scenarioHash,
      turn: input.turn,
      target: input.target,
      policy_sha256: sha256Hex(`${POLICY_DOMAIN}${canonicalJson(policyBody)}`),
      actions: Object.freeze(evaluations),
      admissible_action_names: Object.freeze(capabilities.map((item) => item.name).sort()),
    }),
  });
}

export function admissibilityFrontierEvidenceJson(
  evidence: AdmissibilityFrontierEvidence
): JsonValue {
  return immutableJson(evidence) as JsonValue;
}

export function verifyAdmissibilityFrontierEvidence(
  input: AdmissibilityFrontierEvidence
): boolean {
  const { evidence_sha256: claimed, ...body } = input;
  return /^[a-f0-9]{64}$/.test(claimed)
    && claimed === sha256Hex(`${EVIDENCE_DOMAIN}${canonicalJson(body)}`);
}
