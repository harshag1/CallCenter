import { z } from "zod";
import {
  ContextProjectionOverflowError,
  canonicalJson,
  projectConversationContext,
  type ConversationState,
  type ContextProjection,
} from "./conversation-kernel";

const MIN_PACKET_BYTES = 1_024;
const MAX_PACKET_BYTES = 262_144;
const MAX_RECENT_TURNS = 128;
const MAX_TURN_TEXT = 8_192;

const AudibleTurnSchema = z.object({
  turnId: z.string().min(1).max(128),
  speaker: z.enum(["caller", "agent"]),
  text: z.string().min(1).max(MAX_TURN_TEXT),
  deliveryEvidence: z.enum([
    "caller_input_transcript",
    "provider_transcript_unverified_playback",
    "playback_acknowledged",
  ]).optional(),
  heardAtMs: z.number().int().nonnegative().safe(),
}).strict();

const CapabilitySchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1_024),
}).strict();

export type AudibleTurn = z.infer<typeof AudibleTurnSchema>;
export type RealtimePacketCapability = z.infer<typeof CapabilitySchema>;
export type ProjectedAudibleTurn = AudibleTurn & Readonly<{
  textTrust: "untrusted_advisory";
}>;

export type RealtimeContextPacket = Readonly<{
  schemaVersion: 1;
  trustBoundary: Readonly<{
    envelope: "host_authored";
    authorityAndDurableControlState: "host_authoritative";
    workerInputAndResultContent: "untrusted_advisory";
    modelAdvisories: "untrusted_advisory";
    recentAudibleTurnText: "untrusted_advisory";
  }>;
  authority: Readonly<{
    conversationHeadSha256: string;
    conversationRevision: number;
    policyEpoch: number;
    capabilityEpoch: number;
    capabilityCatalogDigest: string;
  }>;
  durable: ContextProjection;
  capabilities: readonly RealtimePacketCapability[];
  recentAudibleTurns: readonly ProjectedAudibleTurn[];
  omittedRecentTurnCount: number;
}>;

export type CompiledRealtimeContextPacket = Readonly<{
  value: RealtimeContextPacket;
  serialized: string;
  byteLength: number;
}>;

function bytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function assertUnique<T>(items: readonly T[], identity: (item: T) => string, label: string): void {
  const ids = items.map(identity);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must have unique identities`);
}

/**
 * Compiles the provider-neutral packet for a realtime session or turn.
 * Durable control state and the host-derived capability catalog are atomic.
 * Recent conversation transcript is optional and admitted newest-first only
 * from the bytes left over; it can never evict policy, facts, obligations,
 * Flow, or worker state. `heardAtMs` is the journal event time retained for
 * schema compatibility, not proof that an agent utterance survived barge-in;
 * callers must inspect `deliveryEvidence`.
 */
export function compileRealtimeContextPacket(input: Readonly<{
  state: ConversationState;
  capabilityCatalogDigest: string;
  capabilityEpoch: number;
  capabilities: readonly RealtimePacketCapability[];
  recentAudibleTurns: readonly AudibleTurn[];
  byteBudget: number;
}>): CompiledRealtimeContextPacket {
  if (!Number.isSafeInteger(input.byteBudget) || input.byteBudget < MIN_PACKET_BYTES ||
      input.byteBudget > MAX_PACKET_BYTES) {
    throw new Error(`realtime packet budget must be ${MIN_PACKET_BYTES} to ${MAX_PACKET_BYTES} bytes`);
  }
  if (!/^[a-f0-9]{64}$/.test(input.capabilityCatalogDigest)) {
    throw new Error("capability catalog digest must be SHA-256");
  }
  if (!Number.isSafeInteger(input.capabilityEpoch) || input.capabilityEpoch < 0) {
    throw new Error("capability epoch must be a non-negative safe integer");
  }
  const capabilities = input.capabilities.map((item) => CapabilitySchema.parse(item));
  assertUnique(capabilities, ({ name }) => name, "packet capabilities");
  if (capabilities.length > 128) throw new Error("realtime packet cannot expose more than 128 capabilities");
  const recent = input.recentAudibleTurns.map((turn) => AudibleTurnSchema.parse(turn));
  if (recent.length > MAX_RECENT_TURNS) throw new Error(`recent audible turns cannot exceed ${MAX_RECENT_TURNS}`);
  assertUnique(recent, ({ turnId }) => turnId, "recent audible turns");
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index].heardAtMs < recent[index - 1].heardAtMs) {
      throw new Error("recent audible turns must be ordered oldest to newest");
    }
  }

  // First establish the smallest valid durable envelope, then give the durable
  // projector every remaining byte. Its own priority rules are authoritative.
  let minimumDurable;
  try {
    minimumDurable = projectConversationContext(input.state, 256);
  } catch (error) {
    if (!(error instanceof ContextProjectionOverflowError)) throw error;
    if (error.requiredControlBytes > 65_536) throw error;
    minimumDurable = projectConversationContext(input.state, error.requiredControlBytes);
  }
  const base = {
    schemaVersion: 1 as const,
    trustBoundary: {
      envelope: "host_authored" as const,
      authorityAndDurableControlState: "host_authoritative" as const,
      workerInputAndResultContent: "untrusted_advisory" as const,
      modelAdvisories: "untrusted_advisory" as const,
      recentAudibleTurnText: "untrusted_advisory" as const,
    },
    authority: {
      conversationHeadSha256: input.state.headHash,
      conversationRevision: input.state.eventCount,
      policyEpoch: input.state.policy.epoch,
      capabilityEpoch: input.capabilityEpoch,
      capabilityCatalogDigest: input.capabilityCatalogDigest,
    },
    durable: minimumDurable.value,
    capabilities,
    recentAudibleTurns: [] as ProjectedAudibleTurn[],
    omittedRecentTurnCount: recent.length,
  };
  const baseBytes = bytes(base);
  if (baseBytes > input.byteBudget) {
    throw new ContextProjectionOverflowError(input.byteBudget, baseBytes);
  }
  const durableBudget = Math.min(65_536, minimumDurable.byteLength + input.byteBudget - baseBytes);
  const durable = projectConversationContext(input.state, durableBudget);
  const packet: {
    schemaVersion: 1;
    trustBoundary: RealtimeContextPacket["trustBoundary"];
    authority: RealtimeContextPacket["authority"];
    durable: ContextProjection;
    capabilities: RealtimePacketCapability[];
    recentAudibleTurns: ProjectedAudibleTurn[];
    omittedRecentTurnCount: number;
  } = { ...base, durable: durable.value };
  if (bytes(packet) > input.byteBudget) {
    // Canonical envelope growth can differ by a few bytes as counts change.
    // Mandatory state remains fail-closed rather than being trimmed.
    throw new ContextProjectionOverflowError(input.byteBudget, bytes(packet));
  }

  for (const turn of [...recent].reverse()) {
    packet.recentAudibleTurns.unshift({ ...turn, textTrust: "untrusted_advisory" });
    packet.omittedRecentTurnCount -= 1;
    if (bytes(packet) > input.byteBudget) {
      packet.recentAudibleTurns.shift();
      packet.omittedRecentTurnCount += 1;
      break;
    }
  }
  const serialized = canonicalJson(packet);
  return Object.freeze({ value: Object.freeze(packet), serialized, byteLength: bytes(packet) });
}
