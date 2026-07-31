import {
  ContextProjectionOverflowError,
  appendConversationEvents,
  createConversationLog,
  foldConversation,
  projectConversationContext,
  type ConversationEventDraft,
  type ConversationLog,
} from "../lib/conversation-kernel";

const SCRIPT_VERSION = "hacc-context-retention-v1";
const DEFAULT_SEED = 0x48414343;
const DEFAULT_SCHEDULES = 1_000;
const BUDGETS = [1_024, 2_048, 4_096, 8_192] as const;
const FACT_KEYS = [
  "delivery_constraint",
  "billing_currency",
  "preferred_channel",
  "budget_limit",
  "account_tier",
  "service_region",
  "accessibility_need",
  "callback_window",
] as const;

type Unit = Readonly<{ kind: "policy" | "goal" | "fact" | "commitment"; id: string; marker: string }>;

function parsePositiveInteger(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function integer(random: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? sorted.at(-1)!;
}

function recentWholeTurnWindow(turns: readonly string[], byteBudget: number): string {
  const selected: string[] = [];
  let bytes = 2;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const encoded = JSON.stringify(turns[index]);
    const added = Buffer.byteLength(encoded, "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + added > byteBudget) break;
    selected.push(turns[index]!);
    bytes += added;
  }
  return JSON.stringify(selected.reverse());
}

function pushDraft(
  drafts: ConversationEventDraft[],
  eventId: string,
  payload: ConversationEventDraft["payload"],
): void {
  drafts.push({ eventId, occurredAtMs: drafts.length + 1, payload });
}

function buildSchedule(schedule: number, random: () => number): Readonly<{
  log: ConversationLog;
  turns: readonly string[];
  units: readonly Unit[];
}> {
  const turnCount = integer(random, 500, 2_000);
  const turns = Array.from({ length: turnCount }, (_, turn) =>
    `Caller and agent discuss ordinary detail ${schedule}-${turn}; this turn carries no durable authority.`);
  const atTurn = new Map<number, Array<() => void>>();
  const drafts: ConversationEventDraft[] = [];
  const units: Unit[] = [];
  const scheduleAt = (turn: number, operation: () => void) => {
    atTurn.set(turn, [...(atTurn.get(turn) ?? []), operation]);
  };
  const addMarker = (turn: number, marker: string) => {
    turns[turn] = `${turns[turn]} ${marker}`;
  };

  const policyMarker = "[[policy:protect_verified_identity:v1]]";
  units.push({ kind: "policy", id: "protect_verified_identity", marker: policyMarker });
  scheduleAt(0, () => {
    pushDraft(drafts, "policy-1", {
      type: "policy.advanced",
      epoch: 1,
      invariants: [{ invariantId: "protect_verified_identity", text: "Never expose account data before verification." }],
    });
    addMarker(0, policyMarker);
  });

  const goalMarker = "[[goal:resolve_multi_stage_request]]";
  units.push({ kind: "goal", id: "resolve_multi_stage_request", marker: goalMarker });
  scheduleAt(1, () => {
    pushDraft(drafts, "goal-1", {
      type: "goal.activated", goalId: "resolve_multi_stage_request",
      description: "Resolve the caller's multi-stage request without losing constraints.",
    });
    addMarker(1, goalMarker);
  });

  for (let index = 0; index < 3; index += 1) {
    const id = `commitment_${index + 1}`;
    const marker = `[[commitment:${id}]]`;
    const turn = integer(random, 2, Math.max(2, turnCount - 80));
    units.push({ kind: "commitment", id, marker });
    scheduleAt(turn, () => {
      pushDraft(drafts, `commitment-${index + 1}`, {
        type: "commitment.opened", commitmentId: id, goalId: "resolve_multi_stage_request",
        description: `Complete durable follow-up ${index + 1}.`,
      });
      addMarker(turn, marker);
    });
  }

  for (const [index, key] of FACT_KEYS.entries()) {
    const corrected = index % 2 === 0;
    const value = corrected ? `latest_${schedule}_${index}` : `stable_${schedule}_${index}`;
    const marker = `[[fact:${key}:${corrected ? 2 : 1}:${value}]]`;
    const latestTurn = integer(random, 4, Math.max(4, turnCount - 10));
    units.push({ kind: "fact", id: key, marker });
    if (corrected) {
      const initialValue = `superseded_${schedule}_${index}`;
      scheduleAt(2, () => {
        pushDraft(drafts, `fact-${index}-v1`, {
          type: "fact.asserted", key, value: initialValue, revision: 1,
          authority: { kind: "human_verified", issuer: "caller", evidenceId: `fact-${index}-v1`, issuedAtMs: 1 },
        });
        addMarker(2, `[[fact:${key}:1:${initialValue}]]`);
      });
      scheduleAt(latestTurn, () => {
        pushDraft(drafts, `fact-${index}-v2`, {
          type: "fact.corrected", key, value, expectedRevision: 1, revision: 2,
          authority: { kind: "human_verified", issuer: "caller", evidenceId: `fact-${index}-v2`, issuedAtMs: latestTurn },
        });
        addMarker(latestTurn, marker);
      });
    } else {
      scheduleAt(latestTurn, () => {
        pushDraft(drafts, `fact-${index}-v1`, {
          type: "fact.asserted", key, value, revision: 1,
          authority: { kind: "system_of_record", issuer: "crm", evidenceId: `fact-${index}-v1`, issuedAtMs: latestTurn },
        });
        addMarker(latestTurn, marker);
      });
    }
  }

  for (let turn = 0; turn < turnCount; turn += 1) {
    for (const operation of atTurn.get(turn) ?? []) operation();
    pushDraft(drafts, `turn-${turn}`, {
      type: "advisory.recorded", episodeId: `turn-${turn}`, summary: turns[turn]!,
    });
  }
  const log = appendConversationEvents(createConversationLog(`benchmark-${schedule}`), drafts);
  return { log, turns, units };
}

function kernelRecall(log: ConversationLog, units: readonly Unit[], byteBudget: number): Readonly<{
  recalled: number;
  contextBytes: number | null;
  overflow: boolean;
}> {
  try {
    const projection = projectConversationContext(foldConversation(log), byteBudget);
    const recalled = units.filter((unit) => {
      if (unit.kind === "policy") return projection.value.invariants.some(({ invariantId }) => invariantId === unit.id);
      if (unit.kind === "goal") return projection.value.currentGoal?.goalId === unit.id;
      if (unit.kind === "commitment") {
        return projection.value.openCommitments.some(({ commitmentId }) => commitmentId === unit.id);
      }
      return projection.value.authoritativeFacts.some(({ key }) => key === unit.id);
    }).length;
    return { recalled, contextBytes: projection.byteLength, overflow: false };
  } catch (error) {
    if (error instanceof ContextProjectionOverflowError) return { recalled: 0, contextBytes: null, overflow: true };
    throw error;
  }
}

const schedules = parsePositiveInteger("--schedules", DEFAULT_SCHEDULES);
const seed = parsePositiveInteger("--seed", DEFAULT_SEED);
const random = xorshift32(seed);
const aggregates = new Map(BUDGETS.map((budget) => [budget, {
  opportunities: 0,
  kernelRecalled: 0,
  recentRecalled: 0,
  fullHistoryRecalled: 0,
  overflows: 0,
  contextBytes: [] as number[],
  fullHistoryBytes: [] as number[],
}]));

for (let schedule = 0; schedule < schedules; schedule += 1) {
  const fixture = buildSchedule(schedule, random);
  const fullHistory = JSON.stringify(fixture.turns);
  const fullHistoryBytes = Buffer.byteLength(fullHistory, "utf8");
  for (const budget of BUDGETS) {
    const aggregate = aggregates.get(budget)!;
    const recent = recentWholeTurnWindow(fixture.turns, budget);
    const kernel = kernelRecall(fixture.log, fixture.units, budget);
    aggregate.opportunities += fixture.units.length;
    aggregate.kernelRecalled += kernel.recalled;
    aggregate.recentRecalled += fixture.units.filter(({ marker }) => recent.includes(marker)).length;
    aggregate.fullHistoryRecalled += fixture.units.filter(({ marker }) => fullHistory.includes(marker)).length;
    aggregate.overflows += Number(kernel.overflow);
    if (kernel.contextBytes !== null) aggregate.contextBytes.push(kernel.contextBytes);
    aggregate.fullHistoryBytes.push(fullHistoryBytes);
  }
}

const result = {
  schema_version: 1,
  benchmark: SCRIPT_VERSION,
  interpretation: "Deterministic context-substrate retention only; this is not an STS model or provider superiority result.",
  comparator: "Most-recent whole transcript turns under the identical UTF-8 byte budget.",
  seed,
  schedules,
  conversation_turns: { minimum: 500, maximum: 2_000 },
  durable_units_per_schedule: 13,
  budgets: Object.fromEntries([...aggregates.entries()].map(([budget, aggregate]) => [String(budget), {
    opportunities: aggregate.opportunities,
    kernel: {
      recalled: aggregate.kernelRecalled,
      recall_rate: aggregate.kernelRecalled / aggregate.opportunities,
      overflow_schedules: aggregate.overflows,
      mean_packet_bytes: aggregate.contextBytes.length === 0
        ? null
        : aggregate.contextBytes.reduce((sum, value) => sum + value, 0) / aggregate.contextBytes.length,
      p95_packet_bytes: percentile(aggregate.contextBytes, 0.95),
    },
    recent_transcript_window: {
      recalled: aggregate.recentRecalled,
      recall_rate: aggregate.recentRecalled / aggregate.opportunities,
    },
    unbounded_full_history: {
      recalled: aggregate.fullHistoryRecalled,
      recall_rate: aggregate.fullHistoryRecalled / aggregate.opportunities,
      mean_bytes: aggregate.fullHistoryBytes.reduce((sum, value) => sum + value, 0) / aggregate.fullHistoryBytes.length,
      p95_bytes: percentile(aggregate.fullHistoryBytes, 0.95),
    },
  }])),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
