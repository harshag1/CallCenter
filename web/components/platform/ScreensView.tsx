// Author: Harsha Gundala
// ScreensView.tsx — Notion-like screens: saved surfaces + grouped experiment dashboards.

"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, FileText, FlaskConical, Layout, LayoutDashboard, Table2 } from "lucide-react";
import SurfaceView from "@/components/surface/SurfaceView";
import ExperimentDashboard from "./ExperimentDashboard";
import type { Surface } from "@/lib/surface-dsl";

type Screen = {
  id: string; title: string; icon: string; kind: string;
  spec: { blocks?: unknown[] } | null; experiment_id: string | null;
};

const ICONS: Record<string, typeof Layout> = {
  layout: Layout, "layout-dashboard": LayoutDashboard, "file-text": FileText,
  table: Table2, flask: FlaskConical, "flask-conical": FlaskConical,
};

export default function ScreensView({ send }: { send: (prompt: string) => void }) {
  const [screens, setScreens] = useState<Screen[]>([]);
  const [open, setOpen] = useState<Screen | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch("/api/screens");
        if (!r.ok) return;
        const j = await r.json();
        if (live) setScreens(Array.isArray(j) ? j : j.screens ?? []);
      } catch { /* keep list */ }
    };
    void load();
    const iv = setInterval(load, 12_000);
    return () => { live = false; clearInterval(iv); };
  }, []);

  if (open) {
    const Icon = open.kind === "experiment" ? FlaskConical : ICONS[open.icon] ?? Layout;
    const isExperiment = open.kind === "experiment" && open.experiment_id;
    return (
      <div>
        <div className="mb-5 flex items-center gap-2">
          <button onClick={() => setOpen(null)} title="back" className="text-neutral-300 transition-colors hover:text-neutral-900">
            <ChevronLeft size={15} />
          </button>
          <Icon size={14} className="text-neutral-500" />
          {isExperiment && <span className="text-[13px] font-semibold">{open.title}</span>}
        </div>
        {isExperiment ? (
          <ExperimentDashboard experimentId={open.experiment_id!} send={send} />
        ) : (
          <SurfaceView surface={{ title: open.title, blocks: (open.spec?.blocks ?? []) as Surface["blocks"] }} send={send} />
        )}
      </div>
    );
  }

  const plain = screens.filter((s) => s.kind !== "experiment");
  const experiments = screens.filter((s) => s.kind === "experiment");

  return (
    <div className="max-w-lg space-y-7">
      <section>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-neutral-400">screens</div>
        {plain.map((s) => <ScreenRow key={s.id} s={s} onOpen={setOpen} />)}
        {!plain.length && <div className="px-3 py-4 text-xs text-neutral-300">none yet</div>}
      </section>
      {experiments.length > 0 && (
        <section>
          <div className="mb-2 text-[11px] uppercase tracking-wide text-neutral-400">experiments</div>
          {experiments.map((s) => <ScreenRow key={s.id} s={s} onOpen={setOpen} />)}
        </section>
      )}
    </div>
  );
}

function ScreenRow({ s, onOpen }: { s: Screen; onOpen: (s: Screen) => void }) {
  const Icon = s.kind === "experiment" ? FlaskConical : ICONS[s.icon] ?? Layout;
  return (
    <button
      onClick={() => onOpen(s)}
      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-50"
    >
      <Icon size={14} className="text-neutral-400" />
      <span className="text-[13px]">{s.title}</span>
    </button>
  );
}
