// Author: Harsha Gundala
// workspace — platform shell: icon rail, tabbed views, live flow + operator chat column.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpLeft, CalendarClock, FlaskConical, Home, Layers, LogOut, Phone, Play, Table2, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import CallWidget from "@/components/call/CallWidget";
import SurfaceView from "@/components/surface/SurfaceView";
import FlowPanel, { type ExperimentBadge } from "@/components/flow/FlowPanel";
import FlowPicker from "@/components/flow/FlowPicker";
import ChatPanel, { type ChatItem } from "@/components/chat/ChatPanel";
import {
  operatorActionConfirmationFromWire,
  type OperatorActionApprovalStatus,
  withOperatorActionApprovalStatus,
} from "@/components/chat/OperatorActionApprovalCard";
import HomeBoard from "@/components/platform/HomeBoard";
import CallsTable, { type CallFocus } from "@/components/platform/CallsTable";
import TablesView from "@/components/platform/TablesView";
import ScreensView, { type Screen } from "@/components/platform/ScreensView";
import ScheduledView from "@/components/platform/ScheduledView";
import OrgPills from "@/components/studio/OrgPills";
import FilesModal from "@/components/studio/FilesModal";
import NodeEditor from "@/components/studio/NodeEditor";
import type { FlowNode } from "@/lib/flow";
import { useScheduled } from "@/components/hooks/useScheduled";
import { PRODUCT_NAME } from "@/lib/product";
import { useOrgSettings } from "@/components/hooks/useOrgSettings";
import type { Surface } from "@/lib/surface-dsl";

type Tab = "home" | "calls" | "tables" | "screens" | "experiments" | "scheduled";
type FlowLike = {
  nodes: { id: string; label: string; kind?: string }[];
  edges: { from: string; to: string; label?: string }[];
} | null;
type AgentInfo = { id: string; name: string; phone_number: string | null; flow: FlowLike };
type FlowEntry = { id: string; label: string; kind?: string; flow: FlowLike; agentId?: string | null; instructions?: string | null };
type ExperimentInfo = { id: string; agent_id: string; name: string; status: string; screen_id: string | null };

