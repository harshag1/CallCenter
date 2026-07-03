// Author: Harsha Gundala
// ExperimentDashboard.tsx — live A/B screen: variant flows with diff accents, per-variant stats, call scatter.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft } from "lucide-react";
import {
  ResponsiveContainer, Scatter, ScatterChart, Tooltip as ChartTooltip, XAxis, YAxis, ZAxis,
} from "recharts";
import FlowPanel from "@/components/flow/FlowPanel";
import { useLiveEvents } from "@/components/hooks/useLiveEvents";
import type { LiveEvent } from "@/lib/realtime-types";

type FlowNode = {
  id: string; label: string; kind?: string; icon?: string;
  context?: string; steps?: { id?: string; label: string; instructions?: string }[];
  support_number?: string; table?: string;
};
type FlowLike = { nodes: FlowNode[]; edges: { from: string; to: string; label?: string }[] };

type VariantData = {
  key: string; label: string; calls: number;
  avg_satisfaction: number | null; avg_duration_s: number | null;
  flow: FlowLike | null;
  instructions_patch: string | null;
};
type CallPoint = {
  id: string; variant: string; satisfaction: number; duration_s: number | null;
  started_at: string; resolution: string | null; review: string | null;
};
type Payload = {
  experiment: { id: string; name: string; hypothesis: string | null; status: string };
  agent: { id: string; name: string; phone_number: string | null } | null;
  variants: VariantData[];
  calls: CallPoint[];
};

const PALETTE = ["#3b82f6", "#8b5cf6", "#f59e0b", "#f43f5e"]; // A blue · B violet · C amber · D rose
const variantColor = (key: string) => PALETTE[Math.max("abcdefgh".indexOf(key), 0) % PALETTE.length];

const RESOLUTION_LABEL: Record<string, string> = {
  ai_resolved: "AI resolved", human_resolved: "Human resolved", unresolved: "Unresolved",
};

