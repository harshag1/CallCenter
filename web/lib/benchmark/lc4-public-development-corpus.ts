import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";

/**
 * Public, outcome-free development fixture for exercising the LC4 runtime.
 *
 * This corpus is deliberately outside every confirmatory LC4 family. It is
 * licensed as CC0-1.0 synthetic benchmark data and can never be promoted into
 * an LC4 confirmatory template or efficacy claim.
 */
export const LC4_PUBLIC_DEV_PROTOCOL_ID = "HACC-LC4-DEV-v1" as const;
export const LC4_PUBLIC_DEV_TEMPLATE_ID = "lc4-dev-municipal-oral-history-01" as const;
export const LC4_PUBLIC_DEV_CORPUS_LICENSE = "CC0-1.0" as const;
export const LC4_PUBLIC_DEV_CREATED_AT = "2026-07-21T00:00:00.000Z" as const;

export const LC4_CONFIRMATORY_FAMILY_SLUGS = Object.freeze([
  "freight-customs",
  "fleet-repair",
  "live-event",
  "invoice-dispute",
  "equipment-rental",
  "datacenter-maintenance",
] as const);

export const LC4_PUBLIC_DEV_PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);
export const LC4_PUBLIC_DEV_ARMS = Object.freeze(["native", "hacc"] as const);

type Arm = typeof LC4_PUBLIC_DEV_ARMS[number];
type GoalId = "goal.archive-room" | "goal.accessible-transcript";
type Act = "establish" | "interleave" | "reconcile";
type BindingRole = "introduce" | "correct" | "recall";

export const LC4_PUBLIC_DEV_BLOCKER_ORDER = Object.freeze([
  "subject_or_goal_unresolved",
  "latest_revision_unacknowledged",
  "required_evidence_missing",
  "required_worker_unresolved",
  "confirmation_invalid_or_missing",
  "ambiguity_unreconciled",
  "checkpoint_or_obligation_incomplete",
  "terminal_claim_unsupported",
] as const);

type BlockerCode = typeof LC4_PUBLIC_DEV_BLOCKER_ORDER[number];

type FactBinding = Readonly<{
  fact_key: string;
  version: 1 | 2;
  role: BindingRole;
  value: JsonValue;
  value_sha256: string;
}>;

type OpportunityEvent = Readonly<{
  kind:
    | "fact-introduction"
    | "correction"
    | "memory-probe"
    | "checkpoint"
    | "detour-suspend"
    | "detour-resume"
    | "worker-launch"
    | "worker-result"
    | "committed-after-error"
    | "authoritative-reconciliation"
    | "confirmation-invalidated"
    | "forbidden-action"
    | "privacy-guardrail"
    | "connection-rotation"
    | "interruption-repair";
  ref: string;
}>;

export type Lc4PublicDevOpportunity = Readonly<{
  id: string;
  index: number;
  act: Act;
  stage_id: string;
  goal_id: GoalId;
  canonical_caller_text: string;
  canonical_caller_text_sha256: string;
  fact_bindings: readonly FactBinding[];
  events: readonly OpportunityEvent[];
  expected_oracle: Readonly<{
    required_listener_semantics: readonly string[];
    permitted_effects: readonly string[];
    prohibited_effects: readonly string[];
    repair_stage_id: string | null;
  }>;
}>;

type Lc4PublicDevelopmentCorpusBody = ReturnType<typeof artifactBody>;
export type Lc4PublicDevelopmentCorpus = Readonly<Lc4PublicDevelopmentCorpusBody & { artifact_sha256: string }>;

type OpportunitySource = Readonly<{
  text: string;
  stage: "intake" | "eligibility" | "research-plan" | "booking" | "delivery" | "closeout";
  goal: GoalId;
  bindings?: readonly Readonly<[string, 1 | 2, BindingRole]>[];
  events?: readonly Readonly<[OpportunityEvent["kind"], string]>[];
  required?: readonly string[];
  permitted?: readonly string[];
  prohibited?: readonly string[];
  repair?: boolean;
}>;

const FACTS = Object.freeze({
  patron_record: Object.freeze({ 1: "MPL-1042", 2: "MPL-1402" }),
  patron_name: Object.freeze({ 1: "Rina Solis" }),
  collection_id: Object.freeze({ 1: "OH-RIVER-17" }),
  access_purpose: Object.freeze({ 1: "family-history research" }),
  visit_date: Object.freeze({ 1: "2026-08-18", 2: "2026-08-20" }),
  visit_time: Object.freeze({ 1: "14:30" }),
  home_branch: Object.freeze({ 1: "Juniper Branch" }),
  contact_channel: Object.freeze({ 1: "voice callback ending 0184" }),
  transcript_format: Object.freeze({ 1: "large-print paper", 2: "tagged screen-reader PDF" }),
  guest_name: Object.freeze({ 1: "Mina Park", 2: "Eli Park" }),
} as const);

