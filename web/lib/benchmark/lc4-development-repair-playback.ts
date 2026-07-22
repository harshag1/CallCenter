import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  assertLc4DevAudioArtifacts,
  type Lc4DevAudioManifest,
  type Lc4DevRepairAudioBinding,
  type Lc4DevRepairAudioManifest,
} from "./lc4-development-audio-materializer";
import type { Lc4DevControlReceipt, Lc4DevLiveEpisodePlan } from "./lc4-development-live-runner";
import {
  assertLc4DevArmBlindRepairProjection,
  type Lc4DevArmBlindRepairProjection,
} from "./lc4-development-headless-listener-authority";
import {
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import {
  createConversationalRepairPlan,
  createConversationalRepairState,
  decideConversationalRepair,
  type ConversationalRepairBlocker,
  type ConversationalRepairDecision,
  type ConversationalRepairPlan,
  type ConversationalRepairState,
} from "./conversational-repair";

const HASH = /^[a-f0-9]{64}$/u;
const PLAN_BINDING_DOMAIN = "harshas-amazing-call-center/lc4-dev-repair-plan-binding/v1\n";
const DECISION_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-repair-decision-receipt/v1\n";
const PLAYBACK_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-repair-playback-receipt/v1\n";

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function hash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function repairPlan(
  corpus: Lc4PublicDevelopmentCorpus,
  manifest: Lc4DevRepairAudioManifest,
  provider: Lc4DevLiveEpisodePlan["provider"],
): ConversationalRepairPlan {
  const bindings = manifest.repair_audio_bindings.filter((binding) => binding.provider === provider);
  if (bindings.length !== 24) throw new Error(`LC4-DEV ${provider} repair inventory must contain exactly 24 bindings`);
  const stages = [...new Set(corpus.opportunities.map((opportunity) => opportunity.stage_id))];
  return createConversationalRepairPlan({
    schema_version: 1,
    protocol_id: "HACC-LC4-v1",
    scenario_id: "lc4dev.municipal.oral_history",
    scenario_version: "v1",
    stages: stages.map((stageId) => ({
      stage_id: stageId,
      applicable_blockers: corpus.repair_policy.blocker_precedence.filter((blocker) =>
        bindings.some((binding) => binding.stage_id === stageId && binding.blocker_code === blocker)
      ) as readonly ConversationalRepairBlocker[],
    })),
    pcm_inventory: bindings.map((binding) => ({
      repair_pcm_id: binding.repair_id,
      stage_id: binding.stage_id,
      blocker_code: binding.blocker_code as ConversationalRepairBlocker,
      repair_ordinal: binding.repair_ordinal,
      source_text_sha256: binding.source_text_sha256,
      pcm_sha256: binding.pcm_sha256,
      byte_length: binding.pcm_byte_length,
      sample_rate_hz: binding.sample_rate_hz,
      channels: 1,
      encoding: "pcm16le",
      voice_id: "lc4devvoice.synthetic",
      repeats_spoken_fact_ids: [],
    })),
  });
}

export type Lc4DevRepairDecisionReceipt = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-DEV-v1";
  episode_id: string;
  canonical_opportunity_id: string;
  canonical_ordinal: number;
  canonical_horizon: 60;
  advances_canonical_horizon: false;
  canonical_control_receipt_sha256: string;
  canonical_exchange_sha256: string;
  canonical_listener_evidence_sha256: string;
  semantic_replay_sha256: string;
  plan_sha256: string;
  plan_binding_sha256: string;
  decision: ConversationalRepairDecision;
  state_after_sha256: string;
  decision_receipt_sha256: string;
}>;

export type Lc4DevRepairPlayback = Readonly<{
  kind: "repair";
  advances_canonical_horizon: false;
  recursive_repair_allowed: false;
  episode_id: string;
  opportunity_id: string;
  canonical_ordinal: number;
  canonical_horizon: 60;
  provider: Lc4DevLiveEpisodePlan["provider"];
  stage_id: string;
  blocker_code: ConversationalRepairBlocker;
  repair_ordinal: 1 | 2;
  repair_pcm_id: string;
  source_text_sha256: string;
  pcm_sha256: string;
  pcm_byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  channels: 1;
  encoding: "pcm16le";
  pcm: Uint8Array;
  decision_receipt_sha256: string;
}>;

