// Author: Harsha Gundala
// CallTimeline.tsx — video-editor call track: thin speaker lanes, tool markers on a center rail,
// red playhead driven by the audio element, click-to-seek, scrollable for long calls.

"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Tooltip from "@/components/ui/Tooltip";
import { SPEAKER_COLOR, SPEAKER_LABEL, mmss, type CallEvent, type SpeakerKind } from "./shared";

export type TimelineSeg = { kind: SpeakerKind; startMs: number; endMs: number; text?: string; evId: number };
export type TimelineModel = {
  t0: number;
  totalMs: number;
  segs: TimelineSeg[];
  markers: { atMs: number; name: string }[];
  holds: { startMs: number; endMs: number }[];
};

const HUMAN_CPS = 15; // estimated speech rate for human_segment duration
const MIN_PX_PER_S = 8;
const MAX_PX_PER_S = 14;
const HOLD_BG = "repeating-linear-gradient(45deg, rgba(245,158,11,0.28) 0 3px, rgba(253,230,138,0.32) 3px 6px)";
const TRACK_H = 56;
const LANE_TOP: Record<SpeakerKind, number> = { agent: 18, caller: 32, human: 41 };

function toMs(v: unknown, fallback: number): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const p = Date.parse(String(v ?? ""));
  return Number.isNaN(p) ? fallback : p;
}

const estMs = (text: string) => Math.max(1500, (text.length / HUMAN_CPS) * 1000);

/** Derive the segment/marker model from raw call events (shared with the transcript view). */
export function buildTimeline(events: CallEvent[], durationS?: number | null): TimelineModel | null {
  if (!events.length) return null;
  const evMs = (e: CallEvent) => Date.parse(e.ts);
  const audio = events.find((e) => e.type === "audio_start");
  const t0 = audio ? toMs(audio.payload?.at, evMs(audio)) : evMs(events[0]);

  type Point = { kind: SpeakerKind; at: number; text?: string; evId: number };
  const points: Point[] = [];
  const speech = events.filter((e) => e.type === "speech");
  if (speech.length) {
    for (const e of speech) {
      points.push({ kind: e.payload?.who === "agent" ? "agent" : "caller", at: toMs(e.payload?.at, evMs(e)), evId: e.id });
    }
  } else {
    for (const e of events) {
      if (e.type === "agent_said" || e.type === "user_said") {
        points.push({
          kind: e.type === "agent_said" ? "agent" : "caller",
          at: evMs(e),
          text: String(e.payload?.text ?? ""),
          evId: e.id,
        });
      }
    }
  }
  for (const e of events) {
    if (e.type === "human_segment") {
      points.push({ kind: "human", at: toMs(e.payload?.at, evMs(e)), text: String(e.payload?.text ?? ""), evId: e.id });
    }
  }
  points.sort((a, b) => a.at - b.at);

  // Collapse consecutive same-speaker boundaries (VAD re-triggers) into one turn.
  const merged: Point[] = [];
  for (const p of points) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === p.kind && p.kind !== "human" && !p.text && !prev.text) continue;
    merged.push(p);
  }
  if (!merged.length) return null;

  const lastTs = events.reduce((m, e) => Math.max(m, evMs(e)), t0);
  const totalMs = Math.max(
    lastTs - t0,
    (durationS ?? 0) * 1000,
    ...merged.map((p) => p.at - t0 + (p.text ? estMs(p.text) : 0)),
    1000
  );

  const segs: TimelineSeg[] = merged.map((p, i) => {
    const startMs = Math.min(Math.max(p.at - t0, 0), totalMs);
    const next = merged[i + 1] ? Math.max(merged[i + 1].at - t0, startMs) : totalMs;
    const endMs = Math.min(p.text ? Math.min(startMs + estMs(p.text), next) : next, totalMs);
    return { kind: p.kind, startMs, endMs: Math.max(endMs, startMs + 400), text: p.text, evId: p.evId };
  });

  // Attach utterance text to speech-derived turns; partial transcripts keep the longest.
  if (speech.length) {
    for (const e of events) {
      if (e.type !== "agent_said" && e.type !== "user_said") continue;
      const kind: SpeakerKind = e.type === "agent_said" ? "agent" : "caller";
      const off = evMs(e) - t0;
      let target: TimelineSeg | undefined;
      for (const s of segs) {
        if (s.startMs > off) break;
        if (s.kind === kind) target = s;
      }
      target ??= segs.find((s) => s.kind === kind);
      if (!target) continue;
      const text = String(e.payload?.text ?? "");
      if (!target.text || text.length >= target.text.length) {
        target.text = text;
        target.evId = e.id;
      }
    }
  }

  const holds: { startMs: number; endMs: number }[] = [];
  let open: number | null = null;
  let openUntil = 0;
  for (const e of events) {
    if (e.type === "hold_start") {
      open = evMs(e);
      openUntil = toMs(e.payload?.until, open + Number(e.payload?.seconds ?? 15) * 1000);
    } else if (e.type === "hold_end" && open != null) {
      holds.push({ startMs: open - t0, endMs: evMs(e) - t0 });
      open = null;
    }
  }
  if (open != null) holds.push({ startMs: open - t0, endMs: Math.min(openUntil - t0, totalMs) });

  const markers = events
    .filter((e) => e.type === "tool_call")
    .map((e) => ({ atMs: evMs(e) - t0, name: String(e.payload?.name ?? "tool") }));

  return { t0, totalMs, segs, markers, holds };
}