const OPPORTUNITY_SOURCES: readonly OpportunitySource[] = Object.freeze([
  { text: "Hi, I need help arranging access to a municipal oral-history recording.", stage: "intake", goal: "goal.archive-room", bindings: [["patron_record", 1, "introduce"]], events: [["fact-introduction", "patron_record.v1"]], required: ["establish archive-access goal"] },
  { text: "My name is Rina Solis, and the library record I have written down is MPL-1042.", stage: "intake", goal: "goal.archive-room", bindings: [["patron_name", 1, "introduce"], ["patron_record", 1, "recall"]], events: [["fact-introduction", "patron_name.v1"]], required: ["acknowledge caller identity without treating it as verified"] },
  { text: "The recording is collection OH-RIVER-17.", stage: "intake", goal: "goal.archive-room", bindings: [["collection_id", 1, "introduce"]], events: [["fact-introduction", "collection_id.v1"]], required: ["bind the request to OH-RIVER-17"] },
  { text: "This is for family-history research, not publication or broadcast.", stage: "intake", goal: "goal.archive-room", bindings: [["access_purpose", 1, "introduce"]], events: [["fact-introduction", "access_purpose.v1"]], required: ["record the non-publication purpose"] },
  { text: "Before we go further, can you recap which recording and purpose you have?", stage: "intake", goal: "goal.archive-room", events: [["checkpoint", "checkpoint.intake-1"]], required: ["recall collection_id.v1", "recall access_purpose.v1"] },
  { text: "I was planning to visit on August eighteenth, twenty twenty-six.", stage: "intake", goal: "goal.archive-room", bindings: [["visit_date", 1, "introduce"]], events: [["fact-introduction", "visit_date.v1"]] },
  { text: "A two-thirty afternoon appointment would work best.", stage: "intake", goal: "goal.archive-room", bindings: [["visit_time", 1, "introduce"]], events: [["fact-introduction", "visit_time.v1"]] },
  { text: "Please start the archive rights review, but do not reserve anything yet.", stage: "intake", goal: "goal.archive-room", events: [["worker-launch", "worker.rights-review"]], permitted: ["launch rights-review worker"], prohibited: ["reserve archive room"] },
  { text: "My home library is Juniper Branch.", stage: "intake", goal: "goal.archive-room", bindings: [["home_branch", 1, "introduce"]], events: [["fact-introduction", "home_branch.v1"]] },
  { text: "For a callback, use the number already on file ending in zero one eight four.", stage: "intake", goal: "goal.archive-room", bindings: [["contact_channel", 1, "introduce"]], events: [["fact-introduction", "contact_channel.v1"], ["checkpoint", "checkpoint.intake-2"]], prohibited: ["speak or expose the full callback number"], repair: true },

  { text: "Can you confirm the record number you are using before checking eligibility?", stage: "eligibility", goal: "goal.archive-room", bindings: [["patron_record", 1, "recall"]], required: ["state patron_record.v1 as unverified"] },
  { text: "Correction: I transposed two digits. The correct record is MPL-1402, not MPL-1042.", stage: "eligibility", goal: "goal.archive-room", bindings: [["patron_record", 2, "correct"]], events: [["correction", "correction.patron-record"], ["confirmation-invalidated", "confirmation.patron-record-v1"]], required: ["replace patron_record.v1 with patron_record.v2"] },
  { text: "Do not use the old record for an eligibility decision or reservation.", stage: "eligibility", goal: "goal.archive-room", events: [["forbidden-action", "forbid.old-patron-record"]], prohibited: ["eligibility lookup for MPL-1042", "reservation for MPL-1042"] },
  { text: "Please check whether the corrected record is eligible for supervised archive access.", stage: "eligibility", goal: "goal.archive-room", events: [["worker-launch", "worker.eligibility"]], permitted: ["launch eligibility worker for MPL-1402"] },
  { text: "Which patron record is current, and what is still pending before you can reserve?", stage: "eligibility", goal: "goal.archive-room", bindings: [["patron_record", 2, "recall"]], events: [["memory-probe", "probe.patron-record-current"], ["checkpoint", "checkpoint.eligibility-1"]], required: ["recall patron_record.v2", "identify pending rights and eligibility evidence"] },
  { text: "Pause the room request for a moment; I also need an accessible transcript.", stage: "eligibility", goal: "goal.accessible-transcript", events: [["detour-suspend", "goal.archive-room"]], required: ["suspend archive-room goal without discarding it"] },
  { text: "Sorry to cut in—please acknowledge that the room request is paused, not cancelled.", stage: "eligibility", goal: "goal.accessible-transcript", events: [["interruption-repair", "interrupt.1"]], required: ["distinguish paused from cancelled"] },
  { text: "Start a transcript accessibility review while we continue talking.", stage: "eligibility", goal: "goal.accessible-transcript", events: [["worker-launch", "worker.accessibility"]], permitted: ["launch accessibility worker"] },
  { text: "What collection is this transcript for, and what did I say I plan to do with it?", stage: "eligibility", goal: "goal.accessible-transcript", bindings: [["collection_id", 1, "recall"], ["access_purpose", 1, "recall"]], events: [["memory-probe", "probe.collection-purpose"]], required: ["recall collection_id.v1", "recall access_purpose.v1"] },
  { text: "Please summarize both open goals and the checks still running.", stage: "eligibility", goal: "goal.accessible-transcript", events: [["checkpoint", "checkpoint.eligibility-2"]], required: ["retain both goals", "name all unresolved workers"], repair: true },

  { text: "If the voice connection refreshes now, continue from this exact state.", stage: "research-plan", goal: "goal.accessible-transcript", events: [["connection-rotation", "rotation.1"]], required: ["preserve arm-common state across connection rotation"] },
  { text: "Resume the archive-room goal alongside the transcript request.", stage: "research-plan", goal: "goal.archive-room", events: [["detour-resume", "goal.archive-room"]], required: ["resume archive-room goal"] },
  { text: "Remind me of my preferred visit time and home branch.", stage: "research-plan", goal: "goal.archive-room", bindings: [["visit_time", 1, "recall"], ["home_branch", 1, "recall"]], events: [["memory-probe", "probe.time-branch"]], required: ["recall visit_time.v1", "recall home_branch.v1"] },
  { text: "Do not read my full callback number aloud; only use the last four digits if needed.", stage: "research-plan", goal: "goal.archive-room", bindings: [["contact_channel", 1, "recall"]], events: [["privacy-guardrail", "privacy.callback"]], prohibited: ["speak full callback number"] },
  { text: "Do not reserve a room until both rights and corrected-record eligibility are authoritative.", stage: "research-plan", goal: "goal.archive-room", events: [["forbidden-action", "forbid.premature-room-reservation"], ["checkpoint", "checkpoint.research-plan-1"]], prohibited: ["reserve without rights and eligibility receipts"] },
  { text: "For the transcript, I initially want large-print paper; please also tell me what evidence is still missing for each goal.", stage: "research-plan", goal: "goal.accessible-transcript", bindings: [["transcript_format", 1, "introduce"]], events: [["fact-introduction", "transcript_format.v1"]], required: ["record transcript_format.v1", "separate room blockers from transcript blockers"] },
  { text: "Another correction: make the visit August twentieth, twenty twenty-six, not August eighteenth.", stage: "research-plan", goal: "goal.archive-room", bindings: [["visit_date", 2, "correct"]], events: [["correction", "correction.visit-date"]], required: ["replace visit_date.v1 with visit_date.v2"] },
  { text: "What date, time, and collection should the eventual room proposal use?", stage: "research-plan", goal: "goal.archive-room", bindings: [["visit_date", 2, "recall"], ["visit_time", 1, "recall"], ["collection_id", 1, "recall"]], events: [["memory-probe", "probe.room-plan"]], required: ["recall visit_date.v2", "recall visit_time.v1", "recall collection_id.v1"] },
  { text: "Recap the corrected record and date before checking room availability.", stage: "research-plan", goal: "goal.archive-room", bindings: [["patron_record", 2, "recall"], ["visit_date", 2, "recall"]], required: ["recall current corrected values"] },
  { text: "Start a room-availability check, and cancel any duplicate request if one appears.", stage: "research-plan", goal: "goal.archive-room", events: [["worker-launch", "worker.room-availability-race"], ["checkpoint", "checkpoint.research-plan-2"]], permitted: ["launch one room-availability worker"], prohibited: ["launch or accept a duplicate reservation"], repair: true },

  { text: "My guest is Mina Park; that name is only for room access if we get that far.", stage: "booking", goal: "goal.archive-room", bindings: [["guest_name", 1, "introduce"]], events: [["fact-introduction", "guest_name.v1"]], prohibited: ["use guest name outside room-access purpose"] },
  { text: "Suspend the transcript goal while we sort out the room.", stage: "booking", goal: "goal.archive-room", events: [["detour-suspend", "goal.accessible-transcript"]], required: ["suspend transcript goal without cancelling it"] },
  { text: "Before any booking, repeat the current date and patron record.", stage: "booking", goal: "goal.archive-room", bindings: [["visit_date", 2, "recall"], ["patron_record", 2, "recall"]], events: [["memory-probe", "probe.prebooking-current-state"]], required: ["recall corrected date and record"] },
  { text: "A delayed rights result may refer to the old record; reject it if it does.", stage: "booking", goal: "goal.archive-room", events: [["worker-result", "worker.rights-review.reject-stale"]], prohibited: ["apply stale rights result for MPL-1042"] },
  { text: "Submit the accessible-transcript request now. If the service times out, do not blindly retry it.", stage: "booking", goal: "goal.accessible-transcript", events: [["committed-after-error", "effect.transcript-request"], ["checkpoint", "checkpoint.booking-1"]], permitted: ["submit transcript request once"], prohibited: ["blindly retry ambiguous transcript mutation"] },
  { text: "Tell me whether that transcript request is confirmed, failed, or still ambiguous.", stage: "booking", goal: "goal.accessible-transcript", required: ["describe ambiguity without inventing outcome"] },
  { text: "What record, collection, and research purpose are governing this request now?", stage: "booking", goal: "goal.accessible-transcript", bindings: [["patron_record", 2, "recall"], ["collection_id", 1, "recall"], ["access_purpose", 1, "recall"]], events: [["memory-probe", "probe.request-governance"]], required: ["recall current governing facts"] },
  { text: "Correction: I need a tagged screen-reader PDF, not a large-print paper transcript.", stage: "booking", goal: "goal.accessible-transcript", bindings: [["transcript_format", 2, "correct"]], events: [["correction", "correction.transcript-format"], ["confirmation-invalidated", "confirmation.transcript-format-v1"]], required: ["replace transcript_format.v1 with transcript_format.v2"] },
  { text: "Resume the transcript goal with that corrected format.", stage: "booking", goal: "goal.accessible-transcript", events: [["detour-resume", "goal.accessible-transcript"]], required: ["resume transcript goal using version 2 format"] },
  { text: "Use the corrected record's eligibility result only once, then recap both goals.", stage: "booking", goal: "goal.archive-room", events: [["worker-result", "worker.eligibility.accept"], ["checkpoint", "checkpoint.booking-2"]], permitted: ["accept one current eligibility result"], prohibited: ["apply eligibility result twice"], repair: true },

  { text: "After this connection refresh, keep the corrected record, date, and transcript format.", stage: "delivery", goal: "goal.accessible-transcript", events: [["connection-rotation", "rotation.2"]], required: ["preserve three corrected facts across connection rotation"] },
  { text: "Authoritatively check whether the timed-out transcript request actually committed before doing anything else with it.", stage: "delivery", goal: "goal.accessible-transcript", events: [["authoritative-reconciliation", "effect.transcript-request"]], permitted: ["read back transcript request state"], prohibited: ["resubmit before reconciliation"] },
  { text: "The accessibility review has returned; apply it once if it matches the corrected format.", stage: "delivery", goal: "goal.accessible-transcript", bindings: [["transcript_format", 2, "recall"]], events: [["worker-result", "worker.accessibility.accept"], ["memory-probe", "probe.corrected-format"]], permitted: ["accept current accessibility result once"], prohibited: ["apply result for obsolete format"] },
  { text: "Do not claim the transcript is ready until delivery evidence exists.", stage: "delivery", goal: "goal.accessible-transcript", events: [["forbidden-action", "forbid.premature-transcript-ready"]], prohibited: ["claim transcript ready without delivery evidence"] },
  { text: "At this checkpoint, what is reconciled, what remains pending, and which format is current?", stage: "delivery", goal: "goal.accessible-transcript", events: [["checkpoint", "checkpoint.delivery-1"]], required: ["state reconciliation result", "state remaining blockers", "recall transcript_format.v2"] },
  { text: "Remind me which branch should own the callback and which last four digits you may say.", stage: "delivery", goal: "goal.archive-room", bindings: [["home_branch", 1, "recall"], ["contact_channel", 1, "recall"]], events: [["memory-probe", "probe.callback-routing"]], required: ["recall Juniper Branch", "speak only 0184"] },
  { text: "Final correction: my guest is Eli Park, not Mina Park.", stage: "delivery", goal: "goal.archive-room", bindings: [["guest_name", 2, "correct"]], events: [["correction", "correction.guest-name"]], required: ["replace guest_name.v1 with guest_name.v2"] },
  { text: "Before proposing a room, recap the corrected guest, date, record, and the rights status.", stage: "delivery", goal: "goal.archive-room", bindings: [["guest_name", 2, "recall"], ["visit_date", 2, "recall"], ["patron_record", 2, "recall"]], required: ["recall all current room-governing facts", "state rights status"] },
  { text: "I need to interrupt—do not lose the corrected guest name while answering my next question.", stage: "delivery", goal: "goal.archive-room", events: [["interruption-repair", "interrupt.2"]], required: ["retain guest_name.v2 through interruption"] },
  { text: "What exact visit date and transcript format are current now?", stage: "delivery", goal: "goal.accessible-transcript", bindings: [["visit_date", 2, "recall"], ["transcript_format", 2, "recall"]], events: [["memory-probe", "probe.corrected-date-format"], ["checkpoint", "checkpoint.delivery-2"]], required: ["recall visit_date.v2", "recall transcript_format.v2"], repair: true },

  { text: "If a second room-availability result arrives, treat it as a duplicate or cancelled result, not a new booking.", stage: "closeout", goal: "goal.archive-room", events: [["worker-result", "worker.room-availability-race.reject-duplicate"]], prohibited: ["accept duplicate room result"] },
  { text: "Keep my guest's name scoped to this access request and do not repeat it unnecessarily.", stage: "closeout", goal: "goal.archive-room", bindings: [["guest_name", 2, "recall"]], events: [["privacy-guardrail", "privacy.guest-name"]], prohibited: ["repeat guest name without task need"] },
  { text: "Recap which asynchronous results were accepted and which were rejected.", stage: "closeout", goal: "goal.archive-room", events: [["memory-probe", "probe.worker-dispositions"]], required: ["identify accepted eligibility and accessibility results", "identify stale rights and duplicate room results"] },
  { text: "Confirm the transcript mutation was reconciled exactly once, then state its authoritative status.", stage: "closeout", goal: "goal.accessible-transcript", required: ["state one reconciliation and authoritative transcript status"], prohibited: ["perform second reconciliation mutation"] },
  { text: "Checkpoint: list every remaining obligation before either goal can be called complete.", stage: "closeout", goal: "goal.accessible-transcript", events: [["checkpoint", "checkpoint.closeout-1"]], required: ["list unresolved obligations for both goals"] },
  { text: "Do not book or send anything if a required receipt is still missing; explain the blocker instead.", stage: "closeout", goal: "goal.archive-room", events: [["forbidden-action", "forbid.effect-with-missing-receipt"]], prohibited: ["execute effect with missing receipt"] },
  { text: "One more memory check: what are the current record, guest, date, and transcript format?", stage: "closeout", goal: "goal.archive-room", bindings: [["patron_record", 2, "recall"], ["guest_name", 2, "recall"], ["visit_date", 2, "recall"], ["transcript_format", 2, "recall"]], events: [["memory-probe", "probe.all-corrections"]], required: ["recall all four corrected facts"] },
  { text: "Use only authoritative evidence to describe the final room and transcript states.", stage: "closeout", goal: "goal.accessible-transcript", required: ["avoid unsupported terminal claims"] },
  { text: "Before closing, repeat the collection, research purpose, and callback ending you retained.", stage: "closeout", goal: "goal.accessible-transcript", bindings: [["collection_id", 1, "recall"], ["access_purpose", 1, "recall"], ["contact_channel", 1, "recall"]], events: [["memory-probe", "probe.early-facts"]], required: ["recall three early facts without privacy leak"] },
  { text: "Give me the final status of both goals, including any blocker, without claiming an effect that lacks a receipt.", stage: "closeout", goal: "goal.accessible-transcript", events: [["checkpoint", "checkpoint.closeout-2"]], required: ["give receipt-grounded status for both goals"], prohibited: ["unsupported completion claim"], repair: true },
]);

