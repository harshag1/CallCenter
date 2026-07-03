// Author: Harsha Gundala
// studio — golden onboarding surface: live flow graph, inline operator chat, in-browser Try mode.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LogOut, Phone, ArrowUp, ArrowRight, Play, Loader2, LayoutGrid } from "lucide-react";
import { ASSISTANT_PROSE, PixelLoader, ToolGroup, USER_BUBBLE, groupItems } from "@/components/chat/ChatPanel";
import Tooltip from "@/components/ui/Tooltip";
import FlowCanvas from "@/components/studio/FlowCanvas";
import TopPills from "@/components/studio/TopPills";
import FilesModal from "@/components/studio/FilesModal";
import CallWidget from "@/components/call/CallWidget";
import { AgentFlowSchema, type AgentFlow, type FlowNode } from "@/lib/flow";
import { shortBrand } from "@/lib/brand";
import NodeEditor from "@/components/studio/NodeEditor";
import TracePanel, { type TraceEvent } from "@/components/studio/TracePanel";

type ChatItem =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; status: "start" | "done" | "error" };

type Status = {
  onboarding: { agent_id?: string; company?: string; number_status?: string; number?: string; flow_ready?: boolean };
  favicon_url: string | null;
  internet_enabled: boolean;
  allowed_domains: string[];
  userPhone: string | null;
  agent: { id: string; name: string; phone_number: string | null; flow: unknown } | null;
};