export type Lc4DevRepairPlaybackReceipt = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-DEV-v1";
  episode_id: string;
  canonical_opportunity_id: string;
  canonical_ordinal: number;
  canonical_horizon: 60;
  advances_canonical_horizon: false;
  recursive_repair_observation: null;
  decision_receipt_sha256: string;
  repair_pcm_id: string;
  submitted_pcm_sha256: string;
  submitted_pcm_byte_length: number;
  submitted_sample_rate_hz: 16_000 | 24_000;
  provider_exchange_sha256: string;
  listener_evidence_sha256: string;
  playback_authority_receipt_sha256: string;
  playback_receipt_sha256: string;
}>;

export type Lc4DevRepairPlaybackController = Readonly<{
  provider: Lc4DevLiveEpisodePlan["provider"];
  repair_manifest_sha256: string;
  plan_sha256: string;
  decide(input: Readonly<{
    episode: Lc4DevLiveEpisodePlan;
    opportunity: Lc4PublicDevOpportunity;
    control_receipt: Lc4DevControlReceipt;
    canonical_exchange_sha256: string;
    canonical_listener_evidence_sha256: string;
    listener_projection: Lc4DevArmBlindRepairProjection;
  }>): Promise<Readonly<{
    receipt: Lc4DevRepairDecisionReceipt;
    playback: Lc4DevRepairPlayback | null;
  }>>;
  complete(input: Readonly<{
    playback: Lc4DevRepairPlayback;
    provider_exchange_sha256: string;
    listener_evidence_sha256: string;
    playback_authority_receipt_sha256: string;
    recursive_repair_observation: null;
  }>): Lc4DevRepairPlaybackReceipt;
  state(episodeId: string): ConversationalRepairState;
}>;

/**
 * DEV-only CRP playback authority. Selection consumes only the replay-verified,
 * provider/arm-blind semantic projection and public receipt hashes. It never
 * accepts a model transcript, prompt, capability grant, condition label, arm,
 * or caller-supplied blocker boolean.
 */
