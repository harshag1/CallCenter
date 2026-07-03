// Author: Harsha Gundala
// ScreensView.tsx — kind-scoped screen list (plain surfaces or experiment dashboards), deep-linkable.

"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, FileText, FlaskConical, Layout, LayoutDashboard, Table2, X } from "lucide-react";
import SurfaceView from "@/components/surface/SurfaceView";
import ExperimentDashboard from "./ExperimentDashboard";
import type { Surface } from "@/lib/surface-dsl";

export type Screen = {
  id: string; title: string; icon: string; kind: string;
  spec: { blocks?: unknown[] } | null; experiment_id: string | null;
};

const ICONS: Record<string, typeof Layout> = {
  layout: Layout, "layout-dashboard": LayoutDashboard, "file-text": FileText,
  table: Table2, flask: FlaskConical, "flask-conical": FlaskConical,
};

export default function ScreensView({
  send, screens, kind, openScreenId, onScreenChange, onOpenCall, reload,
}: {
  send: (prompt: string) => void;
  screens: Screen[];
  /** Which slice this tab shows: plain screens or experiment dashboards. */
  kind: "screen" | "experiment";
  /** Deep-link target (navigate events, ?screen=): opened as soon as it appears in the list. */
  openScreenId?: string | null;
  onScreenChange?: (id: string | null) => void;
  onOpenCall?: (callId: string) => void;
  reload?: () => void;
}) {
  // undefined → follow the deep link; null → explicitly closed; string → manually opened.
  const [manualId, setManualId] = useState<string | null | undefined>(undefined);
  const [prevDeepLink, setPrevDeepLink] = useState(openScreenId);
  if (openScreenId !== prevDeepLink) {
    // New deep-link target takes over any manual navigation (adjust-during-render).
    setPrevDeepLink(openScreenId);
    setManualId(undefined);
  }
  const currentId = manualId === undefined ? openScreenId ?? null : manualId;
  const open = currentId ? screens.find((s) => s.id === currentId) ?? null : null;

  const setOpen = useCallback((s: Screen | null) => {
    setManualId(s?.id ?? null);
    onScreenChange?.(s?.id ?? null);
  }, [onScreenChange]);

  const list = screens.filter((s) => (kind === "experiment" ? s.kind === "experiment" : s.kind !== "experiment"));

  // Deep-linked screen not in the list yet (just created) → refetch.
  useEffect(() => {
    if (currentId && !screens.some((s) => s.id === currentId)) reload?.();
  }, [currentId, screens, reload]);

  if (open) {
    if (open.kind === "experiment" && open.experiment_id) {
      return (
        <ExperimentDashboard
          experimentId={open.experiment_id}
          onBack={() => setOpen(null)}
          onOpenCall={onOpenCall}
        />
      );
    }
    const Icon = ICONS[open.icon] ?? Layout;
    return (
      <div>
        <div className="mb-5 flex items-center gap-2">
          <button onClick={() => setOpen(null)} title="back" className="text-neutral-300 transition-colors hover:text-neutral-900">
            <ChevronLeft size={15} />
          </button>
          <Icon size={14} className="text-neutral-500" />
        </div>
        <SurfaceView surface={{ title: open.title, blocks: (open.spec?.blocks ?? []) as Surface["blocks"] }} send={send} />
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      {list.map((s) => <ScreenRow key={s.id} s={s} onOpen={setOpen} />)}
      {!list.length && (
        <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
          <X size={18} strokeWidth={1.8} className="text-neutral-300" />
          <span className="text-xs text-neutral-400">
            {kind === "experiment" ? "Ask the agent to run an A/B test" : "Request special views from the agent"}
          </span>
        </div>
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
