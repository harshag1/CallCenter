// Author: Harsha Gundala
// workspace — the shell: header, dynamic surface (left), flow + operator chat (right).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Phone, PhoneCall } from "lucide-react";
import SurfaceView from "@/components/surface/SurfaceView";
import FlowPanel from "@/components/flow/FlowPanel";
import ChatPanel, { type ChatItem } from "@/components/chat/ChatPanel";
import CallWidget from "@/components/call/CallWidget";
import type { Surface, Flow } from "@/lib/surface-dsl";

type AgentInfo = {
  id: string; name: string; purpose: string | null; phone_number: string | null;
  voice: string; flow: Flow; instructions: string;
};
type CallRow = {
  id: string; agent: string; direction: string; status: string;
  started_at: string; duration_s: number | null; sentiment: string | null; summary: string | null;
};

function overviewSurface(agents: AgentInfo[], calls: CallRow[]): Surface {
  return {
    title: "Overview",
    blocks: [
      {
        kind: "stat_row",
        stats: [
          { label: "bots", value: String(agents.length) },
          { label: "calls", value: String(calls.length) },
          {
            label: "avg duration",
            value: calls.length
              ? `${Math.round(calls.reduce((a, c) => a + (c.duration_s ?? 0), 0) / calls.length)}s`
              : "—",
          },
        ],
      },
      {
        kind: "table",
        columns: [
          { key: "agent", label: "bot" },
          { key: "direction", label: "dir" },
          { key: "started_at", label: "when" },
          { key: "duration_s", label: "sec" },
          { key: "sentiment", label: "sentiment" },
          { key: "summary", label: "summary" },
        ],
        rows: calls.map((c) => ({ ...c, started_at: new Date(c.started_at).toLocaleString(), summary: c.summary?.slice(0, 80) })),
        rowAction: { prompt: "Show me call {{id}} in full detail — transcript, tools used, recording, and the path it took through the flow." },
      },
    ],
  };
}

export default function Workspace() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<AgentInfo | null>(null);
  const threadId = useRef<string>("");

  useEffect(() => {
    threadId.current = localStorage.getItem("threadId") ?? crypto.randomUUID();
    localStorage.setItem("threadId", threadId.current);
    fetch("/api/workspace")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => {
        setAgents(j.agents);
        setSurface(overviewSurface(j.agents, j.calls));
        if (j.agents.length) {
          setFocused(j.agents[0].id);
          setFlow(j.agents[0].flow);
        }
      })
      .catch((s) => s === 401 && router.push("/login"));
  }, [router]);

  const send = useCallback(async (text: string) => {
    setItems((prev) => [...prev, { kind: "text", role: "user", text }]);
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, threadId: threadId.current, agentId: focused }),
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
            setFlow(ev.flow);
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
  }, [focused]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const focusedAgent = agents.find((a) => a.id === focused);

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
        {/* Left: dynamic surface */}
        <div className="flex min-w-0 flex-[2] flex-col border-r border-[var(--border)]">
          <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-4">
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => { setFocused(a.id); setFlow(a.flow); }}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  a.id === focused ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100"
                }`}
              >
                {a.name}
              </button>
            ))}
            <div className="flex-1" />
            {focusedAgent && !activeCall && (
              <button
                onClick={() => setActiveCall(focusedAgent)}
                className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-700 transition-colors hover:border-emerald-500 hover:text-emerald-600"
              >
                <PhoneCall size={11} /> test call
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {surface && <SurfaceView surface={surface} send={send} />}
          </div>
        </div>

        {/* Right: flow + operator chat */}
        <div className="flex w-[420px] shrink-0 flex-col">
          <div className="h-[38%] shrink-0 border-b border-[var(--border)]">
            <FlowPanel flow={flow} />
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
      {activeCall && (
        <CallWidget
          agentId={activeCall.id}
          agentName={activeCall.name}
          onEnded={(callId) => {
            setActiveCall(null);
            if (callId) send(`The test call ${callId} just ended — show me how it went.`);
          }}
        />
      )}
    </div>
  );
}