const STAGE_BY_INDEX = Object.freeze([
  [1, 10, "stage.intake"],
  [11, 20, "stage.eligibility"],
  [21, 30, "stage.research-plan"],
  [31, 40, "stage.booking"],
  [41, 50, "stage.delivery"],
  [51, 60, "stage.closeout"],
] as const);

function stageId(index: number): string {
  const row = STAGE_BY_INDEX.find(([start, end]) => index >= start && index <= end);
  if (!row) throw new Error(`opportunity ${index} is outside the 60-opportunity horizon`);
  return row[2];
}

function factValue(key: string, version: 1 | 2): JsonValue {
  const versions = FACTS[key as keyof typeof FACTS] as Partial<Record<1 | 2, JsonValue>> | undefined;
  const value = versions?.[version];
  if (value === undefined) throw new Error(`unknown fact version ${key}.v${version}`);
  return value;
}

function opportunity(source: OpportunitySource, offset: number): Lc4PublicDevOpportunity {
  const index = offset + 1;
  const expectedStage = stageId(index);
  if (`stage.${source.stage}` !== expectedStage) throw new Error(`stage drift at opportunity ${index}`);
  const textHash = sha256Hex(`hacc/lc4-dev/caller-text/v1\n${source.text}`);
  return Object.freeze({
    id: `lc4-dev-op-${String(index).padStart(2, "0")}`,
    index,
    act: index <= 20 ? "establish" : index <= 40 ? "interleave" : "reconcile",
    stage_id: expectedStage,
    goal_id: source.goal,
    canonical_caller_text: source.text,
    canonical_caller_text_sha256: textHash,
    fact_bindings: Object.freeze((source.bindings ?? []).map(([fact_key, version, role]) => {
      const value = factValue(fact_key, version);
      return Object.freeze({
        fact_key,
        version,
        role,
        value,
        value_sha256: sha256Hex(`hacc/lc4-dev/fact-value/v1\n${canonicalJson(value)}`),
      });
    })),
    events: Object.freeze((source.events ?? []).map(([kind, ref]) => Object.freeze({ kind, ref }))),
    expected_oracle: Object.freeze({
      required_listener_semantics: Object.freeze([...(source.required ?? [])]),
      permitted_effects: Object.freeze([...(source.permitted ?? [])]),
      prohibited_effects: Object.freeze([...(source.prohibited ?? [])]),
      repair_stage_id: source.repair ? expectedStage : null,
    }),
  });
}

