// Author: Harsha Gundala
// NodeEditor.tsx — in-canvas node inspector: topic context/steps/tools, and the agent's
// full prompt + tool belt behind the entry node (chat edits become visible here).

"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Check, Loader2, Database, Wrench } from "lucide-react";
import type { FlowNode } from "@/lib/flow";

const KNOWN_TOOLS = [
  "write_table", "read_table", "search_knowledge", "search", "send_email", "send_sms",
  "contact_support", "hold", "request_recall", "end_call", "launch_task", "log_note",
];

function toolsInSteps(node: FlowNode): string[] {
  const text = [node.context ?? "", ...(node.steps ?? []).map((s) => s.instructions)].join(" ");
  return KNOWN_TOOLS.filter((t) => text.includes(t));
}

type AgentInfo = {
  version: number; instructions: string; tools: string[]; updated_by: string; updated_at: string;
};

export default function NodeEditor({
  node, agentId, flowInstructions, onSave, onSaveInstructions, onClose,
}: {
  node: FlowNode;
  agentId?: string | null;
  /** For outbound named flows: show this prompt read-only on the entry node. */
  flowInstructions?: string | null;
  onSave: (patch: FlowNode) => Promise<boolean>;
  onSaveInstructions?: (instructions: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(node.label);
  const [context, setContext] = useState(node.context ?? "");
  const [steps, setSteps] = useState(node.steps ?? []);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [prompt, setPrompt] = useState("");
  const isEntry = node.kind === "incoming_call";
  const stepTools = useMemo(() => toolsInSteps({ ...node, context, steps }), [node, context, steps]);

  // Entry node: load the live agent config (prompt + belt) so chat edits are inspectable.
  useEffect(() => {
    if (!isEntry) return;
    if (flowInstructions != null) {
      setPrompt(flowInstructions);
      return;
    }
    if (!agentId) return;
    fetch(`/api/agents/${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) { setAgent(j); setPrompt(j.instructions); } })
      .catch(() => {});
  }, [isEntry, agentId, flowInstructions]);

  async function save() {
    setBusy(true);
    let ok: boolean;
    if (isEntry) {
      ok = onSaveInstructions && flowInstructions == null ? await onSaveInstructions(prompt) : true;
    } else {
      ok = await onSave({ ...node, label, context: context || undefined, steps: steps.length ? steps : undefined });
    }
    setBusy(false);
    if (ok) onClose();
  }

  const input = "w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-neutral-500";
  const canEditPrompt = isEntry && flowInstructions == null && !!onSaveInstructions;

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 top-3 z-20 flex w-[320px] flex-col rounded-2xl border border-neutral-200 bg-white shadow-[0_12px_40px_rgba(15,15,15,0.10)]">
      <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
        {isEntry ? (
          <span className="text-[13px] font-semibold">{node.label}</span>
        ) : (
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="mr-2 w-full bg-transparent text-[13px] font-semibold outline-none" />
        )}
        <button onClick={onClose} className="text-neutral-300 hover:text-neutral-900"><X size={14} /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
        {isEntry && (
          <>
            {agent && (
              <div className="text-[11px] text-neutral-400">
                v{agent.version} · {agent.updated_by.replace(/\s*\(.*\)/, "")}
              </div>
            )}
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">Prompt</div>
              <textarea
                rows={12}
                value={prompt}
                readOnly={!canEditPrompt}
                onChange={(e) => setPrompt(e.target.value)}
                className={`${input} resize-none font-mono text-[11px] leading-[1.55] ${!canEditPrompt ? "bg-neutral-50 text-neutral-500" : ""}`}
              />
            </div>
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-400">Tools</div>
              <div className="flex flex-wrap gap-1">
                {(agent?.tools ?? KNOWN_TOOLS).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-[10px] text-neutral-500">
                    <Wrench size={9} /> {t}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {node.kind === "topic" && (
          <>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">Context</div>
              <textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} className={`${input} resize-none leading-relaxed`} />
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">Steps</div>
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
            </div>
            {(stepTools.length > 0 || node.table) && (
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wide text-neutral-400">Uses</div>
                <div className="flex flex-wrap gap-1">
                  {node.table && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-[10px] text-neutral-600">
                      <Database size={9} /> {node.table}
                    </span>
                  )}
                  {stepTools.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-[10px] text-neutral-500">
                      <Wrench size={9} /> {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {node.kind === "fallback" && (
          <p className="text-[12px] leading-relaxed text-neutral-500">
            Out-of-scope calls offer a transfer to the support line{node.support_number ? ` (${node.support_number})` : ""}.
          </p>
        )}
      </div>

      {(canEditPrompt || node.kind === "topic") && (
        <div className="border-t border-neutral-100 p-3">
          <button
            onClick={save}
            disabled={busy || (!isEntry && !label.trim())}
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-neutral-950 text-[12px] font-medium text-white disabled:opacity-30"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} /> Save</>}
          </button>
        </div>
      )}
    </div>
  );
}
