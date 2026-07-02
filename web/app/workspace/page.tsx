// Author: Harsha Gundala
// workspace — platform shell: icon rail, tabbed views, live flow + operator chat column.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpLeft, Home, Layers, LogOut, Phone, Table2, X } from "lucide-react";
import SurfaceView from "@/components/surface/SurfaceView";
import FlowPanel from "@/components/flow/FlowPanel";
import ChatPanel, { type ChatItem } from "@/components/chat/ChatPanel";
import HomeBoard from "@/components/platform/HomeBoard";
import CallsTable, { type CallFocus } from "@/components/platform/CallsTable";
import TablesView from "@/components/platform/TablesView";
import ScreensView from "@/components/platform/ScreensView";
import type { Surface } from "@/lib/surface-dsl";

type Tab = "home" | "calls" | "tables" | "screens";
type FlowLike = {
  nodes: { id: string; label: string; kind?: string }[];
  edges: { from: string; to: string; label?: string }[];
} | null;
type AgentInfo = { id: string; name: string; phone_number: string | null; flow: FlowLike };

const TABS: { id: Tab; icon: typeof Home; title: string }[] = [
  { id: "home", icon: Home, title: "home" },
  { id: "calls", icon: Phone, title: "calls" },
  { id: "tables", icon: Table2, title: "tables" },
  { id: "screens", icon: Layers, title: "screens" },
];

export default function Workspace() {
  const router = useRouter();
  const [tab, setTabState] = useState<Tab>("home");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface | null>(null); // adhoc operator surface
  const [chatFlow, setChatFlow] = useState<FlowLike>(null);     // operator-pushed flow
  const [focus, setFocus] = useState<CallFocus | null>(null);   // expanded call trace
  const [callFlow, setCallFlow] = useState<FlowLike>(null);     // exact version flow of the focused call
  const [expandCallId, setExpandCallId] = useState<string | null>(null);
  const threadId = useRef("");

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    setSurface(null);
    if (t !== "calls") setExpandCallId(null);
    window.history.replaceState(null, "", `?tab=${t}`);
  }, []);

  useEffect(() => {
    threadId.current = localStorage.getItem("threadId") ?? crypto.randomUUID();
    localStorage.setItem("threadId", threadId.current);
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (t && TABS.some((x) => x.id === t)) setTabState(t);
    fetch("/api/workspace")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => setAgents(j.agents ?? []))
      .catch((s) => s === 401 && router.push("/login"));
  }, [router]);

  // Focused call → fetch the exact agent-version flow it ran against.
  const focusCallId = focus?.callId ?? null;
  useEffect(() => {
    if (!focusCallId) { setCallFlow(null); return; }
    let live = true;
    fetch(`/api/calls?call=${focusCallId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.flow) setCallFlow(j.flow); })
      .catch(() => {});
    return () => { live = false; };
  }, [focusCallId]);

  const focusAgentId = focus?.agentId ?? null;
  const send = useCallback(async (text: string) => {
    setItems((prev) => [...prev, { kind: "text", role: "user", text }]);
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, threadId: threadId.current, agentId: focusAgentId ?? agents[0]?.id ?? null }),
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
          } else if (ev.type === "surface") {
            setSurface(ev.surface);
          } else if (ev.type === "flow") {
            setChatFlow(ev.flow);
          } else if (ev.type === "notice") {
            setNotice(ev.text);
            setTimeout(() => setNotice(null), 3500);
          }
        }
      }
    } catch (e) {
      setItems((prev) => [...prev, { kind: "text", role: "assistant", text: `⚠ ${(e as Error).message}` }]);
    } finally {
      setStreaming(false);
    }
  }, [agents, focusAgentId]);

  const onFocus = useCallback((info: CallFocus | null) => setFocus(info), []);
  const openCall = useCallback((id: string) => { setExpandCallId(id); setTab("calls"); }, [setTab]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const panelFlow = focus
    ? callFlow ?? agents.find((a) => a.id === focus.agentId)?.flow ?? null
    : chatFlow ?? agents[0]?.flow ?? null;

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-5">
        <div className="flex items-center gap-2">
          <Phone size={15} strokeWidth={2.4} />
          <span className="text-sm font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</span>
        </div>
        <button onClick={logout} className="text-neutral-400 transition-colors hover:text-neutral-900" title="log out">
          <LogOut size={15} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Icon rail */}
        <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] py-3">
          {TABS.map(({ id, icon: Icon, title }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              title={title}
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                tab === id && !surface ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-900"
              }`}
            >
              <Icon size={15} />
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => router.push("/studio")}
            title="studio"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 transition-colors hover:text-neutral-900"
          >
            <ArrowUpLeft size={15} />
          </button>
          <button
            onClick={logout}
            title="log out"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 transition-colors hover:text-neutral-900"
          >
            <LogOut size={15} />
          </button>
        </nav>

        {/* Main view */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="p-6">
            {surface ? (
              <div>
                <button onClick={() => setSurface(null)} title="close" className="mb-3 text-neutral-300 transition-colors hover:text-neutral-900">
                  <X size={14} />
                </button>
                <SurfaceView surface={surface} send={send} />
              </div>
            ) : tab === "home" ? (
              <HomeBoard agents={agents} onOpenCall={openCall} />
            ) : tab === "calls" ? (
              <CallsTable onFocus={onFocus} expandCallId={expandCallId} />
            ) : tab === "tables" ? (
              <TablesView />
            ) : (
              <ScreensView send={send} />
            )}
          </div>
        </main>

        {/* Right: flow + operator chat */}
        <div className="flex w-[400px] shrink-0 flex-col border-l border-[var(--border)]">
          <div className="h-[38%] shrink-0 border-b border-[var(--border)]">
            <FlowPanel
              flow={panelFlow}
              visited={focus?.visited}
              activeNode={focus?.activeNode}
              holdCountdown={focus?.holdCountdown}
            />
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel items={items} streaming={streaming} onSend={send} />
          </div>
        </div>
      </div>

      {notice && (
        <div className="fixed bottom-5 right-5 z-50 rounded-lg bg-neutral-900 px-4 py-2 text-xs text-white shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}
