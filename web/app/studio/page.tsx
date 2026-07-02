// Author: Harsha Gundala
// studio — golden onboarding surface: live flow graph, inline operator chat, in-browser Try mode.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { LogOut, Phone, ArrowUp, Play, Wrench, Check, X, Loader2, LayoutGrid } from "lucide-react";
import FlowCanvas from "@/components/studio/FlowCanvas";
import TopPills from "@/components/studio/TopPills";
import FilesModal from "@/components/studio/FilesModal";
import CallWidget from "@/components/call/CallWidget";
import { AgentFlowSchema, type AgentFlow } from "@/lib/flow";

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

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-5">
        <div className="flex items-center gap-2">
          <Phone size={15} strokeWidth={2.4} />
          <span className="text-sm font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</span>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => router.push("/workspace")} className="text-neutral-300 transition-colors hover:text-neutral-900" title="workspace">
            <LayoutGrid size={15} />
          </button>
          <button onClick={logout} className="text-neutral-400 transition-colors hover:text-neutral-900" title="log out">
            <LogOut size={15} />
          </button>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-6">
        {/* Flow */}
        <div className="relative mt-4 h-[46vh] shrink-0 overflow-hidden rounded-[24px] border border-neutral-100">
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
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-300">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-xs">{company ? `designing ${company}'s agent…` : "researching your company…"}</span>
            </div>
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
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto py-5">
          {!items.length && (
            <p className="pt-2 text-center text-[12px] text-neutral-300">
              ask for changes — topics, steps, tone, tools — and watch the flow update
            </p>
          )}
          {items.map((item, i) =>
            item.kind === "trace" ? (
              <div key={i} className="flex items-center gap-2 pl-1 font-mono text-[11px] text-neutral-400">
                <span className="h-1 w-1 rounded-full bg-emerald-400" /> {item.text}
              </div>
            ) : item.kind === "tool" ? (
              <div key={i} className="flex items-center gap-1.5 pl-1 font-mono text-[11px] text-neutral-400">
                {item.status === "start" ? <Wrench size={11} className="animate-pulse" /> : item.status === "done" ? <Check size={11} className="text-emerald-500" /> : <X size={11} className="text-red-400" />}
                {item.name}
              </div>
            ) : item.role === "user" ? (
              <div key={i} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-neutral-100 px-3.5 py-2 text-[13.5px]">
                {item.text}
              </div>
            ) : (
              <div key={i} className="max-w-[92%] text-[13.5px] leading-relaxed text-neutral-800 [&_p]:mb-1.5">
                <ReactMarkdown>{item.text}</ReactMarkdown>
              </div>
            )
          )}
          {streaming && <div className="pl-1 text-xs text-neutral-300">…</div>}
        </div>

        {/* Input */}
        <div className="shrink-0 pb-5">
          <div className="flex items-end gap-2 rounded-[18px] border border-neutral-200 px-4 py-2.5 focus-within:border-neutral-400">
            <textarea
              rows={1}
              value={input}
              placeholder={company ? `refine ${company}'s agent` : "refine your agent"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim() && !streaming) { send(input.trim()); setInput(""); }
                }
              }}
              className="max-h-32 flex-1 resize-none bg-transparent text-[13.5px] outline-none placeholder:text-neutral-300"
            />
            <button
              onClick={() => { if (input.trim() && !streaming) { send(input.trim()); setInput(""); } }}
              disabled={!input.trim() || streaming}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-white disabled:opacity-20"
            >
              <ArrowUp size={13} />
            </button>
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
