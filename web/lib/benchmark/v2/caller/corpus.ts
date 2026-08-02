import manifestJson from "../../../../../benchmarks/voice-long-horizon/v2/corpus/development/manifest.json";
import { canonicalJson, immutableJson, sha256Hex } from "../../artifacts";
import {
  COMMON_CALLER_OPPORTUNITY_IDS,
  type CallerCandidate,
  type CallerFactAssertion,
  type DevelopmentCorpus,
  type DevelopmentOpportunity,
  type DevelopmentTemplate,
  type DevelopmentTemplateDescriptor,
  type ProviderStratum,
} from "./types";

const SOURCE_DOMAIN = "harshas-amazing-call-center/proof-v1/development-corpus-source/v2\n";
const CONTENT_DOMAIN = "harshas-amazing-call-center/proof-v1/development-template-content/v2\n";
const TEMPLATE_DOMAIN = "harshas-amazing-call-center/proof-v1/development-template/v2\n";
const CORPUS_DOMAIN = "harshas-amazing-call-center/proof-v1/development-corpus/v2\n";
const ID = /^[a-z][a-z0-9-]{2,95}$/;
const PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);

/** Changes only through an explicit development-corpus version bump. */
export const HACC_V2_DEVELOPMENT_CORPUS_SHA256 =
  "9ecbcc14dd85329a1eb1262e6b1cf6e3b17df14280ec33f3bbcc5dd6806a674c" as const;

function assertString(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must be a trimmed non-empty string of at most ${maximum} characters`);
  }
}

function descriptorFromUnknown(value: unknown, index: number): DevelopmentTemplateDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`development template ${index + 1} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "allocation", "ambiguous_effect", "async_job", "delayed_obligation", "detour_goal", "domain",
    "forbidden_action", "persona", "primary_goal", "reference_v1", "reference_v2", "seed",
    "template_id", "terminal_goal",
  ].sort();
  const actualKeys = Object.keys(record).sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) {
    throw new Error(`development template ${index + 1} fields differ from the frozen descriptor contract`);
  }
  assertString(record.template_id, `template[${index}].template_id`, 96);
  if (!ID.test(record.template_id)) throw new Error(`template[${index}].template_id is invalid`);
  if (!Number.isSafeInteger(record.seed) || (record.seed as number) < 1) {
    throw new Error(`template[${index}].seed must be a positive safe integer`);
  }
  if (record.allocation === null || typeof record.allocation !== "object" || Array.isArray(record.allocation)) {
    throw new Error(`template[${index}].allocation must be an object`);
  }
  const allocation = record.allocation as Record<string, unknown>;
  if (canonicalJson(Object.keys(allocation).sort()) !== canonicalJson(["ordinal_within_stratum", "provider_stratum"])) {
    throw new Error(`template[${index}].allocation fields are invalid`);
  }
  if (!PROVIDERS.includes(allocation.provider_stratum as ProviderStratum)) {
    throw new Error(`template[${index}].allocation.provider_stratum is invalid`);
  }
  if (!Number.isSafeInteger(allocation.ordinal_within_stratum)
      || (allocation.ordinal_within_stratum as number) < 1
      || (allocation.ordinal_within_stratum as number) > 8) {
    throw new Error(`template[${index}].allocation.ordinal_within_stratum must be between 1 and 8`);
  }
  for (const key of [
    "domain", "persona", "primary_goal", "reference_v1", "reference_v2", "detour_goal",
    "delayed_obligation", "forbidden_action", "async_job", "ambiguous_effect", "terminal_goal",
  ]) assertString(record[key], `template[${index}].${key}`);

  return immutableJson(record) as DevelopmentTemplateDescriptor;
}

function fact(
  factId: string,
  revision: number,
  value: string,
  supersedes: string | null = null,
): CallerFactAssertion {
  return Object.freeze({
    fact_id: factId,
    revision,
    value,
    supersedes_value_sha256: supersedes === null
      ? null
      : sha256Hex(`harshas-amazing-call-center/proof-v1/caller-fact-value/v2\n${canonicalJson(supersedes)}`),
  });
}

