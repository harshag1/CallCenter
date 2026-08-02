import { canonicalJson, immutableJson, sha256Hex } from "./canonical";
import type {
  EvidenceArtifactDescriptorV2,
  FrozenEvidenceEvaluationContractV2,
} from "./types";
import { exactRecord, integer, nonEmpty, safeId, sha256 } from "./validation";

const CONTRACT_DOMAIN = "hacc/evidence-v2/frozen-evaluation-contract/v2\n";
const CONTRACT_KEYS = [
  "schema_version", "contract_type", "contract_id", "scenario_id", "artifact_resolver_id",
  "scenario_artifact", "plan", "catalog", "required_goal_predicate_ids",
  "required_obligation_ids", "required_opportunity_ids", "forbidden_claim_ids", "world_predicates",
  "step_predicate_bindings", "obligation_predicate_bindings", "minimum_inventory",
] as const;
const ARTIFACT_KEYS = ["artifact_id", "sha256", "byte_length", "media_type"] as const;

function uniqueIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const ids = value.map((id, index) => { safeId(id, `${label}[${index}]`); return id; });
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicates`);
  return ids;
}

function descriptor(value: unknown, label: string): EvidenceArtifactDescriptorV2 {
  exactRecord(value, ARTIFACT_KEYS, label);
  safeId(value.artifact_id, `${label} ID`); sha256(value.sha256, `${label} hash`);
  integer(value.byte_length, `${label} byte length`, 1); nonEmpty(value.media_type, `${label} media type`, 256);
  return value as unknown as EvidenceArtifactDescriptorV2;
}

export function validateFrozenEvidenceEvaluationContractV2(input: unknown): FrozenEvidenceEvaluationContractV2 {
  exactRecord(input, CONTRACT_KEYS, "frozen evidence evaluation contract");
  if (input.schema_version !== 2 || input.contract_type !== "hacc_frozen_evidence_evaluation") throw new Error("unsupported frozen evidence evaluation contract");
  safeId(input.contract_id, "evaluation contract ID"); safeId(input.scenario_id, "scenario ID"); safeId(input.artifact_resolver_id, "artifact resolver ID");
  descriptor(input.scenario_artifact, "scenario artifact");
  exactRecord(input.plan, ["plan_id", "revision", "artifact", "required_step_ids"], "evaluation plan");
  safeId(input.plan.plan_id, "evaluation plan ID"); integer(input.plan.revision, "evaluation plan revision", 1); descriptor(input.plan.artifact, "plan artifact");
  const steps = uniqueIds(input.plan.required_step_ids, "required step IDs");
  exactRecord(input.catalog, ["catalog_id", "revision", "artifact", "capability_ids"], "evaluation catalog");
  safeId(input.catalog.catalog_id, "evaluation catalog ID"); integer(input.catalog.revision, "evaluation catalog revision", 1); descriptor(input.catalog.artifact, "catalog artifact");
  uniqueIds(input.catalog.capability_ids, "capability IDs");
  const goals = uniqueIds(input.required_goal_predicate_ids, "required goal predicate IDs");
  const obligations = uniqueIds(input.required_obligation_ids, "required obligation IDs");
  const opportunities = uniqueIds(input.required_opportunity_ids, "required opportunity IDs");
  const forbidden = uniqueIds(input.forbidden_claim_ids, "forbidden claim IDs");
  if (!Array.isArray(input.world_predicates)) throw new Error("world predicates must be an array");
  const predicateIds = new Set<string>();
  input.world_predicates.forEach((predicate, index) => {
    exactRecord(predicate, ["predicate_id", "path", "expected"], `world predicate[${index}]`);
    safeId(predicate.predicate_id, `world predicate[${index}] ID`);
    if (predicateIds.has(predicate.predicate_id)) throw new Error(`world predicate ID ${predicate.predicate_id} is duplicated`);
    predicateIds.add(predicate.predicate_id);
    if (!Array.isArray(predicate.path) || predicate.path.length === 0) throw new Error(`world predicate[${index}] path must be non-empty`);
    predicate.path.forEach((segment, segmentIndex) => {
      nonEmpty(segment, `world predicate[${index}] path[${segmentIndex}]`, 256);
      if (["__proto__", "prototype", "constructor"].includes(segment)) throw new Error(`world predicate[${index}] contains an unsafe path segment`);
    });
    immutableJson(predicate.expected);
  });
  for (const goal of goals) if (!predicateIds.has(goal)) throw new Error(`goal predicate ${goal} is not defined`);
  const parseBindings = (value: unknown, kind: "step" | "obligation", registered: readonly string[]) => {
    if (!Array.isArray(value)) throw new Error(`${kind} predicate bindings must be an array`);
    const bound = new Set<string>();
    value.forEach((binding, index) => {
      exactRecord(binding, [`${kind}_id`, "predicate_id"], `${kind} predicate binding[${index}]`);
      const requirementId = binding[`${kind}_id`];
      safeId(requirementId, `${kind} predicate binding[${index}] requirement ID`);
      safeId(binding.predicate_id, `${kind} predicate binding[${index}] predicate ID`);
      if (!registered.includes(requirementId)) throw new Error(`${kind} predicate binding references unregistered ${requirementId}`);
      if (!predicateIds.has(binding.predicate_id)) throw new Error(`${kind} predicate binding references undefined predicate ${binding.predicate_id}`);
      if (bound.has(requirementId)) throw new Error(`${kind} ${requirementId} has multiple predicate bindings`);
      bound.add(requirementId);
    });
    if (bound.size !== registered.length) throw new Error(`every registered ${kind} must have exactly one predicate binding`);
  };
  parseBindings(input.step_predicate_bindings, "step", steps);
  parseBindings(input.obligation_predicate_bindings, "obligation", obligations);
  exactRecord(input.minimum_inventory, ["required_steps", "required_obligations", "required_opportunities", "forbidden_claims"], "minimum inventory");
  integer(input.minimum_inventory.required_steps, "minimum required steps"); integer(input.minimum_inventory.required_obligations, "minimum required obligations");
  integer(input.minimum_inventory.required_opportunities, "minimum required opportunities"); integer(input.minimum_inventory.forbidden_claims, "minimum forbidden claims");
  const checks: Array<[string, number, number]> = [
    ["required steps", steps.length, input.minimum_inventory.required_steps as number],
    ["required obligations", obligations.length, input.minimum_inventory.required_obligations as number],
    ["required opportunities", opportunities.length, input.minimum_inventory.required_opportunities as number],
    ["forbidden claims", forbidden.length, input.minimum_inventory.forbidden_claims as number],
    ["goal predicates", goals.length, 1],
  ];
  for (const [label, actual, minimum] of checks) if (actual < minimum) throw new Error(`${label} inventory ${actual} is below frozen minimum ${minimum}`);
  return input as unknown as FrozenEvidenceEvaluationContractV2;
}

export function frozenEvidenceEvaluationContractSha256V2(input: FrozenEvidenceEvaluationContractV2): string {
  const contract = validateFrozenEvidenceEvaluationContractV2(input);
  return sha256Hex(`${CONTRACT_DOMAIN}${canonicalJson(contract)}`);
}