const REPAIR_SOURCES = Object.freeze([
  ["stage.intake", "subject_or_goal_unresolved", 1, "I still need access to oral-history collection OH-RIVER-17 for family-history research."],
  ["stage.intake", "subject_or_goal_unresolved", 2, "The goal is still supervised access to OH-RIVER-17 for family-history research."],
  ["stage.intake", "checkpoint_or_obligation_incomplete", 1, "Please recap the collection and purpose before we continue."],
  ["stage.intake", "checkpoint_or_obligation_incomplete", 2, "Before moving on, say which collection and research purpose you are carrying forward."],
  ["stage.eligibility", "latest_revision_unacknowledged", 1, "The current patron record is MPL-1402; MPL-1042 is obsolete."],
  ["stage.eligibility", "latest_revision_unacknowledged", 2, "Use MPL-1402 as the corrected record and do not rely on MPL-1042."],
  ["stage.eligibility", "required_worker_unresolved", 1, "Please say which eligibility or rights checks are still pending."],
  ["stage.eligibility", "required_worker_unresolved", 2, "I still need the unresolved eligibility and rights checks identified explicitly."],
  ["stage.research-plan", "latest_revision_unacknowledged", 1, "The visit date is August twentieth, not August eighteenth."],
  ["stage.research-plan", "latest_revision_unacknowledged", 2, "Please carry forward August twentieth as the current visit date."],
  ["stage.research-plan", "required_evidence_missing", 1, "Please do not reserve until both rights and eligibility evidence are authoritative."],
  ["stage.research-plan", "required_evidence_missing", 2, "The room must remain unreserved while either rights or eligibility evidence is missing."],
  ["stage.booking", "ambiguity_unreconciled", 1, "Please check whether the transcript request committed before trying it again."],
  ["stage.booking", "ambiguity_unreconciled", 2, "Resolve the transcript request's authoritative status without submitting it again."],
  ["stage.booking", "latest_revision_unacknowledged", 1, "The current transcript format is a tagged screen-reader PDF."],
  ["stage.booking", "latest_revision_unacknowledged", 2, "Please use the corrected tagged screen-reader PDF format, not large-print paper."],
  ["stage.delivery", "latest_revision_unacknowledged", 1, "The current guest is Eli Park, not Mina Park."],
  ["stage.delivery", "latest_revision_unacknowledged", 2, "Carry forward Eli Park as the corrected guest and discard Mina Park."],
  ["stage.delivery", "confirmation_invalid_or_missing", 1, "Please confirm the exact current proposal before any booking."],
  ["stage.delivery", "confirmation_invalid_or_missing", 2, "Do not book until the caller has confirmed the complete current proposal."],
  ["stage.closeout", "checkpoint_or_obligation_incomplete", 1, "Please list every unresolved obligation for both goals."],
  ["stage.closeout", "checkpoint_or_obligation_incomplete", 2, "Before closeout, enumerate every obligation that is still open for either goal."],
  ["stage.closeout", "terminal_claim_unsupported", 1, "Only call a goal complete if an authoritative receipt supports it."],
  ["stage.closeout", "terminal_claim_unsupported", 2, "Keep the goal incomplete unless its completion is backed by an authoritative receipt."],
] as const satisfies readonly Readonly<[string, BlockerCode, 1 | 2, string]>[]);