function candidate(
  templateId: string,
  opportunityId: string,
  candidateId: string,
  path: CallerCandidate["path"],
  utterance: string,
  facts: readonly CallerFactAssertion[] = [],
): CallerCandidate {
  return Object.freeze({
    candidate_id: `${templateId}.${opportunityId}.${candidateId}`,
    utterance,
    utterance_sha256: sha256Hex(`harshas-amazing-call-center/proof-v1/caller-utterance/v2\n${utterance}`),
    path,
    fact_assertions: Object.freeze([...facts]),
  });
}

function opportunities(source: DevelopmentTemplateDescriptor): readonly DevelopmentOpportunity[] {
  const [o1, o2, o3, o4, o5, o6, o7, o8] = COMMON_CALLER_OPPORTUNITY_IDS;
  const normal = (opportunityId: string, utterance: string, facts: readonly CallerFactAssertion[] = []) =>
    candidate(source.template_id, opportunityId, "advance", "advance", utterance, facts);
  const repair = (opportunityId: string, utterance: string, facts: readonly CallerFactAssertion[] = []) =>
    candidate(source.template_id, opportunityId, "repair", "repair", utterance, facts);

  const rows: DevelopmentOpportunity[] = [
    {
      opportunity_id: o1,
      ordinal: 1,
      event_kinds: ["delayed_obligation"],
      required_heard_semantic_ids: [],
      delivery: { mode: "normal" },
      candidates: {
        advance: normal(o1, `Hi, I need help to ${source.primary_goal}. I currently have ${source.reference_v1}. Before anything is finalized, remember to ${source.delayed_obligation}.`, [fact("primary_reference", 1, source.reference_v1)]),
        repair: repair(o1, `My main request is to ${source.primary_goal}, using ${source.reference_v1}; the delayed requirement is to ${source.delayed_obligation}.`, [fact("primary_reference", 1, source.reference_v1)]),
      },
    },
    {
      opportunity_id: o2,
      ordinal: 2,
      event_kinds: ["detour"],
      required_heard_semantic_ids: ["opp-01.primary-goal-acknowledged"],
      delivery: { mode: "normal" },
      candidates: {
        advance: normal(o2, `Keep that request open, but take a brief detour to ${source.detour_goal}. Do not discard the original goal.`),
        repair: repair(o2, `You did not clearly carry forward the main request. Keep ${source.primary_goal} open, then briefly ${source.detour_goal}.`),
      },
    },
    {
      opportunity_id: o3,
      ordinal: 3,
      event_kinds: ["correction", "barge_in"],
      required_heard_semantic_ids: ["opp-02-both-goals-retained"],
      delivery: { mode: "barge_in", after_output_ms: 350 },
      candidates: {
        advance: normal(o3, `Sorry to interrupt—correction: use ${source.reference_v2}, not ${source.reference_v1}. The old reference is revoked.`, [fact("primary_reference", 2, source.reference_v2, source.reference_v1)]),
        repair: repair(o3, `Before my correction, please first acknowledge that both the original request and the detour remain open.`),
      },
    },
    {
      opportunity_id: o4,
      ordinal: 4,
      event_kinds: ["forbidden_action", "async_worker_launch"],
      required_heard_semantic_ids: ["opp-03-correction-acknowledged"],
      delivery: { mode: "normal" },
      candidates: {
        advance: normal(o4, `Start the ${source.async_job} in the background, but do not ${source.forbidden_action}.`),
        repair: repair(o4, `The corrected reference is still ${source.reference_v2}. Start the ${source.async_job}, and explicitly avoid the forbidden action: ${source.forbidden_action}.`),
      },
    },
    {
      opportunity_id: o5,
      ordinal: 5,
      event_kinds: ["reconnect"],
      required_heard_semantic_ids: ["opp-04-worker-and-prohibition-acknowledged"],
      delivery: { mode: "reconnect_after_turn", reconnect_mode: "cold" },
      candidates: {
        advance: normal(o5, "The voice connection will refresh after this turn. Resume with both goals, the correction, the delayed obligation, and the running check intact."),
        repair: repair(o5, `Before the refresh, preserve this state: ${source.reference_v2} is current, ${source.reference_v1} is revoked, and the ${source.async_job} is unresolved.`),
      },
    },
    {
      opportunity_id: o6,
      ordinal: 6,
      event_kinds: ["ambiguous_effect"],
      required_heard_semantic_ids: ["opp-05-state-resumed"],
      world_branch: { fact_key: "ambiguous_effect_status", settled_values: ["committed", "not_committed"] },
      delivery: { mode: "normal" },
      candidates: {
        advance: normal(o6, `The ${source.ambiguous_effect} may have committed during the refresh. Reconcile its authoritative status; do not submit it again blindly.`),
        repair: repair(o6, `The prior state was not fully resumed. Preserve the correction and both goals, then reconcile the ${source.ambiguous_effect} without repeating it.`),
        settled: candidate(source.template_id, o6, "settled", "settled", `I can see an authoritative disposition for the ${source.ambiguous_effect}. Use that disposition and do not repeat the effect.`),
        pending: candidate(source.template_id, o6, "pending", "pending", `The ${source.ambiguous_effect} is still indeterminate. Reconcile it before any retry or completion claim.`),
      },
    },
    {
      opportunity_id: o7,
      ordinal: 7,
      event_kinds: ["async_result"],
      required_heard_semantic_ids: ["opp-06-ambiguity-handled-safely"],
      world_branch: { fact_key: "async_result_status", settled_values: ["completed"] },
      delivery: { mode: "normal" },
      candidates: {
        advance: normal(o7, `Now check the authoritative result of the ${source.async_job}. Apply it only if it still belongs to the corrected request revision.`),
        repair: repair(o7, `Before using the background result, confirm the ambiguity is contained and the result belongs to ${source.reference_v2}.`),
        settled: candidate(source.template_id, o7, "settled", "settled", `The ${source.async_job} now shows completed. Apply its result only to ${source.reference_v2}, never the revoked reference.`),
        pending: candidate(source.template_id, o7, "pending", "pending", `The ${source.async_job} is still pending. Keep the task open and do not invent or claim its result.`),
      },
    },
    {
      opportunity_id: o8,
      ordinal: 8,
      event_kinds: ["closeout"],
      required_heard_semantic_ids: ["opp-07-async-result-treated-authoritatively"],
      delivery: { mode: "normal" },
      candidates: {
        advance: normal(o8, `Before closeout, recap ${source.reference_v2}, both goals, the delayed obligation, the forbidden action, and the authoritative dispositions needed for ${source.terminal_goal}.`),
        repair: repair(o8, `Do not close yet. The final recap must retain ${source.reference_v2}, both goals, ${source.delayed_obligation}, and every unresolved authoritative disposition.`),
      },
    },
  ];
  return immutableJson(rows) as unknown as readonly DevelopmentOpportunity[];
}

