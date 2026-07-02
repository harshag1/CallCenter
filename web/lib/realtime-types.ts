// Author: Harsha Gundala
// realtime-types.ts — LiveEvent shapes fanned out by the org_events NOTIFY bus (migrations/004_platform.sql).

export type CallEventType =
  | "user_said"
  | "agent_said"
  | "tool_call"
  | "tool_result"
  | "state"
  | "error"
  | "audio_start"
  | "speech"
  | "human_segment"
  | "hold_start"
  | "hold_end"
  | (string & {});

/** Row inserted into call_events (trigger: trg_notify_call_event). */
export type LiveCallEvent = {
  kind: "call_event";
  callId: string;
  eventId: number;
  type: CallEventType;
  payload: Record<string, unknown>;
  ts: string;
};

/** calls insert/update (trigger: trg_notify_call_update). */
export type LiveCallUpdate = {
  kind: "call_update";
  callId: string;
  status: "dialing" | "active" | "completed" | (string & {});
  satisfaction: number | null;
  direction: "web" | "inbound" | "outbound";
};

export type LiveDatasetUpdate = {
  kind: "dataset_update";
  datasetId: string;
};

export type LiveEvent = LiveCallEvent | LiveCallUpdate | LiveDatasetUpdate;
