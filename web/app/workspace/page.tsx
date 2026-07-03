// Author: Harsha Gundala
// workspace — platform shell: icon rail, tabbed views, live flow + operator chat column.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpLeft, CalendarClock, Home, Layers, LogOut, Phone, Play, Table2, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import CallWidget from "@/components/call/CallWidget";
import SurfaceView from "@/components/surface/SurfaceView";
import FlowPanel from "@/components/flow/FlowPanel";
import FlowPicker from "@/components/flow/FlowPicker";
import ChatPanel, { type ChatItem } from "@/components/chat/ChatPanel";
import HomeBoard from "@/components/platform/HomeBoard";
import CallsTable, { type CallFocus } from "@/components/platform/CallsTable";
import TablesView from "@/components/platform/TablesView";
import ScreensView from "@/components/platform/ScreensView";
import ScheduledView from "@/components/platform/ScheduledView";
import OrgPills from "@/components/studio/OrgPills";
import FilesModal from "@/components/studio/FilesModal";
import { useScheduled } from "@/components/hooks/useScheduled";
import { useOrgSettings } from "@/components/hooks/useOrgSettings";
import type { Surface } from "@/lib/surface-dsl";

type Tab = "home" | "calls" | "tables" | "screens" | "scheduled";
type FlowLike = {
  nodes: { id: string; label: string; kind?: string }[];
  edges: { from: string; to: string; label?: string }[];
} | null;
type AgentInfo = { id: string; name: string; phone_number: string | null; flow: FlowLike };
type FlowEntry = { id: string; label: string; kind?: string; flow: FlowLike; agentId?: string | null };

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
  const [flows, setFlows] = useState<FlowEntry[]>([]);          // named flows for the flow picker
  const [openFlow, setOpenFlow] = useState<FlowEntry | null>(null); // picker selection (chat can switch it)
  const [focus, setFocus] = useState<CallFocus | null>(null);   // expanded call trace
  const [callFlow, setCallFlow] = useState<FlowLike>(null);     // exact version flow of the focused call
  const [expandCallId, setExpandCallId] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [sidebarW, setSidebarW] = useState(420);
  const threadId = useRef("");
  const { scheduled, campaigns, reload: reloadScheduled, hasPending } = useScheduled();
  const org = useOrgSettings();

  useEffect(() => {
    const w = Number(localStorage.getItem("sidebarW"));
    if (w >= 320 && w <= 680) setSidebarW(w);
  }, []);

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const clamp = (w: number) => Math.min(680, Math.max(320, w));
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => setSidebarW(clamp(startW + startX - ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      localStorage.setItem("sidebarW", String(clamp(startW + startX - ev.clientX)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [sidebarW]);

  const resetSidebar = useCallback(() => {
    setSidebarW(420);
    localStorage.setItem("sidebarW", "420");
  }, []);

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
    if (t && (TABS.some((x) => x.id === t) || t === "scheduled")) setTabState(t);
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

  // Named flows for the picker: inbound default first, then outbound flows.
  const primaryAgentId = agents[0]?.id ?? null;
  useEffect(() => {
    if (!primaryAgentId) return;
    let live = true;
    fetch(`/api/flows?agentId=${primaryAgentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { flows?: { id: string; agent_id?: string; name: string; kind?: string; flow: FlowLike }[] } | null) => {
        if (!live || !j?.flows) return;
        const list = j.flows.map((f) => ({ id: f.id, label: f.name, kind: f.kind, flow: f.flow, agentId: f.agent_id ?? null }));
        setFlows(list);
        setOpenFlow((prev) => prev ?? list[0] ?? null);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [primaryAgentId]);

  const selectFlow = useCallback((id: string) => {
    const f = flows.find((x) => x.id === id);
    if (f) setOpenFlow(f);
  }, [flows]);

  const focusAgentId = focus?.agentId ?? null;
  const send = useCallback(async (text: string) => {
    setItems((prev) => [...prev, { kind: "text", role: "user", text }]);
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          threadId: threadId.current,
          agentId: focusAgentId ?? agents[0]?.id ?? null,
          openFlow: openFlow ? { id: openFlow.id, label: openFlow.label } : null,
        }),
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
            const meta = ev.flowMeta as { id: string; label: string } | undefined;
            if (meta) {
              // Operator opened/updated a named flow → switch the picker to it (adding if new).
              const entry: FlowEntry = {
                id: meta.id,
                label: meta.label,
                kind: meta.id.startsWith("inbound:") ? "inbound" : "outbound",
                flow: ev.flow,
                agentId: meta.id.startsWith("inbound:") ? meta.id.slice("inbound:".length) : null,
              };
              setFlows((prev) =>
                prev.some((f) => f.id === entry.id)
                  ? prev.map((f) => (f.id === entry.id ? entry : f))
                  : [...prev, entry]
              );
              setOpenFlow(entry);
            } else {
              setOpenFlow({ id: "adhoc", label: "operator flow", flow: ev.flow });
            }
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
  }, [agents, focusAgentId, openFlow]);

  const onFocus = useCallback((info: CallFocus | null) => setFocus(info), []);
  const openCall = useCallback((id: string) => { setExpandCallId(id); setTab("calls"); }, [setTab]);

  // In-canvas test call of the open flow: node highlighting only (captions live in the CallWidget).
  const [testing, setTesting] = useState(false);
  const [testNode, setTestNode] = useState<string | null>(null);
  const testCursor = useRef(0);
  const testPoll = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTestTrace = useCallback((callId: string) => {
    testCursor.current = 0;
    testPoll.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/calls/${callId}/events?after=${testCursor.current}`);
        if (!res.ok) return;
        const { events } = await res.json();
        for (const e of events as { id: number; type: string; payload: Record<string, unknown> }[]) {
          testCursor.current = e.id;
          if (e.type === "state" && e.payload.node) setTestNode(String(e.payload.node));
        }
      } catch { /* keep polling */ }
    }, 1200);
  }, []);

  const endTest = useCallback(() => {
    if (testPoll.current) clearInterval(testPoll.current);
    testPoll.current = null;
    setTesting(false);
    setTestNode(null);
  }, []);

  // Outbound flows carry their own id; 'inbound:<agentId>' entries test the agent's default flow.
  const testTarget = (() => {
    const fallback = agents[0] ? { agentId: agents[0].id, flowId: null as string | null } : null;
    if (!openFlow) return fallback;
    if (openFlow.id.startsWith("inbound:")) {
      return { agentId: openFlow.agentId ?? openFlow.id.slice("inbound:".length), flowId: null };
    }
    return openFlow.agentId ? { agentId: openFlow.agentId, flowId: openFlow.id } : fallback;
  })();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const panelFlow = focus
    ? callFlow ?? agents.find((a) => a.id === focus.agentId)?.flow ?? null
    : openFlow?.flow ?? agents[0]?.flow ?? null;
  const panelNumber = focus
    ? agents.find((a) => a.id === focus.agentId)?.phone_number ?? null
    : agents[0]?.phone_number ?? null;

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-5">
        <div className="flex items-center gap-2">
          <Phone size={15} strokeWidth={2.4} />
          <span className="text-sm font-semibold tracking-tight">Harsha&apos;s Amazing Call Center</span>
        </div>
        <Tooltip content="log out" placement="bottom">
          <button onClick={logout} className="text-neutral-400 transition-colors duration-[160ms] hover:text-neutral-900">
            <LogOut size={15} />
          </button>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Icon rail */}
        <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] py-3">
          {TABS.map(({ id, icon: Icon, title }) => (
            <Tooltip key={id} content={title} placement="right">
              <button
                onClick={() => setTab(id)}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-[160ms] ${
                  tab === id && !surface ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-900"
                }`}
              >
                <Icon size={15} />
              </button>
            </Tooltip>
          ))}
          {(hasPending || tab === "scheduled") && (
            <Tooltip content="scheduled" placement="right">
              <button
                onClick={() => setTab("scheduled")}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-[160ms] ${
                  tab === "scheduled" && !surface ? "bg-neutral-100 text-neutral-900" : "text-neutral-400 hover:text-neutral-900"
                }`}
              >
                <CalendarClock size={15} />
              </button>
            </Tooltip>
          )}
          <div className="flex-1" />
          <Tooltip content="studio" placement="right">
            <button
              onClick={() => router.push("/studio")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900"
            >
              <ArrowUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip content="log out" placement="right">
            <button
              onClick={logout}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900"
            >
              <LogOut size={15} />
            </button>
          </Tooltip>
        </nav>

        {/* Main view */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="p-6">
            {surface ? (
              <div>
                <Tooltip content="close" placement="right" className="mb-3">
                  <button onClick={() => setSurface(null)} className="text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900">
                    <X size={14} />
                  </button>
                </Tooltip>
                <SurfaceView surface={surface} send={send} />
              </div>
            ) : tab === "home" ? (
              <HomeBoard agents={agents} onOpenCall={openCall} />
            ) : tab === "calls" ? (
              <CallsTable onFocus={onFocus} expandCallId={expandCallId} />
            ) : tab === "tables" ? (
              <TablesView />
            ) : tab === "scheduled" ? (
              <ScheduledView scheduled={scheduled} campaigns={campaigns} reload={reloadScheduled} />
            ) : (
              <ScreensView send={send} />
            )}
          </div>
        </main>

        {/* Right: flow + operator chat (drag left edge to resize) */}
        <div style={{ width: sidebarW }} className="relative flex shrink-0 flex-col border-l border-[var(--border)]">
          <div
            onPointerDown={startResize}
            onDoubleClick={resetSidebar}
            className="group absolute inset-y-0 left-0 z-20 w-[3px] cursor-col-resize hover:bg-neutral-200"
          >
            <span className="absolute -left-px top-1/2 hidden h-9 w-[5px] -translate-y-1/2 rounded-full bg-neutral-300 group-hover:block" />
          </div>
          <div className="relative h-[38%] shrink-0 border-b border-[var(--border)]">
            {!focus && (
              <div className="absolute left-3 top-3 z-10 flex items-center gap-3">
                {flows.length > 0 && (
                  <FlowPicker
                    options={flows.map(({ id, label, kind }) => ({ id, label, kind }))}
                    selectedId={openFlow?.id ?? null}
                    label={openFlow?.label ?? flows[0].label}
                    onSelect={selectFlow}
                  />
                )}
                {org.loaded && (
                  <div className="flex items-center gap-1.5">
                    <OrgPills
                      compact
                      enabled={org.enabled}
                      domains={org.domains}
                      faviconUrl={org.faviconUrl}
                      onToggle={org.toggle}
                      onAddDomain={org.addDomain}
                      onRemoveDomain={org.removeDomain}
                      onOpenFiles={() => setFilesOpen(true)}
                      docCount={org.docCount}
                    />
                  </div>
                )}
              </div>
            )}
            <FlowPanel
              flow={panelFlow}
              number={panelNumber}
              visited={focus?.visited}
              activeNode={focus?.activeNode ?? testNode}
              holdCountdown={focus?.holdCountdown}
            />
            {!focus && !testing && panelFlow && testTarget && (
              <button
                onClick={() => setTesting(true)}
                className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-neutral-950 px-4 py-2 text-[12px] font-medium text-white shadow-lg transition-transform duration-[240ms] hover:scale-[1.03]"
              >
                <Play size={11} fill="currentColor" /> Test
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel items={items} streaming={streaming} onSend={send} />
          </div>
        </div>
      </div>

      <FilesModal open={filesOpen} onClose={() => setFilesOpen(false)} onCountChange={org.setDocCount} />

      {testing && testTarget && (
        <CallWidget
          agentId={testTarget.agentId}
          agentName={agents.find((a) => a.id === testTarget.agentId)?.name ?? openFlow?.label ?? "agent"}
          flowId={testTarget.flowId}
          onStarted={startTestTrace}
          onEnded={endTest}
        />
      )}

      {notice && (
        <div className="fixed bottom-5 right-5 z-50 rounded-lg bg-neutral-900 px-4 py-2 text-xs text-white shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}
