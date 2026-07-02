// Author: Harsha Gundala
// studio — golden onboarding surface: live flow graph, inline operator chat, in-browser Try mode.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LogOut, Phone, ArrowUp, Play, Loader2, LayoutGrid } from "lucide-react";
import { ASSISTANT_PROSE, PixelLoader, ToolLine, USER_BUBBLE } from "@/components/chat/ChatPanel";
import Tooltip from "@/components/ui/Tooltip";
import FlowCanvas from "@/components/studio/FlowCanvas";
import TopPills from "@/components/studio/TopPills";
import FilesModal from "@/components/studio/FilesModal";
import CallWidget from "@/components/call/CallWidget";
import { AgentFlowSchema, type AgentFlow, type FlowNode } from "@/lib/flow";
import { shortBrand } from "@/lib/brand";
import NodeEditor from "@/components/studio/NodeEditor";

type ChatItem =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; status: "start" | "done" | "error" }
  | { kind: "trace"; text: string };

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
  const [editingNode, setEditingNode] = useState<FlowNode | null>(null);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const threadId = useRef("");
  const traceCursor = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Live trace during Try mode: state + tool events → node highlight + feed lines.
  const traceCall = useCallback((callId: string) => {
    traceCursor.current = 0;
    const iv = setInterval(async () => {
      try {
        const res = await fetch(`/api/calls/${callId}/events?after=${traceCursor.current}`);
        if (!res.ok) return;
        const { events } = await res.json();
        for (const e of events as { id: number; type: string; payload: Record<string, unknown> }[]) {
          traceCursor.current = e.id;
          if (e.type === "state") {
            if (e.payload.node) { setActiveNode(String(e.payload.node)); setActiveStep(null); }
            if (e.payload.step) setActiveStep(String(e.payload.step));
            if (e.payload.hold) setItems((p) => [...p, { kind: "trace", text: `on hold ${e.payload.hold}s` }]);
            if (e.payload.transfer) setItems((p) => [...p, { kind: "trace", text: `→ transfer ${e.payload.transfer}` }]);
          } else if (e.type === "tool_call") {
            const name = String(e.payload.name);
            const args = e.payload.args as Record<string, unknown>;
            const arg = args?.topic ?? args?.step ?? args?.query ?? args?.seconds ?? "";
            setItems((p) => [...p, { kind: "trace", text: `${name}(${String(arg).slice(0, 40)})` }]);
          }
        }
      } catch { /* keep polling */ }
    }, 1200);
    return () => clearInterval(iv);
  }, []);
  const stopTrace = useRef<(() => void) | null>(null);

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
              onClose={() => setEditingNode(null)}
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
              onClick={() => setTrying(true)}
              className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-full bg-neutral-950 px-4 py-2 text-[12px] font-medium text-white shadow-lg transition-transform hover:scale-[1.03]"
            >
              <Play size={11} fill="currentColor" /> Try
            </button>
          )}
        </div>

        {/* Inline chat — flows straight on the page */}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto py-5">
          {items.map((item, i) =>
            item.kind === "trace" ? (
              <div key={i} className="flex items-center gap-2 pl-1 font-mono text-[11px] text-neutral-400">
                <span className="h-1 w-1 rounded-full bg-emerald-400" /> {item.text}
              </div>
            ) : item.kind === "tool" ? (
              <ToolLine key={i} name={item.name} status={item.status} />
            ) : item.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className={USER_BUBBLE}>{item.text}</div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className={ASSISTANT_PROSE}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
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
        <div className="shrink-0 pb-5">
          <div className="relative rounded-2xl border border-neutral-200/75 bg-white/70 px-2.5 py-2 transition-[background-color,border-color,box-shadow] duration-[160ms] focus-within:border-neutral-900/25 focus-within:bg-white focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.07)]">
            <div className="flex items-end gap-2">
              <textarea
                rows={1}
                value={input}
                placeholder={brand ? `Refine the ${brand} Agent` : "Refine your agent"}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim() && !streaming) { send(input.trim()); setInput(""); }
                  }
                }}
                className="max-h-32 min-w-0 flex-1 resize-none bg-transparent px-1 py-[7px] text-[14px] leading-[1.55] text-neutral-900 outline-none placeholder:text-neutral-400"
              />
              <button
                aria-label="Send"
                onClick={() => { if (input.trim() && !streaming) { send(input.trim()); setInput(""); } }}
                disabled={!input.trim() || streaming}
                className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-neutral-900 bg-neutral-900 text-white transition duration-[160ms] hover:-translate-y-px hover:bg-neutral-800 disabled:translate-y-0 disabled:opacity-40"
              >
                <ArrowUp size={16} strokeWidth={2.1} />
              </button>
            </div>
          </div>
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
          }}
        />
      )}
    </div>
  );
}