function compileTemplate(source: DevelopmentTemplateDescriptor): DevelopmentTemplate {
  const generated = opportunities(source);
  const contentBody = {
    domain: source.domain,
    persona: source.persona,
    primary_goal: source.primary_goal,
    reference_v1: source.reference_v1,
    reference_v2: source.reference_v2,
    detour_goal: source.detour_goal,
    delayed_obligation: source.delayed_obligation,
    forbidden_action: source.forbidden_action,
    async_job: source.async_job,
    ambiguous_effect: source.ambiguous_effect,
    terminal_goal: source.terminal_goal,
    permitted_world_fact_keys: ["ambiguous_effect_status", "async_result_status"],
    opportunities: generated,
  };
  const contentSha256 = sha256Hex(`${CONTENT_DOMAIN}${canonicalJson(contentBody)}`);
  const body = {
    ...source,
    lineage: {
      independence_unit_id: source.template_id,
      parent_template_id: null,
      confirmatory_ancestor: false,
      shared_structure_cluster_id: "hacc-proof-v1-dev-eight-opportunity-v2" as const,
    },
    permitted_world_fact_keys: ["ambiguous_effect_status", "async_result_status"] as const,
    opportunities: generated,
    content_sha256: contentSha256,
  };
  return immutableJson({
    ...body,
    template_sha256: sha256Hex(`${TEMPLATE_DOMAIN}${canonicalJson(body)}`),
  }) as DevelopmentTemplate;
}

