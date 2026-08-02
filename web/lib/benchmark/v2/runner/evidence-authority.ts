import {
  EvidenceTapV2,
  frozenEvidenceEvaluationContractSha256V2,
  replayEvidenceBundleV2,
  serializeEvidenceBundleV2,
  validateFrozenEvidenceEvaluationContractV2,
  type EvidenceArtifactResolverV2,
  type EvidenceBundleV2,
  type EvidenceEventTypeV2,
  type EvidencePayloadByTypeV2,
  type EvidenceReplayResultV2,
  type EvidenceSignerV2,
  type EvidenceTrustV2,
  type FrozenEvidenceEvaluationContractV2,
  type TerminalJournalPayload,
} from "../../../evidence-v2";
import type { CompiledCondition, ScheduledUnit } from "./types";

type AppendableEvent = Exclude<
  EvidenceEventTypeV2,
  "plan.registered" | "catalog.published" | "journal.terminal"
>;

export type EvidenceObservationV2<T extends AppendableEvent = AppendableEvent> = Readonly<{
  event_type: T;
  observed_at: string;
  payload: EvidencePayloadByTypeV2[T];
}>;

export type FrozenUnitEvidenceBindingV2 = Readonly<{
  evaluation_contract: FrozenEvidenceEvaluationContractV2;
  expected_evaluation_contract_sha256: string;
  artifact_resolver: EvidenceArtifactResolverV2;
  trust: EvidenceTrustV2;
}>;

export type FinalizedUnitEvidenceV2 = Readonly<{
  bundle: EvidenceBundleV2;
  replay: EvidenceReplayResultV2;
}>;

export class ProductionUnitEvidenceSessionV2 {
  readonly #tap: EvidenceTapV2;
  readonly #binding: FrozenUnitEvidenceBindingV2;
  readonly #runId: string;
  #finalized = false;

  constructor(input: Readonly<{
    runId: string;
    signer: EvidenceSignerV2;
    binding: FrozenUnitEvidenceBindingV2;
    now?: () => Date;
  }>) {
    this.#runId = input.runId;
    this.#binding = input.binding;
    this.#tap = new EvidenceTapV2({ runId: input.runId, signer: input.signer, now: input.now });
    const contract = input.binding.evaluation_contract;
    this.#tap.append("plan.registered", {
      plan_id: contract.plan.plan_id,
      revision: contract.plan.revision,
      plan_sha256: contract.plan.artifact.sha256,
      required_step_ids: contract.plan.required_step_ids,
      required_obligation_ids: contract.required_obligation_ids,
      forbidden_claim_ids: contract.forbidden_claim_ids,
    });
    this.#tap.append("catalog.published", {
      catalog_id: contract.catalog.catalog_id,
      plan_id: contract.plan.plan_id,
      revision: contract.catalog.revision,
      catalog_sha256: contract.catalog.artifact.sha256,
      capability_ids: contract.catalog.capability_ids,
    });
  }

  append<T extends AppendableEvent>(observation: EvidenceObservationV2<T>): void {
    if (this.#finalized) throw new Error("production evidence session is finalized");
    this.#tap.append(observation.event_type, observation.payload, observation.observed_at);
  }

  finalizeAndEvaluate(terminal: TerminalJournalPayload, observedAt?: string): FinalizedUnitEvidenceV2 {
    if (this.#finalized) throw new Error("production evidence session can only finalize once");
    const bundle = this.#tap.finalize(terminal, observedAt);
    this.#finalized = true;
    // Evaluation can only see canonical bytes after EvidenceTapV2 has closed
    // and signed the raw event chain.
    const replay = replayEvidenceBundleV2(serializeEvidenceBundleV2(bundle), {
      trust: this.#binding.trust,
      expectedRunId: this.#runId,
      evaluationContract: this.#binding.evaluation_contract,
      expectedEvaluationContractSha256: this.#binding.expected_evaluation_contract_sha256,
      artifactResolver: this.#binding.artifact_resolver,
    });
    return Object.freeze({ bundle, replay });
  }
}
/**
 * Production evidence authority. The paid runner uses nominal instance checks
 * so a benchmark-local object with the same method names cannot replace this
 * EvidenceTapV2/frozen-contract boundary.
 */
export class ProductionEvidenceAuthorityV2 {
  readonly authority_kind = "production_evidence_tap_v2" as const;
  readonly #signer: EvidenceSignerV2;
  readonly #bindings: ReadonlyMap<string, FrozenUnitEvidenceBindingV2>;
  readonly #now?: () => Date;

  constructor(input: Readonly<{
    signer: EvidenceSignerV2;
    unitBindings: Readonly<Record<string, FrozenUnitEvidenceBindingV2>>;
    now?: () => Date;
  }>) {
    if (input.signer.algorithm !== "ed25519") throw new Error("production EvidenceTapV2 authority requires Ed25519");
    const entries = Object.entries(input.unitBindings);
    if (entries.length === 0) throw new Error("production evidence authority requires frozen unit bindings");
    for (const [unitId, binding] of entries) {
      if (!unitId) throw new Error("evidence unit binding ID is invalid");
      const contract = validateFrozenEvidenceEvaluationContractV2(binding.evaluation_contract);
      if (frozenEvidenceEvaluationContractSha256V2(contract)
        !== binding.expected_evaluation_contract_sha256) {
        throw new Error(`evaluation contract hash mismatch for ${unitId}`);
      }
      if (binding.artifact_resolver.resolver_id !== contract.artifact_resolver_id) {
        throw new Error(`artifact resolver differs from frozen contract for ${unitId}`);
      }
      if (binding.trust.signer_id !== input.signer.signer_id
        || binding.trust.public_key_pem !== input.signer.public_key_pem) {
        throw new Error(`evidence trust differs from runtime signer for ${unitId}`);
      }
    }
    this.#signer = input.signer;
    this.#bindings = new Map(entries);
    this.#now = input.now;
  }

  begin(unit: ScheduledUnit, condition: CompiledCondition): ProductionUnitEvidenceSessionV2 {
    this.assertReady(unit);
    const binding = this.#bindings.get(unit.unit_id);
    if (!binding) throw new Error(`missing frozen evidence binding for ${unit.unit_id}`);
    return new ProductionUnitEvidenceSessionV2({
      runId: condition.unit_id,
      signer: this.#signer,
      binding,
      now: this.#now,
    });
  }

  assertReady(unit: ScheduledUnit): void {
    const binding = this.#bindings.get(unit.unit_id);
    if (!binding) throw new Error(`missing frozen evidence binding for ${unit.unit_id}`);
    const contract = binding.evaluation_contract;
    if (contract.scenario_artifact.sha256 !== unit.scenario_sha256
      || contract.plan.artifact.sha256 !== unit.substantive_context_sha256
      || contract.catalog.artifact.sha256 !== unit.tools_sha256) {
      throw new Error(`frozen evidence artifacts do not match scheduled condition ${unit.unit_id}`);
    }
  }
}
