// Author: Harsha Gundala
// calls.ts — operator tools: call listing, full call inspection, recording access.

import { q, qOne } from "../../db";
import type { OperatorTool } from "../types";

export const listCalls: OperatorTool = {
  name: "list_calls",
  description: "List recent calls (optionally for one bot), with status, direction, duration, sentiment, summary.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      limit: { type: "number", default: 25 },
    },
  },
  async execute(args, ctx) {
    const rows = await q(
      `SELECT c.id, a.name AS agent, c.direction, c.status, c.from_number, c.to_number,
              c.started_at, c.duration_s, c.sentiment, c.summary
       FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE a.org_id = $1 AND ($2::uuid IS NULL OR c.agent_id = $2)
       ORDER BY c.started_at DESC LIMIT $3`,
      [ctx.orgId, args.agent_id ?? null, Math.min(Number(args.limit ?? 25), 100)]
    );
    return { output: rows };
  },
};

export const getCall: OperatorTool = {
  name: "get_call",
  description:
    "Fetch one call in depth: metadata, full transcript, every tool call the voice agent made, and whether a recording exists.",
  parameters: {
    type: "object",
    properties: { call_id: { type: "string" } },
    required: ["call_id"],
  },
  async execute(args, ctx) {
    const call = await qOne(
      `SELECT c.*, a.name AS agent_name, a.org_id FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE c.id = $1 AND a.org_id = $2`,
      [args.call_id, ctx.orgId]
    );
    if (!call) return { output: { error: "call not found" } };
    const events = await q(
      "SELECT ts, type, payload FROM call_events WHERE call_id = $1 ORDER BY ts, id LIMIT 500",
      [args.call_id]
    );
    const hasRecording = !!(await qOne("SELECT call_id FROM call_recordings WHERE call_id = $1", [args.call_id]));
    return {
      output: {
        call: { ...call, org_id: undefined },
        events,
        recording_url: hasRecording ? `/api/calls/${args.call_id}/recording` : null,
      },
    };
  },
};

export const getRecording: OperatorTool = {
  name: "get_recording",
  description: "Get the playback URL for a call recording and surface an inline audio player.",
  parameters: {
    type: "object",
    properties: { call_id: { type: "string" } },
    required: ["call_id"],
  },
  async execute(args, ctx) {
    const owned = await qOne(
      "SELECT c.id FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1 AND a.org_id = $2",
      [args.call_id, ctx.orgId]
    );
    if (!owned) return { output: { error: "call not found" } };
    const rec = await qOne("SELECT mime FROM call_recordings WHERE call_id = $1", [args.call_id]);
    if (!rec) return { output: { error: "no recording stored for this call" } };
    const src = `/api/calls/${args.call_id}/recording`;
    return {
      output: { url: src, mime: rec.mime },
      surface: { title: "Recording", blocks: [{ kind: "audio", src }, { kind: "transcript", callId: String(args.call_id) }] },
    };
  },
};
