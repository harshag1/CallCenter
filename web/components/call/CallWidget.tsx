// Author: Harsha Gundala
// CallWidget.tsx — live in-browser call bar: status, rolling caption, hang up.

"use client";

import { useEffect, useRef, useState } from "react";
import { PhoneOff, Mic } from "lucide-react";
import { RealtimeCall } from "./realtime";

export default function CallWidget({
  agentId, agentName, onEnded,
}: { agentId: string; agentName: string; onEnded: (callId: string) => void }) {
  const [state, setState] = useState<"connecting" | "live" | "ended" | "error">("connecting");
  const [caption, setCaption] = useState("");
  const callRef = useRef<RealtimeCall | null>(null);

  useEffect(() => {
    const call = new RealtimeCall({
      onState: setState,
      onTranscript: (who, text) => setCaption(`${who === "caller" ? "you" : agentName}: ${text}`),
    });
    callRef.current = call;
    call.start(agentId).catch(() => setState("error"));
    return () => { void call.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function hangUp() {
    const id = callRef.current?.callId ?? "";
    await callRef.current?.stop();
    onEnded(id);
  }

  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex w-[540px] -translate-x-1/2 items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
      <span className={`relative flex h-2.5 w-2.5 ${state === "live" ? "" : "opacity-40"}`}>
        {state === "live" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${state === "live" ? "bg-emerald-500" : state === "error" ? "bg-red-400" : "bg-neutral-300"}`} />
      </span>
      <Mic size={14} className="text-neutral-400" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{agentName}</div>
        <div className="truncate text-[11px] text-neutral-400">
          {state === "connecting" ? "connecting…" : state === "error" ? "connection failed" : caption || "listening…"}
        </div>
      </div>
      <button onClick={hangUp} className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white transition-transform hover:scale-105">
        <PhoneOff size={14} />
      </button>
    </div>
  );
}