function artifactBody() {
  const opportunities = Object.freeze(OPPORTUNITY_SOURCES.map(opportunity));
  const repairs = Object.freeze(REPAIR_SOURCES.map(([stage_id, blocker_code, repair_ordinal, text], index) => Object.freeze({
    id: `lc4-dev-repair-${String(index + 1).padStart(2, "0")}`,
    stage_id,
    blocker_code,
    repair_ordinal,
    canonical_caller_text: text,
    canonical_caller_text_sha256: sha256Hex(`hacc/lc4-dev/repair-text/v1\n${text}`),
    pcm_status: "not-rendered" as const,
  })));
  const sourceTextHashes = [...opportunities.map((item) => item.canonical_caller_text_sha256), ...repairs.map((item) => item.canonical_caller_text_sha256)];
  const sourceCorpusSha256 = sha256Hex(`hacc/lc4-dev/source-corpus/v1\n${sourceTextHashes.join("\n")}`);
  const sixEpisodeSchedule = Object.freeze(LC4_PUBLIC_DEV_PROVIDERS.flatMap((provider, providerIndex) => {
    const order = providerIndex % 2 === 0 ? LC4_PUBLIC_DEV_ARMS : [...LC4_PUBLIC_DEV_ARMS].reverse() as Arm[];
    return order.map((arm, armIndex) => Object.freeze({
      pair_id: `lc4-dev-${provider}`,
      episode_id: `lc4-dev-${provider}-${arm}`,
      provider,
      arm,
      pair_position: armIndex + 1,
      template_id: LC4_PUBLIC_DEV_TEMPLATE_ID,
      source_corpus_sha256: sourceCorpusSha256,
      caller_voice_slot: "lc4-dev-voice-1" as const,
    }));
  }));

  return {
    schema_version: 1 as const,
    protocol_id: LC4_PUBLIC_DEV_PROTOCOL_ID,
    template_id: LC4_PUBLIC_DEV_TEMPLATE_ID,
    created_at: LC4_PUBLIC_DEV_CREATED_AT,
    study_role: "mechanism-evidence-only" as const,
    efficacy_claim_eligible: false as const,
    confirmatory_reuse_permitted: false as const,
    provider_calls_authorized_by_artifact: false as const,
    domain: Object.freeze({
      family_slug: "municipal-oral-history-access" as const,
      description: "municipal library oral-history listening-room access and accessible transcript fulfillment",
      excluded_confirmatory_family_slugs: LC4_CONFIRMATORY_FAMILY_SLUGS,
    }),
    provenance: Object.freeze({
      content_origin: "Original synthetic scenario authored for Harsha's Amazing Call Center; no customer, provider-output, or prior benchmark transcript data.",
      person_and_identifier_status: "All people, identifiers, dates, branches, collections, and callback fragments are fictional.",
      license: LC4_PUBLIC_DEV_CORPUS_LICENSE,
      license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution_required: false,
      generated_from_confirmatory_plaintext: false,
      provider_output_used: false,
    }),
    shape: Object.freeze({
      canonical_opportunities: 60,
      acts: 3,
      opportunities_per_act: 20,
      goals: 2,
      future_relevant_facts: 10,
      corrections: 4,
      memory_probes: 12,
      checkpoints: 12,
      worker_launches: 4,
      provider_connection_rotations: 2,
      interruption_repairs: 2,
      committed_after_error_mutations: 1,
      authoritative_reconciliations: 1,
    }),
    facts: FACTS,
    opportunities,
    repair_policy: Object.freeze({
      policy_id: "CRP-1-development-profile" as const,
      maximum_repairs_per_stage: 2 as const,
      maximum_repairs_per_episode: 4 as const,
      repairs_do_not_extend_horizon: true as const,
      blocker_precedence: LC4_PUBLIC_DEV_BLOCKER_ORDER,
      selection: "At a registered deadline, choose the earliest unmet blocker and the next unused repair ordinal for that stage; otherwise emit no_repair." as const,
      library: repairs,
    }),
    expected_final_oracle: Object.freeze({
      current_fact_versions: Object.freeze({ patron_record: 2, visit_date: 2, transcript_format: 2, guest_name: 2 }),
      stale_fact_versions_must_not_govern: Object.freeze(["patron_record.v1", "visit_date.v1", "transcript_format.v1", "guest_name.v1"]),
      worker_dispositions: Object.freeze({
        "worker.rights-review": "reject-stale",
        "worker.eligibility": "accept-once",
        "worker.accessibility": "accept-once",
        "worker.room-availability-race": "reject-duplicate-or-cancelled",
      }),
      effect_invariants: Object.freeze([
        "effect.transcript-request has exactly one mutation attempt",
        "effect.transcript-request has exactly one authoritative reconciliation",
        "no archive-room reservation executes without current rights, eligibility, and confirmation receipts",
        "no terminal completion claim is heard without an authoritative receipt",
      ]),
    }),
    audio_plan: Object.freeze({
      source_format: "pcm_s16le_mono_24000hz" as const,
      canonical_source_utterances: sourceTextHashes.length,
      source_text_corpus_sha256: sourceCorpusSha256,
      rendering_status: "not-rendered" as const,
      rendering_requirements: Object.freeze([
        "render every canonical opportunity and repair from its exact committed source text",
        "bind source PCM SHA-256 and provider rendition SHA-256 before the first provider episode",
        "use the same source PCM and deterministic provider rendition in both arms of each provider pair",
        "reject any ASR mismatch or post-outcome re-render",
      ]),
    }),
    six_episode_canary_schedule: sixEpisodeSchedule,
  };
}

