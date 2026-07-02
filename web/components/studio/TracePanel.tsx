// Author: Harsha Gundala
// TracePanel.tsx — slide-out live trace sidebar: tool calls, transfers, holds, node hops.

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowRight, Wrench, X } from "lucide-react";
import { PulseDot, mmss, useNow } from "@/components/platform/shared";

export type TraceEvent =
  | { kind: "tool"; name: string; arg: string }
  | { kind: "transfer"; to: string }
  | { kind: "hold"; until?: string; seconds?: number; ended?: boolean }
  | { kind: "node"; node: string }
  | { kind: "ended" };

/** Amber hold line — live mm:ss countdown while an `until` deadline is ahead. */
function HoldLine({ e }: { e: Extract<TraceEvent, { kind: "hold" }> }) {
  const now = useNow(500);
  const deadline = e.until ? Date.parse(e.until) : null;
  const counting = !e.ended && deadline != null && deadline > now;
  return (
    <span className="text-amber-600">
      {counting ? `on hold ${mmss(deadline! - now)}` : `on hold${e.seconds ? ` ${e.seconds}s` : ""}`}
    </span>
  );
}

/** One feed row: fixed icon slot keeps mono text columns aligned. */
function Line({ slot, children }: { slot?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="flex w-[15px] shrink-0 items-center justify-center">{slot}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

export default function TracePanel({
  events, live, onClose,
}: { events: TraceEvent[]; live: boolean; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  return (
    <aside
      aria-label="Live trace"
      className="animate-trace-in absolute bottom-2 right-2 top-2 z-20 flex w-[276px] flex-col rounded-2xl border border-neutral-200 bg-white shadow-[0_12px_36px_rgba(0,0,0,0.08)]"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-100 px-3">
        <PulseDot live={live} />
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-400">live trace</span>
        {!live && (
          <button
            aria-label="Close trace"
            onClick={onClose}
            className="ml-auto text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-[7px] overflow-y-auto px-3 py-2.5 font-mono text-[11px] leading-[1.45] text-neutral-500"
      >
        {events.length === 0 && <div className="pt-0.5 text-neutral-300">listening…</div>}
        {events.map((e, i) =>
          e.kind === "tool" ? (
            <Line key={i} slot={<Wrench size={15} strokeWidth={2} className="text-neutral-400" />}>
              {e.name}(<span className="text-neutral-400">{e.arg}</span>)
            </Line>
          ) : e.kind === "transfer" ? (
            <Line key={i} slot={<ArrowRight size={15} strokeWidth={2.1} className="text-indigo-400" />}>
              <span className="text-indigo-500">transfer {e.to}</span>
            </Line>
          ) : e.kind === "hold" ? (
            <Line key={i}>
              <HoldLine e={e} />
            </Line>
          ) : e.kind === "node" ? (
            <Line key={i} slot={<span className="h-1.5 w-1.5 rounded-full bg-neutral-700" />}>
              <span className="font-semibold text-neutral-700">{e.node}</span>
            </Line>
          ) : (
            <div key={i} className="mt-1 border-t border-neutral-100 pt-1.5 text-[10px] tracking-wide text-neutral-300">
              call ended
            </div>
          )
        )}
      </div>
    </aside>
  );
}