const ALL_TABS: Tab[] = ["home", "calls", "tables", "screens", "experiments", "scheduled"];
const BASE_TABS: { id: Tab; icon: typeof Home; title: string }[] = [
  { id: "home", icon: Home, title: "home" },
  { id: "calls", icon: Phone, title: "calls" },
  { id: "tables", icon: Table2, title: "tables" },
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
  const [screens, setScreens] = useState<Screen[]>([]);
  const [screenId, setScreenId] = useState<string | null>(null); // deep-linked screen within screens/experiments tab
  const [experiments, setExperiments] = useState<ExperimentInfo[]>([]);
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
    setScreenId(null);
    if (t !== "calls") setExpandCallId(null);
    window.history.replaceState(null, "", `?tab=${t}`);
  }, []);

  /** Jump straight to a screen/experiment page (navigate events, flow badge, deep links). */
  const openScreen = useCallback((t: "screens" | "experiments", id: string) => {
    setSurface(null);
    setTabState(t);
    setScreenId(id);
    setExpandCallId(null);
    window.history.replaceState(null, "", `?tab=${t}&screen=${id}`);
  }, []);

  const syncScreenUrl = useCallback((id: string | null) => {
    setScreenId(id);
    const t = new URLSearchParams(window.location.search).get("tab") ?? "screens";
    window.history.replaceState(null, "", id ? `?tab=${t}&screen=${id}` : `?tab=${t}`);
  }, []);

  const loadScreens = useCallback(() => {
    fetch("/api/screens")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setScreens(Array.isArray(j) ? j : j.screens ?? []))
      .catch(() => {});
    fetch("/api/experiments")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.experiments && setExperiments(j.experiments))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadScreens();
    const iv = setInterval(loadScreens, 12_000);
    return () => clearInterval(iv);
  }, [loadScreens]);

  useEffect(() => {
    threadId.current = localStorage.getItem("threadId") ?? crypto.randomUUID();
    localStorage.setItem("threadId", threadId.current);
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab") as Tab | null;
    if (t && ALL_TABS.includes(t)) setTabState(t);
    const s = params.get("screen");
    if (s) setScreenId(s);
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
      .then((j: { flows?: { id: string; agent_id?: string; name: string; kind?: string; flow: FlowLike; instructions?: string | null }[] } | null) => {
        if (!live || !j?.flows) return;
        const list = j.flows.map((f) => ({ id: f.id, label: f.name, kind: f.kind, flow: f.flow, agentId: f.agent_id ?? null, instructions: f.instructions ?? null }));
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
  const updateOperatorActionStatus = useCallback((proposalId: string, status: OperatorActionApprovalStatus) => {
    setItems((prev) => prev.map((item) =>
      item.kind === "operator_action_confirmation"
        ? withOperatorActionApprovalStatus(item, proposalId, status)
        : item
    ));
  }, []);

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
      let navigated = false; // once a tool navigates, later surfaces in this reply must not cover the destination
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
          } else if (ev.type === "operator_action_confirmation") {
            const confirmation = operatorActionConfirmationFromWire(ev.proposal);
            if (confirmation) {
              setItems((prev) => prev.some((item) =>
                item.kind === "operator_action_confirmation" && item.proposalId === confirmation.proposalId
              ) ? prev : [...prev, confirmation]);
            }
          } else if (ev.type === "surface") {
            if (!navigated) setSurface(ev.surface);
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
          } else if (ev.type === "navigate") {
            // Tool created something screen-shaped — land the user on it.
            navigated = true;
            const t: "screens" | "experiments" = ev.tab === "experiments" ? "experiments" : "screens";
            if (ev.screenId) openScreen(t, ev.screenId);
            else setTab(t);
            loadScreens();
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
  }, [agents, focusAgentId, openFlow, openScreen, setTab, loadScreens]);

  const onFocus = useCallback((info: CallFocus | null) => setFocus(info), []);
  const openCall = useCallback((id: string) => { setExpandCallId(id); setTabState("calls"); setSurface(null); setScreenId(null); window.history.replaceState(null, "", "?tab=calls"); }, []);

  // In-canvas test call of the open flow: node highlighting only (captions live in the CallWidget).
  const [testing, setTesting] = useState(false);
  const [showLiveTestConfirm, setShowLiveTestConfirm] = useState(false);
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

  // Running A/B test on the agent behind the visible flow → violet badge node in the graph.
  const panelAgentId =
    focusAgentId
    ?? openFlow?.agentId
    ?? (openFlow?.id.startsWith("inbound:") ? openFlow.id.slice("inbound:".length) : null)
    ?? agents[0]?.id
    ?? null;
  const runningExp = experiments.find((e) => e.status === "running" && e.agent_id === panelAgentId);
  const panelExperiment: ExperimentBadge | null = runningExp
    ? { id: runningExp.id, name: runningExp.name, screenId: runningExp.screen_id }
    : null;
  const onOpenExperiment = useCallback((exp: ExperimentBadge) => {
    if (exp.screenId) openScreen("experiments", exp.screenId);
  }, [openScreen]);

  // Click-to-edit flow nodes (live views only — a focused call shows a historical version).
  const [editNode, setEditNode] = useState<FlowNode | null>(null);
  const handleNodeClick = useCallback((n: { id: string; label: string; kind?: string }) => {
    if (focus) return;
    setEditNode(n as FlowNode);
  }, [focus]);
  useEffect(() => { setEditNode(null); }, [openFlow?.id, focusCallId]); // context switch closes the editor

  const saveNode = useCallback(async (patch: FlowNode): Promise<boolean> => {
    const inbound = !openFlow || openFlow.id.startsWith("inbound:");
    const url = inbound
      ? `/api/agents/${openFlow?.agentId ?? openFlow?.id.slice("inbound:".length) ?? agents[0]?.id}/flow-node`
      : `/api/flows/${openFlow.id}`;
    try {
      const r = await fetch(url, {
        method: inbound ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node: patch }),
      });
      if (!r.ok) return false;
      const j = await r.json() as { flow?: FlowLike };
      if (j.flow) {
        const flow = j.flow;
        const openId = openFlow?.id;
        setOpenFlow((prev) => (prev ? { ...prev, flow } : prev));
        if (openId) setFlows((prev) => prev.map((f) => (f.id === openId ? { ...f, flow } : f)));
        if (inbound) {
          const agentId = openFlow?.agentId ?? openFlow?.id.slice("inbound:".length) ?? agents[0]?.id;
          setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, flow } : a)));
        }
      }
      return true;
    } catch {
      return false;
    }
  }, [openFlow, agents]);

  const plainScreenCount = screens.filter((s) => s.kind !== "experiment").length;
  const experimentScreenCount = screens.filter((s) => s.kind === "experiment").length;
  const railTabs: { id: Tab; icon: typeof Home; title: string }[] = [
    ...BASE_TABS,
    ...(plainScreenCount > 0 || tab === "screens" ? [{ id: "screens" as Tab, icon: Layers, title: "screens" }] : []),
    ...(experimentScreenCount > 0 || tab === "experiments" ? [{ id: "experiments" as Tab, icon: FlaskConical, title: "experiments" }] : []),
  ];

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-5">
        <div className="flex items-center gap-2">
          <Phone size={15} strokeWidth={2.4} />
          <span className="text-sm font-semibold tracking-tight">{PRODUCT_NAME}</span>
        </div>
        <Tooltip content="log out" placement="bottom">
          <button aria-label="Log out" onClick={logout} className="text-neutral-400 transition-colors duration-[160ms] hover:text-neutral-900">
            <LogOut size={15} />
          </button>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Icon rail */}
        <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] py-3">
          {railTabs.map(({ id, icon: Icon, title }) => (
            <Tooltip key={id} content={title} placement="right">
              <button
                aria-label={title}
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
                aria-label="Scheduled"
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
              aria-label="Open Studio"
              onClick={() => router.push("/studio")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900"
            >
              <ArrowUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip content="log out" placement="right">
            <button
              aria-label="Log out"
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
                  <button aria-label="Close" onClick={() => setSurface(null)} className="text-neutral-300 transition-colors duration-[160ms] hover:text-neutral-900">
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
              <ScreensView
                send={send}
                screens={screens}
                kind={tab === "experiments" ? "experiment" : "screen"}
                openScreenId={screenId}
                onScreenChange={syncScreenUrl}
                onOpenCall={openCall}
                reload={loadScreens}
              />
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
              outbound={!focus && openFlow?.kind === "outbound"}
              experiment={panelExperiment}
              onOpenExperiment={onOpenExperiment}
              onNodeClick={focus ? undefined : handleNodeClick}
            />
            {editNode && !focus && (
              <NodeEditor
                node={editNode}
                agentId={
                  !openFlow || openFlow.id.startsWith("inbound:")
                    ? openFlow?.agentId ?? openFlow?.id.slice("inbound:".length) ?? agents[0]?.id ?? null
                    : null
                }
                flowInstructions={
                  openFlow && !openFlow.id.startsWith("inbound:") ? openFlow.instructions ?? "" : null
                }
                onSave={saveNode}
                onSaveInstructions={async (instructions) => {
                  const agentId = openFlow?.agentId ?? openFlow?.id.slice("inbound:".length) ?? agents[0]?.id;
                  if (!agentId) return false;
                  const r = await fetch(`/api/agents/${agentId}/flow-node`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ instructions }),
                  });
                  return r.ok;
                }}
                onClose={() => setEditNode(null)}
              />
            )}
            {!focus && !testing && !showLiveTestConfirm && panelFlow && testTarget && (
              <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
                <Tooltip content="Test" placement="top">
                  <button
                    aria-label="Test agent"
                    onClick={() => setShowLiveTestConfirm(true)}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-950 text-white shadow-lg transition-transform duration-[240ms] hover:scale-[1.04]"
                  >
                    <Play size={12} fill="currentColor" />
                  </button>
                </Tooltip>
              </div>
            )}
            {showLiveTestConfirm && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Confirm live provider test"
                className="absolute bottom-3 left-1/2 z-20 w-[min(92%,390px)] -translate-x-1/2 rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl"
              >
                <p className="text-[11px] leading-4 text-neutral-500">Microphone · provider credits</p>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    onClick={() => setShowLiveTestConfirm(false)}
                    className="rounded-full px-3 py-1.5 text-[11px] font-medium text-neutral-600 hover:bg-neutral-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setShowLiveTestConfirm(false);
                      setTesting(true);
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-neutral-950 px-3.5 py-1.5 text-[11px] font-medium text-white hover:bg-neutral-800"
                  >
                    <Play size={10} fill="currentColor" /> Start
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel
              items={items}
              streaming={streaming}
              onSend={send}
              onOperatorActionStatusChange={updateOperatorActionStatus}
            />
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