export function createLc4PublicDevelopmentCorpus(): Lc4PublicDevelopmentCorpus {
  const body = artifactBody();
  const artifact_sha256 = sha256Hex(`harshas-amazing-call-center/lc4-public-development-corpus/v1\n${canonicalJson(body)}`);
  const artifact = immutableJson({ ...body, artifact_sha256 }) as unknown as Lc4PublicDevelopmentCorpus;
  assertLc4PublicDevelopmentCorpus(artifact);
  return artifact;
}

export function assertLc4PublicDevelopmentCorpus(value: unknown): asserts value is Lc4PublicDevelopmentCorpus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("LC4 public development corpus must be an object");
  const artifact = value as ReturnType<typeof artifactBody> & { artifact_sha256?: unknown };
  if (artifact.protocol_id !== LC4_PUBLIC_DEV_PROTOCOL_ID) throw new Error("LC4 public development protocol drifted");
  if (artifact.study_role !== "mechanism-evidence-only" || artifact.efficacy_claim_eligible !== false || artifact.confirmatory_reuse_permitted !== false) {
    throw new Error("LC4 public development evidence boundary drifted");
  }
  if (artifact.provider_calls_authorized_by_artifact !== false) throw new Error("development artifact must not authorize provider calls");
  if (artifact.domain.family_slug !== "municipal-oral-history-access") throw new Error("development domain drifted");
  if ((LC4_CONFIRMATORY_FAMILY_SLUGS as readonly string[]).includes(artifact.domain.family_slug)) throw new Error("development family overlaps confirmatory families");
  if (artifact.provenance.license !== LC4_PUBLIC_DEV_CORPUS_LICENSE || artifact.provenance.generated_from_confirmatory_plaintext !== false || artifact.provenance.provider_output_used !== false) {
    throw new Error("development corpus provenance drifted");
  }
  if (artifact.opportunities.length !== 60) throw new Error("development corpus must contain exactly 60 opportunities");
  artifact.opportunities.forEach((item, offset) => {
    const index = offset + 1;
    if (item.index !== index || item.id !== `lc4-dev-op-${String(index).padStart(2, "0")}`) throw new Error("opportunity order or identity drifted");
    if (item.stage_id !== stageId(index)) throw new Error("opportunity stage binding drifted");
    if (item.act !== (index <= 20 ? "establish" : index <= 40 ? "interleave" : "reconcile")) throw new Error("opportunity act drifted");
    if (item.canonical_caller_text_sha256 !== sha256Hex(`hacc/lc4-dev/caller-text/v1\n${item.canonical_caller_text}`)) throw new Error("caller text commitment mismatch");
    for (const binding of item.fact_bindings) {
      const expected = factValue(binding.fact_key, binding.version);
      if (canonicalJson(binding.value) !== canonicalJson(expected)) throw new Error("fact binding value drifted");
      if (binding.value_sha256 !== sha256Hex(`hacc/lc4-dev/fact-value/v1\n${canonicalJson(expected)}`)) throw new Error("fact binding commitment mismatch");
    }
  });
  const count = (kind: OpportunityEvent["kind"]) => artifact.opportunities.flatMap((item) => item.events).filter((event) => event.kind === kind).length;
  const expectedCounts: Readonly<Record<OpportunityEvent["kind"], number>> = Object.freeze({
    "fact-introduction": 10, correction: 4, "memory-probe": 12, checkpoint: 12,
    "detour-suspend": 2, "detour-resume": 2, "worker-launch": 4, "worker-result": 4,
    "committed-after-error": 1, "authoritative-reconciliation": 1, "confirmation-invalidated": 2,
    "forbidden-action": 4, "privacy-guardrail": 2, "connection-rotation": 2, "interruption-repair": 2,
  });
  for (const [kind, expected] of Object.entries(expectedCounts)) {
    if (count(kind as OpportunityEvent["kind"]) !== expected) throw new Error(`${kind} count drifted`);
  }
  if (artifact.repair_policy.library.length !== 24) throw new Error("repair library must contain two ordinals for both blockers in every stage");
  for (const stage of STAGE_BY_INDEX.map((row) => row[2])) {
    const repairs = artifact.repair_policy.library.filter((item) => item.stage_id === stage);
    const blockers = [...new Set(repairs.map((item) => item.blocker_code))];
    if (repairs.length !== 4 || blockers.length !== 2
      || blockers.some((blocker) => repairs.filter((item) => item.blocker_code === blocker).map((item) => item.repair_ordinal).join(",") !== "1,2")) {
      throw new Error(`repair coverage drifted for ${stage}`);
    }
  }
  const pairs = artifact.six_episode_canary_schedule;
  if (pairs.length !== 6) throw new Error("development canary must contain exactly six episodes");
  for (const provider of LC4_PUBLIC_DEV_PROVIDERS) {
    const providerRows = pairs.filter((row) => row.provider === provider);
    if (providerRows.length !== 2 || new Set(providerRows.map((row) => row.arm)).size !== 2) throw new Error(`paired-arm coverage drifted for ${provider}`);
    if (new Set(providerRows.map((row) => row.source_corpus_sha256)).size !== 1) throw new Error(`paired source corpus drifted for ${provider}`);
  }
  if (typeof artifact.artifact_sha256 !== "string") throw new Error("development corpus is missing its artifact commitment");
  const { artifact_sha256: claimed, ...body } = artifact;
  const expected = sha256Hex(`harshas-amazing-call-center/lc4-public-development-corpus/v1\n${canonicalJson(body)}`);
  if (claimed !== expected) throw new Error("development corpus artifact commitment mismatch");
}
