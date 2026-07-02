// Author: Harsha Gundala
// FlowPicker.tsx — quiet flow selector: plain name + chevron with a popover list over the flow graph.

"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, PhoneIncoming, PhoneOutgoing } from "lucide-react";

export type FlowOption = { id: string; label: string; kind?: string };

export default function FlowPicker({
  options, selectedId, label, onSelect,
}: { options: FlowOption[]; selectedId: string | null; label: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[13px] font-medium text-neutral-900 transition-opacity duration-[160ms] hover:opacity-70"
      >
        <span className="max-w-[180px] truncate">{label}</span>
        <ChevronDown size={13} className={`text-neutral-400 transition-transform duration-[160ms] ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-56 rounded-xl border border-neutral-200 bg-white/95 p-1 shadow-[0_18px_44px_rgba(0,0,0,0.12)] backdrop-blur">
          {options.map((o) => {
            const Kind = o.kind === "inbound" ? PhoneIncoming : PhoneOutgoing;
            const selected = o.id === selectedId;
            return (
              <button
                key={o.id}
                onClick={() => { setOpen(false); onSelect(o.id); }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors duration-[160ms] hover:bg-neutral-50 ${selected ? "text-neutral-900" : "text-neutral-600"}`}
              >
                <Kind size={11} className="shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {selected && <Check size={12} className="shrink-0 text-neutral-900" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