export function createLc4DevRepairPlaybackController(input: Readonly<{
  provider: Lc4DevLiveEpisodePlan["provider"];
  audio_manifest: Lc4DevAudioManifest;
  repair_manifest: Lc4DevRepairAudioManifest;
  load_repair_pcm(binding: Lc4DevRepairAudioBinding): Promise<Uint8Array>;
  corpus?: Lc4PublicDevelopmentCorpus;
}>): Lc4DevRepairPlaybackController {
  const corpus = input.corpus ?? createLc4PublicDevelopmentCorpus();
  assertLc4PublicDevelopmentCorpus(corpus);
  assertLc4DevAudioArtifacts({ manifest: input.audio_manifest, repairManifest: input.repair_manifest, corpus });
  const plan = repairPlan(corpus, input.repair_manifest, input.provider);
  const planBindingSha256 = hash(PLAN_BINDING_DOMAIN, {
    corpus_sha256: corpus.artifact_sha256,
    audio_manifest_sha256: input.audio_manifest.manifest_sha256,
    repair_manifest_sha256: input.repair_manifest.repair_manifest_sha256,
    provider_profile_manifest_sha256: input.repair_manifest.provider_profile_manifest_sha256,
    provider: input.provider,
    plan_sha256: plan.plan_sha256,
  });
  const states = new Map<string, ConversationalRepairState>();
  const nextCanonical = new Map<string, number>();
  const pending = new Map<string, Lc4DevRepairPlayback>();

  return Object.freeze({
    provider: input.provider,
    repair_manifest_sha256: input.repair_manifest.repair_manifest_sha256,
    plan_sha256: plan.plan_sha256,
    decide: async ({ episode, opportunity, control_receipt, canonical_exchange_sha256, canonical_listener_evidence_sha256, listener_projection }) => {
      if (episode.provider !== input.provider) throw new Error("LC4-DEV repair controller provider differs from episode");
      if (pending.has(episode.episode_id)) throw new Error("LC4-DEV selected repair must complete before the next canonical opportunity");
      const expectedOrdinal = nextCanonical.get(episode.episode_id) ?? 1;
      if (opportunity.index !== expectedOrdinal || corpus.opportunities[expectedOrdinal - 1]?.id !== opportunity.id) {
        throw new Error("LC4-DEV repair decisions must follow the exact canonical horizon without extension or replay");
      }
      requireHash(control_receipt.control_receipt_sha256, "LC4-DEV canonical control receipt");
      requireHash(canonical_exchange_sha256, "LC4-DEV canonical exchange");
      requireHash(canonical_listener_evidence_sha256, "LC4-DEV canonical listener evidence");
      assertLc4DevArmBlindRepairProjection(listener_projection);
      if (listener_projection.opportunity_id !== opportunity.id) {
        throw new Error("LC4-DEV repair requires exact verified listener semantics for the canonical response");
      }
      const deadlineReached = opportunity.expected_oracle.repair_stage_id === opportunity.stage_id;
      const earliest = listener_projection.unmet_blocker_codes[0] ?? null;
      const state = states.get(episode.episode_id) ?? createConversationalRepairState(plan, episode.episode_id);
      const facts = corpus.opportunities.slice(0, opportunity.index).flatMap((item) =>
        item.fact_bindings.map((binding) => `${binding.fact_key}.v${binding.version}`)
      );
      const result = decideConversationalRepair({
        plan,
        state,
        observation: {
          schema_version: 1,
          episode_id: episode.episode_id,
          caller_turn_id: opportunity.id,
          canonical_opportunity_id: opportunity.id,
          stage_id: opportunity.stage_id,
          deadline_reached: deadlineReached,
          common_state_sha256: control_receipt.native_continuity_state_sha256,
          listener_heard_semantics_sha256: listener_projection.semantic_replay_sha256,
          spoken_caller_fact_ids: [...new Set(facts)].sort(),
          visible_receipt_ids: [`control.${control_receipt.control_receipt_sha256}`, `exchange.${canonical_exchange_sha256}`],
          visible_worker_result_ids: [`worker.${control_receipt.worker_state_sha256}`],
          unmet_blocker_codes: earliest === null ? [] : [earliest as ConversationalRepairBlocker],
        },
      });
      if (result.replayed) throw new Error("LC4-DEV canonical repair decision replay is forbidden");
      states.set(episode.episode_id, result.state);
      nextCanonical.set(episode.episode_id, expectedOrdinal + 1);
      const receiptBody = {
        schema_version: 1 as const,
        protocol_id: "HACC-LC4-DEV-v1" as const,
        episode_id: episode.episode_id,
        canonical_opportunity_id: opportunity.id,
        canonical_ordinal: opportunity.index,
        canonical_horizon: 60 as const,
        advances_canonical_horizon: false as const,
        canonical_control_receipt_sha256: control_receipt.control_receipt_sha256,
        canonical_exchange_sha256,
        canonical_listener_evidence_sha256,
        semantic_replay_sha256: listener_projection.semantic_replay_sha256,
        plan_sha256: plan.plan_sha256,
        plan_binding_sha256: planBindingSha256,
        decision: result.decision,
        state_after_sha256: result.state.state_sha256,
      };
      const receipt = freeze({ ...receiptBody, decision_receipt_sha256: hash(DECISION_RECEIPT_DOMAIN, receiptBody) });
      if (!result.decision.selection) return Object.freeze({ receipt, playback: null });
      const selected = result.decision.selection;
      const binding = input.repair_manifest.repair_audio_bindings.find((candidate) =>
        candidate.provider === input.provider
        && candidate.repair_id === selected.repair_pcm_id
        && candidate.stage_id === selected.stage_id
        && candidate.blocker_code === selected.blocker_code
        && candidate.repair_ordinal === selected.repair_ordinal
      );
      if (!binding || binding.pcm_sha256 !== selected.pcm_sha256
        || binding.pcm_byte_length !== selected.byte_length
        || binding.sample_rate_hz !== selected.sample_rate_hz) {
        throw new Error("LC4-DEV repair decision is not bound to the exact provider-rate manifest entry");
      }
      const pcm = Uint8Array.from(await input.load_repair_pcm(binding));
      if (pcm.byteLength !== binding.pcm_byte_length || sha256Hex(pcm) !== binding.pcm_sha256) {
        throw new Error("LC4-DEV loaded repair PCM differs from its immutable provider binding");
      }
      const playback = Object.freeze({
        kind: "repair" as const,
        advances_canonical_horizon: false as const,
        recursive_repair_allowed: false as const,
        episode_id: episode.episode_id,
        opportunity_id: opportunity.id,
        canonical_ordinal: opportunity.index,
        canonical_horizon: 60 as const,
        provider: input.provider,
        stage_id: binding.stage_id,
        blocker_code: binding.blocker_code as ConversationalRepairBlocker,
        repair_ordinal: binding.repair_ordinal,
        repair_pcm_id: binding.repair_id,
        source_text_sha256: binding.source_text_sha256,
        pcm_sha256: binding.pcm_sha256,
        pcm_byte_length: binding.pcm_byte_length,
        sample_rate_hz: binding.sample_rate_hz,
        channels: 1 as const,
        encoding: "pcm16le" as const,
        pcm: pcm.slice(),
        decision_receipt_sha256: receipt.decision_receipt_sha256,
      });
      pending.set(episode.episode_id, playback);
      return Object.freeze({ receipt, playback });
    },
    complete: ({ playback, provider_exchange_sha256, listener_evidence_sha256, playback_authority_receipt_sha256, recursive_repair_observation }) => {
      const expected = pending.get(playback.episode_id);
      if (!expected || canonicalJson({ ...expected, pcm: [...expected.pcm] }) !== canonicalJson({ ...playback, pcm: [...playback.pcm] })) {
        throw new Error("LC4-DEV repair playback is absent, duplicated, or differs from the pending selection");
      }
      if (recursive_repair_observation !== null) throw new Error("LC4-DEV repair playback cannot create a recursive repair observation");
      for (const [digest, label] of [
        [provider_exchange_sha256, "provider exchange"],
        [listener_evidence_sha256, "listener evidence"],
        [playback_authority_receipt_sha256, "playback authority"],
      ] as const) requireHash(digest, `LC4-DEV repair ${label}`);
      if (playback.pcm.byteLength !== playback.pcm_byte_length || sha256Hex(playback.pcm) !== playback.pcm_sha256) {
        throw new Error("LC4-DEV repair playback bytes mutated after selection");
      }
      const body = {
        schema_version: 1 as const,
        protocol_id: "HACC-LC4-DEV-v1" as const,
        episode_id: playback.episode_id,
        canonical_opportunity_id: playback.opportunity_id,
        canonical_ordinal: playback.canonical_ordinal,
        canonical_horizon: 60 as const,
        advances_canonical_horizon: false as const,
        recursive_repair_observation: null,
        decision_receipt_sha256: playback.decision_receipt_sha256,
        repair_pcm_id: playback.repair_pcm_id,
        submitted_pcm_sha256: playback.pcm_sha256,
        submitted_pcm_byte_length: playback.pcm_byte_length,
        submitted_sample_rate_hz: playback.sample_rate_hz,
        provider_exchange_sha256,
        listener_evidence_sha256,
        playback_authority_receipt_sha256,
      };
      pending.delete(playback.episode_id);
      return freeze({ ...body, playback_receipt_sha256: hash(PLAYBACK_RECEIPT_DOMAIN, body) });
    },
    state: (episodeId) => {
      const state = states.get(episodeId);
      if (!state) throw new Error("LC4-DEV repair episode has not started");
      return state;
    },
  });
}
