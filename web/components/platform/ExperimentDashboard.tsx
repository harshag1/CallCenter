// Author: Harsha Gundala
// ExperimentDashboard.tsx — live A/B view: variant stat cards, resolution splits, satisfaction-over-time.

"use client";

import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLiveEvents } from "@/components/hooks/useLiveEvents";
import type { LiveEvent } from "@/lib/realtime-types";
import { PulseDot } from "./shared";

type VariantMetric = {
  key: string; label: string; calls: number; avg_satisfaction: number | null;
  resolutions: { ai_resolved: number; human_resolved: number; unresolved: number };
};
type Payload = {
  experiment: { id: string; name: string; hypothesis: string | null; status: string };
  metrics: { variants: VariantMetric[]; series: { day: string; variant: string; avg: number }[] };
};

const LINE_COLORS = ["#111", "#9ca3af", "#d1d5db", "#6b7280"];

async function fetchExperiment(id: string): Promise<Payload | null> {
  try {
    const r = await fetch(`/api/experiments/${id}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // keep last snapshot
  }
}

export default function ExperimentDashboard({
  experimentId, send,
}: { experimentId: string; send: (prompt: string) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      void fetchExperiment(experimentId).then((d) => d && setData(d));
    }, 3000);
  });

  if (!data?.experiment) return <div className="py-16 text-center text-xs text-neutral-300">…</div>;
  const { experiment, metrics } = data;
  const variants = metrics?.variants ?? [];
  const series = metrics?.series ?? [];
  const running = experiment.status === "running";

  const days = [...new Set(series.map((s) => String(s.day)))].sort();
  const chart = days.map((day) => {
    const row: Record<string, unknown> = { day: day.slice(5, 10) };
    for (const s of series) if (String(s.day) === day) row[s.variant] = s.avg;
    return row;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[10px] uppercase tracking-wide text-neutral-500">
          <PulseDot live={running} color="bg-emerald-500" ping="bg-emerald-400" /> {experiment.status}
        </span>
        {running && (
          <button
            onClick={() => send(`Stop the experiment "${experiment.name}" (${experiment.id}).`)}
            className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600 transition-colors hover:border-red-400 hover:text-red-500"
          >
            <Square size={9} fill="currentColor" /> stop
          </button>
        )}
      </div>

      {experiment.hypothesis && <p className="text-[13px] leading-relaxed text-neutral-500">{experiment.hypothesis}</p>}

      <div className="flex gap-3">
        {variants.map((v) => {
          const res = v.resolutions ?? { ai_resolved: 0, human_resolved: 0, unresolved: 0 };
          const total = Math.max(res.ai_resolved + res.human_resolved + res.unresolved, 1);
          return (
            <div key={v.key} className="flex-1 rounded-2xl border border-[var(--border)] p-4">
              <div className="text-[11px] uppercase tracking-wide text-neutral-400">{v.label}</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums tracking-tight">
                  {v.avg_satisfaction != null ? Number(v.avg_satisfaction).toFixed(1) : "—"}
                </span>
                <span className="text-[11px] tabular-nums text-neutral-400">{v.calls} calls</span>
              </div>
              <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-neutral-100">
                <div title={`ai resolved · ${res.ai_resolved}`} style={{ width: `${(res.ai_resolved / total) * 100}%`, background: "#111" }} />
                <div title={`human resolved · ${res.human_resolved}`} style={{ width: `${(res.human_resolved / total) * 100}%`, background: "#6366f1" }} />
                <div title={`unresolved · ${res.unresolved}`} style={{ width: `${(res.unresolved / total) * 100}%`, background: "#e5e5e5" }} />
              </div>
            </div>
          );
        })}
        {!variants.length && (
          <div className="flex-1 rounded-2xl border border-[var(--border)] p-6 text-center text-xs text-neutral-300">no calls yet</div>
        )}
      </div>

      {chart.length > 0 && (
        <div className="h-60 rounded-2xl border border-[var(--border)] p-4">
          <ResponsiveContainer>
            <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
              <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="#ddd" />
              <YAxis domain={[1, 10]} tick={{ fontSize: 10 }} stroke="#ddd" />
              <Tooltip />
              {variants.map((v, i) => (
                <Line
                  key={v.key}
                  dataKey={v.key}
                  name={v.label}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={i === 0 ? 2 : 1.4}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
