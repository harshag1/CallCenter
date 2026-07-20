import { canonicalJson } from "./artifacts";
import type { BenchmarkExecutionPlan } from "./execution-plan";
import {
  LONG_HORIZON_SCENARIO_SUITE,
  assessLongHorizonProviderEligibility,
  authorizeLongHorizonTemplateRun,
  type LongHorizonPcmTurn,
  type LongHorizonScenarioTemplate,
} from "./long-horizon-scenario-suite";
import type { BenchmarkScenario } from "./scenario-schema";

export const PRIMARY_LONG_HORIZON_RESPONSE_RESERVE_MS = 1_000;
export const PRIMARY_LONG_HORIZON_SETUP_TEARDOWN_RESERVE_MS = 10_000;

type PaidEvidenceMode = "canary" | "pilot" | "confirmatory";
type PlannedAuthorization = NonNullable<BenchmarkExecutionPlan["long_horizon_authorization"]>;

function exactTemplate(scenario: BenchmarkScenario): LongHorizonScenarioTemplate | null {
  const template = LONG_HORIZON_SCENARIO_SUITE.find((candidate) =>
    candidate.scenario.id === scenario.id
    && candidate.scenario.version === scenario.version
  );
  if (!template) return null;
  if (canonicalJson(template.scenario) !== canonicalJson(scenario)) {
    throw new Error("long-horizon scenario differs from its execution-policy template");
  }
  return template;
}

export type LongHorizonExecutionAuthorizationInput = Readonly<{
  scenario: BenchmarkScenario;
  callerPcm: readonly LongHorizonPcmTurn[];
  mode: PaidEvidenceMode;
  maxSessionMs: number;
  preregistrationSha256: string;
  conditionSuiteSha256: string;
  runnerConfigSha256: string;
}>;

/**
 * Derive the provider-execution grant from exact PCM bytes and recomputed
 * structural policy. Returning null means this is not a registered
 * long-horizon source; an ineligible long-horizon source throws.
 */
export function deriveLongHorizonExecutionAuthorization(
  input: LongHorizonExecutionAuthorizationInput
): PlannedAuthorization | null {
  const template = exactTemplate(input.scenario);
  if (!template) return null;
  const limits = Object.freeze({
    minimumResponseMsPerTurn: PRIMARY_LONG_HORIZON_RESPONSE_RESERVE_MS,
    setupAndTeardownReserveMs: PRIMARY_LONG_HORIZON_SETUP_TEARDOWN_RESERVE_MS,
    maxSessionMs: input.maxSessionMs,
  });
  const eligibility = assessLongHorizonProviderEligibility(template, input.callerPcm, limits);
  const purpose = input.mode === "confirmatory" ? "confirmatory" : "development";
  const freezeBundle = purpose === "confirmatory"
    ? Object.freeze({
        preregistrationHash: input.preregistrationSha256,
        conditionSuiteHash: input.conditionSuiteSha256,
        audioFixtureHash: eligibility.budget.audioFixtureBindingSha256,
        runnerConfigHash: input.runnerConfigSha256,
      })
    : undefined;
  const authorization = authorizeLongHorizonTemplateRun(template, {
    purpose,
    callerPcm: input.callerPcm,
    limits,
    ...(freezeBundle ? { freezeBundle } : {}),
  });
  const budget = authorization.providerSessionBudget;
  if (!budget) throw new Error("provider execution authorization omitted its verified PCM budget");
  return Object.freeze({
    schema_version: 1 as const,
    authorization_sha256: authorization.authorizationHash,
    purpose,
    scenario_id: authorization.scenarioId,
    scenario_version: authorization.scenarioVersion,
    execution_eligibility: template.scenario.execution_policy!.execution_eligibility as
      "development-provider-eligible" | "confirmatory-provider-eligible",
    verified_audio_binding_sha256: budget.verifiedAudioBindingSha256,
    sample_rate_hz: budget.sampleRateHz,
    caller_audio_byte_length: budget.callerAudioByteLength,
    caller_audio_duration_ms: budget.callerAudioDurationMs,
    minimum_response_ms_per_turn: budget.minimumResponseMsPerTurn,
    setup_and_teardown_reserve_ms: budget.setupAndTeardownReserveMs,
    required_session_ms: eligibility.requiredSessionMs,
    max_session_ms: budget.maxSessionMs,
    preregistration_sha256: input.preregistrationSha256,
    condition_suite_sha256: input.conditionSuiteSha256,
    runner_config_sha256: input.runnerConfigSha256,
  });
}

/** Independently recompute and compare the hash-bound execution grant. */
export function assertLongHorizonExecutionAuthorization(
  planned: BenchmarkExecutionPlan["long_horizon_authorization"],
  input: LongHorizonExecutionAuthorizationInput
): void {
  const derived = deriveLongHorizonExecutionAuthorization(input);
  if (canonicalJson(planned) !== canonicalJson(derived)) {
    throw new Error("long-horizon execution authorization differs from exact frozen PCM and policy");
  }
}
