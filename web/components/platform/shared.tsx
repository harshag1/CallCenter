// Author: Harsha Gundala
// shared.tsx — platform types, format helpers, and tiny shared atoms (chips, dots, icons).

"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Globe, Pause, PhoneIncoming, PhoneOutgoing, Sparkles, UserCheck, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";

export type CallRow = {
  id: string;
  agent_id: string;
  agent: string;
  agent_version?: number;
  direction: string;
  status: string;
  from_number: string | null;
  to_number: string | null;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  satisfaction: number | null;
  resolution: string | null;
  review: string | null;
  experiment_id: string | null;
  variant: string | null;
  summary?: string | null;
  flow_id?: string | null;
  campaign_id?: string | null;
  parent_call_id?: string | null;
  campaign?: string | null;
  flow_name?: string | null;
};

export type CallEvent = { id: number; ts: string; type: string; payload: Record<string, unknown> };

/** Ticking clock — re-renders the caller every intervalMs. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export function fmtDur(s: number | null | undefined): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

/** Compact relative time toward/since an ISO instant: "in 2m" / "3h ago". */
export function fmtRel(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const s =
    abs < 60_000 ? `${Math.max(1, Math.round(abs / 1000))}s`
    : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m`
    : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h`
    : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

/** 1–10 satisfaction → red scale below 5, neutral at 5, emerald scale above. */
export function satisfactionStyle(n: number): CSSProperties {
  if (n < 5) return { background: `rgba(239,68,68,${(0.12 + (5 - n) * 0.13).toFixed(2)})`, color: "#7f1d1d" };
  if (n > 5) return { background: `rgba(16,185,129,${(0.1 + (n - 5) * 0.09).toFixed(2)})`, color: "#064e3b" };
  return { background: "#f5f5f5", color: "#525252" };
}

export function SatChip({ n }: { n: number | null }) {
  if (n == null) return <span className="text-neutral-300">—</span>;
  return (
    <span
      className="inline-flex h-5 min-w-7 items-center justify-center rounded-full px-1 text-[11px] font-semibold tabular-nums"
      style={satisfactionStyle(n)}
    >
      {n}
    </span>
  );
}

export const RES_LABEL: Record<string, string> = {
  ai_resolved: "AI resolved",
  human_resolved: "Human resolved",
  unresolved: "Unresolved",
};

export function ResIcon({ r }: { r: string | null }) {
  const icon =
    r === "ai_resolved" ? <Sparkles size={13} className="text-neutral-900" />
    : r === "human_resolved" ? <UserCheck size={13} className="text-[#6366f1]" />
    : r === "unresolved" ? <X size={13} strokeWidth={2.5} className="text-red-500" />
    : null;
  if (!icon) return <span className="text-neutral-300">—</span>;
  return (
    <Tooltip content={RES_LABEL[r!]}>
      <span className="inline-flex">{icon}</span>
    </Tooltip>
  );
}

export function DirIcon({ d, size = 13 }: { d: string; size?: number }) {
  const Icon = d === "inbound" ? PhoneIncoming : d === "outbound" ? PhoneOutgoing : Globe;
  return (
    <span title={d} className="inline-flex">
      <Icon size={size} className="text-neutral-400" />
    </span>
  );
}

export type SpeakerKind = "agent" | "caller" | "human";

/** Speaker lane/dot colors: AI agent blue, customer purple, human support orange. */
export const SPEAKER_COLOR: Record<SpeakerKind, string> = {
  agent: "#3b82f6",
  caller: "#8b5cf6",
  human: "#f59e0b",
};

export const SPEAKER_LABEL: Record<SpeakerKind, string> = {
  agent: "agent",
  caller: "caller",
  human: "human support",
};

/** Transcript text color: caller tone follows satisfaction (red deepens as score drops). */
export function speakerTextColor(kind: SpeakerKind, satisfaction: number | null | undefined): string {
  if (kind === "agent") return "#525252";
  if (kind === "human") return "#b45309";
  if (satisfaction == null) return "#262626";
  if (satisfaction < 5) {
    const t = Math.min((5 - satisfaction) / 5, 1);
    const ch = (a: number, b: number) => Math.round(a + (b - a) * t);
    return `rgb(${ch(220, 127)},${ch(38, 29)},${ch(38, 29)})`;
  }
  return satisfaction >= 7 ? "#047857" : "#262626";
}

export function PulseDot({ live = true, color = "bg-red-500", ping = "bg-red-400" }: { live?: boolean; color?: string; ping?: string }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {live && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${ping}`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? color : "bg-neutral-300"}`} />
    </span>
  );
}

/** Live mm:ss countdown chip toward an ISO deadline (hold music, etc.). */
export function HoldChip({ until }: { until: string }) {
  const now = useNow(500);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium tabular-nums text-amber-800">
      <Pause size={9} strokeWidth={2.5} /> {mmss(Date.parse(until) - now)}
    </span>
  );
}