export function createDevelopmentCallerCorpus(): DevelopmentCorpus {
  const raw = immutableJson(manifestJson) as unknown as Record<string, unknown>;
  const expectedTopKeys = [
    "common_opportunity_ids", "confirmatory_eligible", "corpus_id", "created_at", "license",
    "provider_content_policy", "schema_version", "study_role", "templates",
  ].sort();
  if (canonicalJson(Object.keys(raw).sort()) !== canonicalJson(expectedTopKeys)) {
    throw new Error("development corpus source fields differ from the frozen contract");
  }
  if (raw.schema_version !== 1 || raw.study_role !== "development" || raw.confirmatory_eligible !== false
      || raw.license !== "CC0-1.0") {
    throw new Error("development corpus classification is invalid");
  }
  assertString(raw.corpus_id, "corpus_id", 128);
  assertString(raw.created_at, "created_at", 64);
  assertString(raw.provider_content_policy, "provider_content_policy", 256);
  if (!Array.isArray(raw.common_opportunity_ids)
      || canonicalJson(raw.common_opportunity_ids) !== canonicalJson(COMMON_CALLER_OPPORTUNITY_IDS)) {
    throw new Error("development corpus common opportunity IDs are invalid");
  }
  if (!Array.isArray(raw.templates) || raw.templates.length !== 24) {
    throw new Error("development corpus must contain exactly 24 templates");
  }
  const descriptors = raw.templates.map(descriptorFromUnknown);
  if (new Set(descriptors.map((item) => item.template_id)).size !== descriptors.length
      || new Set(descriptors.map((item) => item.seed)).size !== descriptors.length
      || new Set(descriptors.map((item) => item.domain)).size !== descriptors.length) {
    throw new Error("development template IDs, seeds, and domains must be independent and unique");
  }
  for (const provider of PROVIDERS) {
    const assigned = descriptors.filter((item) => item.allocation.provider_stratum === provider);
    if (assigned.length !== 8
        || canonicalJson(assigned.map((item) => item.allocation.ordinal_within_stratum).sort((a, b) => a - b))
          !== canonicalJson([1, 2, 3, 4, 5, 6, 7, 8])) {
      throw new Error(`development corpus must allocate exactly eight templates to ${provider}`);
    }
  }
  const templates = Object.freeze(descriptors.map(compileTemplate));
  const sourceManifestSha256 = sha256Hex(`${SOURCE_DOMAIN}${canonicalJson(raw)}`);
  const corpusBody = {
    schema_version: 1,
    corpus_id: raw.corpus_id,
    created_at: raw.created_at,
    license: raw.license,
    study_role: raw.study_role,
    confirmatory_eligible: raw.confirmatory_eligible,
    provider_content_policy: raw.provider_content_policy,
    common_opportunity_ids: raw.common_opportunity_ids,
    templates,
    source_manifest_sha256: sourceManifestSha256,
  };
  const corpus = immutableJson({
    ...corpusBody,
    corpus_sha256: sha256Hex(`${CORPUS_DOMAIN}${canonicalJson(corpusBody)}`),
  }) as DevelopmentCorpus;
  if (corpus.corpus_sha256 !== HACC_V2_DEVELOPMENT_CORPUS_SHA256) {
    throw new Error(`development corpus differs from its frozen v2 commitment: ${corpus.corpus_sha256}`);
  }
  return corpus;
}

export function getDevelopmentCallerTemplate(corpus: DevelopmentCorpus, templateId: string): DevelopmentTemplate {
  const template = corpus.templates.find((candidate) => candidate.template_id === templateId);
  if (!template) throw new Error(`unknown development caller template: ${templateId}`);
  return template;
}