const mmss = (s: number | null | undefined) => {
  if (s == null) return "—";
  const n = Math.round(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

async function fetchExperiment(id: string): Promise<Payload | null> {
  try {
    const r = await fetch(`/api/experiments/${id}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // keep last snapshot
  }
}

/** Node ids whose label/context/steps/support number differ across variant flows (or exist in only some). */
function diffNodeIds(variants: VariantData[]): Set<string> {
  const flows = variants.map((v) => v.flow).filter(Boolean) as FlowLike[];
  if (flows.length < 2) return new Set();
  const sig = (n: FlowNode) =>
    JSON.stringify([n.label, n.context ?? null, n.steps ?? null, n.support_number ?? null, n.table ?? null]);
  const ids = new Set(flows.flatMap((f) => f.nodes.map((n) => n.id)));
  const out = new Set<string>();
  for (const id of ids) {
    const sigs = flows.map((f) => {
      const n = f.nodes.find((x) => x.id === id);
      return n ? sig(n) : "__absent__";
    });
    if (new Set(sigs).size > 1) out.add(id);
  }
  if (out.size === 0) {
    // Instruction-level experiment: identical flows, only the prompt differs → the entry node is what changed.
    const patches = new Set(variants.map((v) => v.instructions_patch ?? ""));
    if (patches.size > 1) {
      for (const f of flows) {
        const entry = f.nodes.find((n) => n.kind === "incoming_call" || n.kind === "start") ?? f.nodes[0];
        if (entry) out.add(entry.id);
      }
    }
  }
  return out;
}

export default function ExperimentDashboard({
  experimentId, onBack, onOpenCall,
}: { experimentId: string; onBack?: () => void; onOpenCall?: (callId: string) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(() => {
    void fetchExperiment(experimentId).then((d) => d && setData(d));
  }, [experimentId]);

  useEffect(() => {
    let live = true;
    void fetchExperiment(experimentId).then((d) => { if (live && d) setData(d); });
    return () => {
      live = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
  }, [experimentId]);

  // Any call closing may shift metrics — refetch, debounced 3s.
  useLiveEvents((ev: LiveEvent) => {
    if (ev.kind !== "call_update" || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      refetch();
    }, 3000);
  });

  if (!data?.experiment) return <div className="py-16 text-center text-xs text-neutral-300">…</div>;
  const { experiment, agent } = data;
  const variants = data.variants ?? [];
  const running = experiment.status === "running";
  const diff = diffNodeIds(variants);

  return (
    <div className="space-y-7">
      <header className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} title="back" className="text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900">
            <ChevronLeft size={15} />
          </button>
        )}
        <StatusDot running={running} />
        <h1 className="text-[15px] font-semibold tracking-tight">{experiment.name}</h1>
        <div className="flex-1" />
        {running && <StopButton experimentId={experiment.id} onStopped={refetch} />}
      </header>

      {experiment.hypothesis && (
        <p className="-mt-4 text-[13px] leading-relaxed text-neutral-500">{experiment.hypothesis}</p>
      )}

      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(variants.length, 1), 4)}, minmax(0, 1fr))` }}
      >
        {variants.map((v) => (
          <VariantCard key={v.key} v={v} color={variantColor(v.key)} diff={diff} number={agent?.phone_number ?? null} />
        ))}
      </div>

      <CallScatter variants={variants} calls={data.calls ?? []} onOpenCall={onOpenCall} />
    </div>
  );
}

/** Small emerald pulse dot — running status without a label. */
function StatusDot({ running }: { running: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${running ? "bg-emerald-500" : "bg-neutral-300"}`} />
    </span>
  );
}

/** Red pill with a two-step confirm; stops via the experiments API. */
function StopButton({ experimentId, onStopped }: { experimentId: string; onStopped: () => void }) {
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const revert = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (revert.current) clearTimeout(revert.current); }, []);

  const click = async () => {
    if (!arming) {
      setArming(true);
      revert.current = setTimeout(() => setArming(false), 3500);
      return;
    }
    if (revert.current) clearTimeout(revert.current);
    setBusy(true);
    await fetch(`/api/experiments/${experimentId}`, { method: "DELETE" }).catch(() => {});
    setBusy(false);
    setArming(false);
    onStopped();
  };

  return (
    <button
      onClick={click}
      disabled={busy}
      className={`rounded-full border px-3.5 py-1 text-[11px] font-medium transition-colors duration-[160ms] disabled:opacity-50 ${
        arming
          ? "border-red-500 bg-red-500 text-white"
          : "border-red-200 text-red-500 hover:border-red-400"
      }`}
    >
      {arming ? "Confirm stop" : "Stop"}
    </button>
  );
}

function VariantCard({
  v, color, diff, number,
}: { v: VariantData; color: string; diff: Set<string>; number: string | null }) {
  const showLabel = v.label && v.label.toLowerCase() !== v.key.toLowerCase();
  const diffIds = useMemo(
    () => (v.flow ? v.flow.nodes.filter((n) => diff.has(n.id)).map((n) => n.id) : []),
    [v.flow, diff]
  );
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-2xl font-extrabold leading-none tracking-tight" style={{ color }}>
          {v.key.toUpperCase()}
        </span>
        {showLabel && <span className="truncate text-[12px] text-neutral-400">{v.label}</span>}
      </div>
      <p className="mb-2 line-clamp-2 min-h-[2.1rem] text-[12px] leading-snug text-neutral-600" title={v.instructions_patch ?? undefined}>
        {v.instructions_patch ? <>&ldquo;{v.instructions_patch}&rdquo;</> : <span className="text-neutral-400">Control — unchanged</span>}
      </p>
      <div className="h-[200px] overflow-hidden rounded-2xl border border-[var(--border)]">
        {v.flow ? (
          <FlowPanel flow={v.flow} number={number} interactive={false} fitPadding={0.1} diffNodeIds={diffIds} diffColor={color} />
        ) : (
          <div className="flex h-full items-center justify-center bg-[#f7f7f6] text-xs text-neutral-300">no flow</div>
        )}
      </div>
      <div className="mt-3 space-y-1.5 px-0.5">
        <StatRow label="avg satisfaction" value={v.avg_satisfaction != null ? `${Number(v.avg_satisfaction).toFixed(1)}/10` : "—"} />
        <StatRow label="avg call length" value={mmss(v.avg_duration_s)} />
        <StatRow label="calls" value={v.calls} />
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</span>
      <span className="text-[13px] tabular-nums text-neutral-900">{value}</span>
    </div>
  );
}

type YMode = "date" | "duration";
type Point = CallPoint & { x: number; y: number };

function CallScatter({
  variants, calls, onOpenCall,
}: { variants: VariantData[]; calls: CallPoint[]; onOpenCall?: (id: string) => void }) {
  const [yMode, setYMode] = useState<YMode>("date");

  const series = useMemo(() => {
    const toY = (c: CallPoint) => (yMode === "date" ? Date.parse(c.started_at) : c.duration_s ?? 0);
    return variants.map((v) => ({
      key: v.key,
      color: variantColor(v.key),
      points: calls.filter((c) => c.variant === v.key).map((c): Point => ({ ...c, x: c.satisfaction, y: toY(c) })),
    }));
  }, [variants, calls, yMode]);

  const yTick = (t: number) => {
    if (yMode === "duration") return mmss(t);
    const d = new Date(t);
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="rounded-2xl border border-[var(--border)] p-4">
      <div className="mb-1 flex items-center justify-end">
        <label className="relative inline-flex cursor-pointer items-center text-neutral-400 transition-colors duration-[160ms] hover:text-neutral-900">
          <select
            value={yMode}
            onChange={(e) => setYMode(e.target.value as YMode)}
            className="cursor-pointer appearance-none bg-transparent pr-4 text-right text-[11px] text-inherit outline-none"
          >
            <option value="date">date</option>
            <option value="duration">call length</option>
          </select>
          <ChevronDown size={11} className="pointer-events-none absolute right-0" />
        </label>
      </div>
      {calls.length ? (
        <div className="h-64">
          <ResponsiveContainer>
            <ScatterChart margin={{ top: 6, right: 10, bottom: 14, left: yMode === "date" ? 22 : -14 }}>
              <XAxis
                type="number"
                dataKey="x"
                domain={[1, 10]}
                ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
                tick={{ fontSize: 10, fill: "#a3a3a3" }}
                stroke="#e5e5e5"
                tickLine={false}
                label={{ value: "satisfaction", position: "insideBottom", offset: -10, fontSize: 10, fill: "#a3a3a3" }}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={yMode === "date" ? ["dataMin - 7200000", "dataMax + 7200000"] : [0, "dataMax + 40"]}
                tick={{ fontSize: 9, fill: "#a3a3a3" }}
                stroke="#e5e5e5"
                tickLine={false}
                tickFormatter={yTick}
              />
              <ZAxis range={[52, 52]} />
              <ChartTooltip content={<PointTip />} cursor={{ stroke: "#d4d4d4", strokeDasharray: "3 3" }} isAnimationActive={false} />
              {series.map((s) => (
                <Scatter
                  key={s.key}
                  data={s.points}
                  fill={s.color}
                  fillOpacity={0.85}
                  className={onOpenCall ? "cursor-pointer" : undefined}
                  onClick={(pt: unknown) => {
                    const id = (pt as { payload?: { id?: string }; id?: string })?.payload?.id
                      ?? (pt as { id?: string })?.id;
                    if (id && onOpenCall) onOpenCall(id);
                  }}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="py-14 text-center text-xs text-neutral-300">no scored calls yet</div>
      )}
    </div>
  );
}

/** White-card tooltip: variant chip, timestamp, duration, satisfaction, resolution, review teaser. */
function PointTip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const d = new Date(p.started_at);
  const when = `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  const review = p.review ? (p.review.length > 60 ? `${p.review.slice(0, 60).trimEnd()}…` : p.review) : null;
  return (
    <div className="w-[228px] rounded-[10px] border border-neutral-200 bg-white p-3 shadow-[0_18px_44px_rgba(0,0,0,0.14)]">
      <div className="flex items-center gap-2">
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-extrabold text-white"
          style={{ background: variantColor(p.variant) }}
        >
          {p.variant.toUpperCase()}
        </span>
        <span className="text-[11px] tabular-nums text-neutral-500">{when}</span>
      </div>
      <div className="mt-2.5 space-y-1">
        <TipRow label="duration" value={mmss(p.duration_s)} />
        <TipRow label="satisfaction" value={`${p.satisfaction}/10`} />
        <TipRow label="resolution" value={p.resolution ? RESOLUTION_LABEL[p.resolution] ?? p.resolution : "—"} />
      </div>
      {review && (
        <p className="mt-2 border-t border-neutral-200/80 pt-2 text-[11px] leading-relaxed text-neutral-500">{review}</p>
      )}
    </div>
  );
}

function TipRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-neutral-400">{label}</span>
      <span className="text-[11px] tabular-nums text-neutral-900">{value}</span>
    </div>
  );
}