function SegTip({ seg }: { seg: TimelineSeg }) {
  return (
    <span className="block">
      <span className="mb-0.5 flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SPEAKER_COLOR[seg.kind] }} />
        <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-neutral-400">{SPEAKER_LABEL[seg.kind]}</span>
        <span className="ml-auto pl-3 text-[10px] tabular-nums text-neutral-400">{mmss(seg.startMs)}</span>
      </span>
      {seg.text && (
        <span className="block text-[11px] leading-[1.45] text-neutral-600">
          {seg.text.length > 140 ? `${seg.text.slice(0, 140)}…` : seg.text}
        </span>
      )}
    </span>
  );
}

export type CaptionConfig = {
  colorFor: (kind: SpeakerKind) => string;
  activeEvId?: number | null;
  onClickSeg?: (seg: TimelineSeg) => void;
};

export default function CallTimeline({
  events, durationS, audioRef, seekable = false, onSeek, captions,
}: {
  events: CallEvent[];
  durationS?: number | null;
  audioRef?: RefObject<HTMLAudioElement | null>;
  seekable?: boolean;
  onSeek?: (sec: number) => void;
  captions?: CaptionConfig;
}) {
  const tl = useMemo(() => buildTimeline(events, durationS), [events, durationS]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);

  const hasTl = tl != null;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!hasTl || !el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, [hasTl]);

  const totalS = (tl?.totalMs ?? 1000) / 1000;
  let pxPerSec = viewW ? Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, viewW / totalS)) : 10;
  if (captions && tl) {
    // Widen until each utterance's text fits in ~4 lines under its own bar.
    let needed = 0;
    for (const seg of tl.segs) {
      if (!seg.text) continue;
      const durS = Math.max((seg.endMs - seg.startMs) / 1000, 0.5);
      needed = Math.max(needed, (seg.text.length * 6.4) / 4 / durS);
    }
    pxPerSec = Math.min(Math.max(pxPerSec, needed), 44);
  }
  const trackW = Math.round(totalS * pxPerSec);

  // Playhead: rAF-driven transform straight from the audio element, page-flip auto-scroll.
  useEffect(() => {
    if (!audioRef) return;
    let raf = 0;
    const step = () => {
      const a = audioRef.current;
      const caret = caretRef.current;
      const sc = scrollerRef.current;
      if (a && caret) {
        const x = a.currentTime * pxPerSec;
        caret.style.transform = `translate3d(${x}px,0,0)`;
        if (sc && !a.paused && sc.scrollWidth > sc.clientWidth) {
          if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) {
            sc.scrollTo({ left: Math.max(0, x - 40) });
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [audioRef, pxPerSec]);

  if (!tl) return <div className="flex-1 py-3 text-center text-xs text-neutral-300">no timeline</div>;

  const X = (ms: number) => (ms / 1000) * pxPerSec;
  const tickStep = pxPerSec >= 11 ? 15 : 30;
  const ticks = Array.from({ length: Math.floor(totalS / tickStep) + 1 }, (_, i) => i * tickStep);

  return (
    <div ref={scrollerRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
      <div style={{ width: trackW }}>
        <div
          className={`relative ${seekable ? "cursor-pointer" : ""}`}
          style={{ height: TRACK_H }}
          onClick={(e) => {
            if (!seekable || !onSeek) return;
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, (e.clientX - r.left) / pxPerSec));
          }}
        >
          {tl.holds.map((h, i) => (
            <div
              key={`h${i}`}
              className="absolute inset-y-1 rounded-[3px]"
              style={{ left: X(h.startMs), width: Math.max(X(h.endMs - h.startMs), 3), background: HOLD_BG }}
            />
          ))}
          <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-neutral-200" />
          {tl.segs.map((s) => (
            <div
              key={s.evId}
              className="absolute"
              style={{ left: X(s.startMs), width: Math.max(X(s.endMs - s.startMs), 3), top: LANE_TOP[s.kind], height: 6 }}
            >
              <Tooltip content={<SegTip seg={s} />} className="h-full w-full">
                <span className="h-full w-full rounded-full" style={{ background: SPEAKER_COLOR[s.kind] }} />
              </Tooltip>
            </div>
          ))}
          {tl.markers.map((m, i) => (
            <div key={`m${i}`} className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: X(m.atMs) }}>
              <Tooltip content={<span className="font-mono text-[11px]">{m.name}(…)</span>} className="p-1">
                <span className="block h-1 w-1 rotate-45 bg-neutral-500" />
              </Tooltip>
            </div>
          ))}
          {audioRef && (
            <div ref={caretRef} className="pointer-events-none absolute inset-y-0 left-0 z-20 will-change-transform">
              <div className="absolute -left-[4px] top-0 h-0 w-0 border-x-4 border-t-[5px] border-x-transparent border-t-red-500" />
              <div className="absolute -left-[0.75px] h-full w-[1.5px] bg-red-500" />
            </div>
          )}
        </div>
        <div className="relative mt-0.5 h-[13px]">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-0 -translate-x-1/2 text-[9px] tabular-nums text-neutral-300 first:translate-x-0"
              style={{ left: X(t * 1000) }}
            >
              {mmss(t * 1000)}
            </span>
          ))}
        </div>
        {captions && (
          <div className="relative mt-1.5 min-h-[72px]">
            {tl.segs.filter((s) => s.text).map((s) => (
              <button
                key={`c${s.evId}`}
                id={`utt-${s.evId}`}
                onClick={() => captions.onClickSeg?.(s)}
                disabled={!captions.onClickSeg}
                className={`absolute top-0 rounded-md px-1 py-0.5 text-left align-top transition-colors duration-[160ms] ${
                  s.evId === captions.activeEvId ? "bg-neutral-100" : captions.onClickSeg ? "hover:bg-neutral-50" : "cursor-default"
                }`}
                style={{ left: X(s.startMs), width: Math.max(X(s.endMs - s.startMs) - 4, 56) }}
              >
                <span
                  className="line-clamp-4 block text-[11px] leading-[1.45]"
                  style={{ color: captions.colorFor(s.kind) }}
                >
                  {s.text}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