export default function Studio() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [flow, setFlow] = useState<AgentFlow | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [docCount, setDocCount] = useState(0);
  const [trying, setTrying] = useState(false);
  const [holdMusicUrl, setHoldMusicUrl] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [editingNode, setEditingNode] = useState<FlowNode | null>(null);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const threadId = useRef("");
  const traceCursor = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 330)}px`;
    el.style.overflowY = el.scrollHeight > 330 ? "auto" : "hidden";
  }
  const agentId = status?.onboarding.agent_id ?? null;

  // Boot + poll until prep (flow + number) lands; keep a slow poll for number status.
  useEffect(() => {
    threadId.current = localStorage.getItem("studioThread") ?? crypto.randomUUID();
    localStorage.setItem("studioThread", threadId.current);
    let live = true;
    const tick = async () => {
      const res = await fetch("/api/onboarding/status");
      if (res.status === 401) return router.push("/login");
      const j: Status = await res.json();
      if (!live) return;
      setStatus(j);
      if (!j.onboarding.agent_id && !j.onboarding.number_status) {
        void fetch("/api/onboarding/prepare", { method: "POST" }).catch(() => {});
      }
      if (j.agent?.flow) {
        const parsed = AgentFlowSchema.safeParse(j.agent.flow);
        if (parsed.success) setFlow(parsed.data);
      }
    };
    tick();
    const iv = setInterval(tick, 2500);
    return () => { live = false; clearInterval(iv); };
  }, [router]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  // Resolve the org's designated hold-music file for browser Try calls.
  useEffect(() => {
    fetch("/api/knowledge")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const doc = j?.documents?.find(
          (d: { kind?: string; meta?: { hold_music?: unknown } }) => d.kind === "media" && d.meta?.hold_music
        );
        setHoldMusicUrl(doc ? `/api/files/${doc.id}/raw` : null);
      })
      .catch(() => {});
  }, [filesOpen]);

  const send = useCallback(async (text: string) => {
    setItems((prev) => [...prev, { kind: "text", role: "user", text }]);
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, threadId: threadId.current, agentId }),
      });
      if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "text") {
            setItems((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === "text" && last.role === "assistant") {
                return [...prev.slice(0, -1), { ...last, text: last.text + ev.delta }];
              }
              return [...prev, { kind: "text", role: "assistant", text: ev.delta }];
            });
          } else if (ev.type === "tool") {
            setItems((prev) => {
              const idx = prev.findLastIndex((p) => p.kind === "tool" && p.name === ev.name && p.status === "start");
              if (ev.status !== "start" && idx >= 0) {
                const copy = [...prev];
                copy[idx] = { kind: "tool", name: ev.name, status: ev.status };
                return copy;
              }
              return [...prev, { kind: "tool", name: ev.name, status: ev.status }];
            });
          } else if (ev.type === "flow") {
            const parsed = AgentFlowSchema.safeParse(ev.flow);
            if (parsed.success) setFlow(parsed.data);
          }
        }
      }
    } catch (e) {
      setItems((prev) => [...prev, { kind: "text", role: "assistant", text: `⚠ ${(e as Error).message}` }]);
    } finally {
      setStreaming(false);
    }
  }, [agentId]);

  // Live trace during Try mode: state + tool events → node highlight + sidebar feed.
  const traceCall = useCallback((callId: string) => {
    traceCursor.current = 0;
    setTraceEvents([]);
    const iv = setInterval(async () => {
      try {
        const res = await fetch(`/api/calls/${callId}/events?after=${traceCursor.current}`);
        if (!res.ok) return;
        const { events } = await res.json();
        const ops: (TraceEvent | { kind: "hold_end" })[] = [];
        for (const e of events as { id: number; type: string; payload: Record<string, unknown> }[]) {
          traceCursor.current = e.id;
          if (e.type === "state") {
            if (e.payload.node) {
              setActiveNode(String(e.payload.node));
              setActiveStep(null);
              ops.push({ kind: "node", node: String(e.payload.node) });
            }
            if (e.payload.step) setActiveStep(String(e.payload.step));
            if (e.payload.hold) ops.push({ kind: "hold", seconds: Number(e.payload.hold) });
            if (e.payload.transfer) ops.push({ kind: "transfer", to: String(e.payload.transfer) });
          } else if (e.type === "tool_call") {
            const args = e.payload.args as Record<string, unknown> | undefined;
            const arg = args?.topic ?? args?.step ?? args?.query ?? args?.seconds ?? args?.table ?? "";
            ops.push({ kind: "tool", name: String(e.payload.name), arg: String(arg).slice(0, 40) });
          } else if (e.type === "hold_start") {
            ops.push({
              kind: "hold",
              until: typeof e.payload.until === "string" ? e.payload.until : undefined,
              seconds: e.payload.seconds ? Number(e.payload.seconds) : undefined,
            });
          } else if (e.type === "hold_end") {
            ops.push({ kind: "hold_end" });
          }
        }
        if (ops.length) {
          setTraceEvents((prev) => {
            let next = prev;
            for (const op of ops) {
              if (op.kind === "hold_end") {
                const i = next.findLastIndex((ev) => ev.kind === "hold" && !ev.ended);
                if (i >= 0) { next = [...next]; next[i] = { ...next[i], ended: true } as TraceEvent; }
              } else {
                next = [...next, op];
              }
            }
            return next;
          });
        }
      } catch { /* keep polling */ }
    }, 1200);
    return () => clearInterval(iv);
  }, []);
  const stopTrace = useRef<(() => void) | null>(null);

  // Review hook: /studio?traceCall=<callId> replays a call's event feed into the trace panel.
  useEffect(() => {
    const callId = new URLSearchParams(window.location.search).get("traceCall");
    if (!callId) return;
    const stop = traceCall(callId);
    return stop;
  }, [traceCall]);

  async function toggleInternet(v: boolean) {
    setStatus((s) => s && { ...s, internet_enabled: v });
    await fetch("/api/settings/internet", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: v }),
    });
  }

  async function addDomain(d: string): Promise<boolean> {
    const res = await fetch("/api/settings/internet", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ add_domain: d }),
    });
    if (res.ok) setStatus((s) => s && { ...s, allowed_domains: [...new Set([...s.allowed_domains, d.toLowerCase()])] });
    return res.ok;
  }

  async function removeDomain(d: string) {
    setStatus((s) => s && { ...s, allowed_domains: s.allowed_domains.filter((x) => x !== d) });
    await fetch("/api/settings/internet", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remove_domain: d }),
    });
  }

  const saveSupportNumber = useCallback(async (n: string): Promise<boolean> => {
    if (!agentId) return false;
    const res = await fetch(`/api/agents/${agentId}/support-number`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: n }),
    });
    if (res.ok) {
      const { support_number } = await res.json();
      setFlow((f) => f && {
        ...f,
        nodes: f.nodes.map((node) => (node.kind === "fallback" ? { ...node, support_number } : node)),
      });
    }
    return res.ok;
  }, [agentId]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const company = status?.onboarding.company;
  const brand = shortBrand(company);

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-5">
        <div className="flex items-center gap-2">
          <Phone size={15} strokeWidth={2.4} />
          <span className="text-sm font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</span>
        </div>
        <div className="flex items-center gap-4">
          <Tooltip content="workspace" placement="bottom">
            <button onClick={() => router.push("/workspace")} className="text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900">
              <LayoutGrid size={15} />
            </button>
          </Tooltip>
          <Tooltip content="log out" placement="bottom">
            <button onClick={logout} className="text-neutral-400 transition-colors duration-[160ms] hover:text-neutral-900">
              <LogOut size={15} />
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-6">
        {/* Flow */}
        <p className="mt-5 shrink-0 text-center text-[13px] text-neutral-500">
          Here&apos;s a starting point for your new agent — edit it with the chat below, or try it out.
        </p>
        <div className="relative mt-3 h-[44vh] shrink-0 overflow-hidden rounded-[24px] border border-neutral-200">
          {status && (
            <TopPills
              enabled={status.internet_enabled}
              domains={status.allowed_domains}
              faviconUrl={status.favicon_url}
              onToggle={toggleInternet}
              onAddDomain={addDomain}
              onRemoveDomain={removeDomain}
              onOpenFiles={() => setFilesOpen(true)}
              docCount={docCount}
            />
          )}
          {flow ? (
            <FlowCanvas
              flow={flow}
              number={status?.agent?.phone_number ?? status?.onboarding.number ?? null}
              numberStatus={status?.onboarding.number_status}
              activeNode={activeNode}
              activeStep={activeStep}
              onSaveSupportNumber={saveSupportNumber}
              onNodeClick={(n) => setEditingNode(n)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-300">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-xs">{brand ? `Designing the ${brand} Agent…` : "Researching your company…"}</span>
            </div>
          )}
          {editingNode && agentId && (
            <NodeEditor
              node={editingNode}
              agentId={agentId}
              onClose={() => setEditingNode(null)}
              onSaveInstructions={async (instructions) => {
                const res = await fetch(`/api/agents/${agentId}/flow-node`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ instructions }),
                });
                return res.ok;
              }}
              onSave={async (patch) => {
                const res = await fetch(`/api/agents/${agentId}/flow-node`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ node: patch }),
                });
                if (res.ok) {
                  const j = await res.json();
                  const parsed = AgentFlowSchema.safeParse(j.flow);
                  if (parsed.success) setFlow(parsed.data);
                }
                return res.ok;
              }}
            />
          )}
          {flow && !trying && (
            <button
              onClick={() => { setTraceEvents([]); setTrying(true); }}
              className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-neutral-950 px-4 py-2 text-[12px] font-medium text-white shadow-lg transition-transform duration-[240ms] hover:scale-[1.03]"
            >
              <Play size={11} fill="currentColor" /> Test
            </button>
          )}
          {(trying || traceEvents.length > 0) && (
            <TracePanel events={traceEvents} live={trying} onClose={() => setTraceEvents([])} />
          )}
        </div>

        {/* Inline chat — flows straight on the page */}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto py-5">
          {groupItems(items as never, streaming).map((g, i) =>
            g.kind === "toolgroup" ? (
              <ToolGroup key={i} items={g.items} live={g.live} />
            ) : g.item.kind === "tool" ? (
              <ToolGroup key={i} items={[g.item]} live />
            ) : g.item.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className={USER_BUBBLE}>{g.item.text}</div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className={ASSISTANT_PROSE}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{g.item.text}</ReactMarkdown>
                </div>
              </div>
            )
          )}
          {streaming && (
            <div className="pl-1 pt-1">
              <PixelLoader />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="flex shrink-0 items-end gap-2 pb-5">
          <div className="relative flex-1 rounded-2xl border border-neutral-200/75 bg-white/70 px-2.5 py-2 transition-[background-color,border-color,box-shadow] duration-[160ms] focus-within:border-neutral-900/25 focus-within:bg-white focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.07)]">
            <div className="flex items-end gap-2">
              <textarea
                rows={1}
                ref={inputRef}
                value={input}
                placeholder={brand ? `Refine the ${brand} Agent` : "Refine your agent"}
                onChange={(e) => { setInput(e.target.value); autoGrow(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim() && !streaming) { send(input.trim()); setInput(""); requestAnimationFrame(() => autoGrow()); }
                  }
                }}
                className="min-w-0 flex-1 resize-none bg-transparent px-1 py-[7px] text-[14px] leading-[1.55] text-neutral-900 outline-none placeholder:text-neutral-400"
              />
              <button
                aria-label="Send"
                onClick={() => { if (input.trim() && !streaming) { send(input.trim()); setInput(""); requestAnimationFrame(() => autoGrow()); } }}
                disabled={!input.trim() || streaming}
                className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-neutral-900 bg-neutral-900 text-white transition duration-[160ms] hover:-translate-y-px hover:bg-neutral-800 disabled:translate-y-0 disabled:opacity-40"
              >
                <ArrowUp size={16} strokeWidth={2.1} />
              </button>
            </div>
          </div>
          <Tooltip content="Open the dashboard">
            <button
              onClick={() => router.push("/workspace")}
              className="inline-flex h-[50px] shrink-0 items-center gap-1.5 rounded-2xl bg-neutral-950 px-4 text-[13px] font-medium text-white transition duration-[160ms] hover:-translate-y-px hover:bg-neutral-800"
            >
              Next <ArrowRight size={14} strokeWidth={2.1} />
            </button>
          </Tooltip>
        </div>
      </div>

      <FilesModal open={filesOpen} onClose={() => setFilesOpen(false)} onCountChange={setDocCount} />

      {trying && agentId && status?.agent && (
        <CallWidget
          agentId={agentId}
          agentName={status.agent.name}
          holdMusicUrl={holdMusicUrl}
          onStarted={(callId) => { stopTrace.current = traceCall(callId); }}
          onEnded={() => {
            setTrying(false);
            stopTrace.current?.();
            setActiveNode(null);
            setActiveStep(null);
            setTraceEvents((p) => (p.length ? [...p, { kind: "ended" }] : p));
          }}
        />
      )}
    </div>
  );
}
