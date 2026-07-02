// Author: Harsha Gundala
// NodeEditor.tsx — in-canvas control panel for a clicked flow node (label, context, steps).

"use client";

import { useState } from "react";
import { X, Check, Loader2 } from "lucide-react";
import type { FlowNode } from "@/lib/flow";

export default function NodeEditor({
  node, onSave, onClose,
}: {
  node: FlowNode;
  onSave: (patch: FlowNode) => Promise<boolean>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(node.label);
  const [context, setContext] = useState(node.context ?? "");
  const [steps, setSteps] = useState(node.steps ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await onSave({ ...node, label, context: context || undefined, steps: steps.length ? steps : undefined });
    setBusy(false);
    if (ok) onClose();
  }

  const input = "w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-neutral-500";

  return (
    <div className="pointer-events-auto absolute right-3 top-14 z-20 w-[300px] rounded-2xl border border-neutral-200 bg-white p-4 shadow-[0_12px_40px_rgba(15,15,15,0.10)]">
      <div className="mb-3 flex items-center justify-between">
        <input value={label} onChange={(e) => setLabel(e.target.value)} className="mr-2 w-full bg-transparent text-[13px] font-semibold outline-none" />
        <button onClick={onClose} className="text-neutral-300 hover:text-neutral-900"><X size={14} /></button>
      </div>

      {node.kind === "topic" && (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">Context</div>
          <textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} className={`${input} resize-none leading-relaxed`} />
          <div className="mb-1 mt-3 text-[10px] uppercase tracking-wide text-neutral-400">Steps</div>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={s.id} className="rounded-xl border border-neutral-100 p-2">
                <input
                  value={s.label}
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  className="w-full bg-transparent text-[12px] font-medium outline-none"
                />
                <textarea
                  rows={2}
                  value={s.instructions}
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)))}
                  className="mt-1 w-full resize-none bg-transparent text-[11px] leading-relaxed text-neutral-500 outline-none"
                />
              </div>
            ))}
          </div>
        </>
      )}
      {node.kind === "incoming_call" && (
        <p className="text-[12px] text-neutral-400">Number is provisioned automatically.</p>
      )}

      <button
        onClick={save}
        disabled={busy || !label.trim()}
        className="mt-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-neutral-950 text-[12px] font-medium text-white disabled:opacity-30"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} /> Save</>}
      </button>
    </div>
  );
}
