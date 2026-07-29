// Author: Harsha Gundala
// CallWidget.tsx — live in-browser call bar: status, rolling caption, hold music + countdown, hang up.

"use client";

import { useEffect, useRef, useState } from "react";
import { PhoneOff, Mic } from "lucide-react";
import { RealtimeCall } from "./realtime";
import type { BrowserSpeechGuardrailStatus } from "./browser-speech-guardrail";
import { mmss } from "@/components/platform/shared";

export default function CallWidget({
  agentId, agentName, onEnded, onStarted, holdMusicUrl, flowId,
}: {
  agentId: string;
  agentName: string;
  onEnded: (callId: string) => void;
  onStarted?: (callId: string) => void;
  holdMusicUrl?: string | null;
  flowId?: string | null;
}) {
  const [state, setState] = useState<"connecting" | "live" | "ended" | "error">("connecting");
  const [caption, setCaption] = useState("");
  const [speechGuardrail, setSpeechGuardrail] = useState<BrowserSpeechGuardrailStatus | null>(null);
  const [holdUntil, setHoldUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const callRef = useRef<RealtimeCall | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cursorRef = useRef(0);

  useEffect(() => {
    const call = new RealtimeCall({
      onState: setState,
      onTranscript: (who, text) => setCaption(`${who === "caller" ? "you" : agentName}: ${text}`),
      onSpeechGuardrailStatus: setSpeechGuardrail,
    });
    callRef.current = call;
    let iv: ReturnType<typeof setInterval> | null = null;
    call
      .start(agentId, { flowId })
      .then(() => {
        onStarted?.(call.callId);
        // Lightweight event poll: watch for hold_start/hold_end during the live call.
        iv = setInterval(async () => {
          try {
            const r = await fetch(`/api/calls/${call.callId}/events?after=${cursorRef.current}`);
            if (!r.ok) return;
            const { events } = await r.json();
            for (const e of events as { id: number; type: string; payload: Record<string, unknown> }[]) {
              cursorRef.current = e.id;
              if (e.type === "hold_start") {
                const until = e.payload?.until
                  ? Date.parse(String(e.payload.until))
                  : Date.now() + Number(e.payload?.seconds ?? 0) * 1000;
                setHoldUntil(until);
                setNow(Date.now());
              } else if (e.type === "hold_end") {
                setHoldUntil(null);
              }
            }
          } catch { /* keep polling */ }
        }, 1500);
      })
      .catch(() => setState("error"));
    return () => {
      if (iv) clearInterval(iv);
      void call.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Hold: tick the countdown and loop hold music at half volume until hold_end.
  useEffect(() => {
    const a = audioRef.current;
    if (holdUntil == null) {
      if (a) { a.pause(); a.currentTime = 0; }
      return;
    }
    if (a && holdMusicUrl) {
      a.volume = 0.5;
      void a.play().catch(() => {});
    }
    const iv = setInterval(() => {
      setNow(Date.now());
      // Safety: if hold_end never arrives, clear a few seconds past the deadline.
      if (Date.now() > holdUntil + 5000) setHoldUntil(null);
    }, 500);
    return () => { clearInterval(iv); a?.pause(); };
  }, [holdUntil, holdMusicUrl]);

  async function hangUp() {
    const id = callRef.current?.callId ?? "";
    await callRef.current?.stop();
    onEnded(id);
  }

  const statusLine =
    holdUntil != null
      ? `on hold · ${mmss(holdUntil - now)}`
      : state === "connecting"
        ? "connecting…"
        : state === "error"
          ? "connection failed"
          : caption || "listening…";

  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex w-[540px] -translate-x-1/2 items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
      {holdMusicUrl && <audio ref={audioRef} loop src={holdMusicUrl} className="hidden" />}
      <span className={`relative flex h-2.5 w-2.5 ${state === "live" ? "" : "opacity-40"}`}>
        {state === "live" && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${holdUntil != null ? "bg-amber-400" : "bg-emerald-400"}`} />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${state === "live" ? (holdUntil != null ? "bg-amber-500" : "bg-emerald-500") : state === "error" ? "bg-red-400" : "bg-neutral-300"}`} />
      </span>
      <Mic size={14} className="text-neutral-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <span>{agentName}</span>
          {speechGuardrail?.state === "enforcing" && (
            <span
              className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700"
              title="Generated speech is held until exact-PCM independent ASR policy passes"
            >
              speech guarded
            </span>
          )}
        </div>
        <div className={`truncate text-[11px] ${holdUntil != null ? "tabular-nums text-amber-600" : "text-neutral-400"}`}>
          {statusLine}
        </div>
      </div>
      <button onClick={hangUp} className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white transition-transform hover:scale-105">
        <PhoneOff size={14} />
      </button>
    </div>
  );
}
