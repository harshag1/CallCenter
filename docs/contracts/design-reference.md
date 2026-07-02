# design-reference.md
Author: Harsha Gundala — Chat UI + tooltip design system, extracted from Meshia/GPU-Hub (`gpu-hub/web`), adapted for CallCenter (all-white theme, Tailwind v4, lucide-react, no new deps).

Source files (read-only reference):
- `components/chat/MessageBubble.tsx`, `components/chat/ToolCallCard.tsx`, `components/chat/MultiChat.tsx`
- `components/ui/InfoTooltip.tsx`, `components/workspace/compute/HardwareTooltip.tsx`, `StorageDirsTooltip.tsx`, `useTooltipPosition.ts`, `AreaChart.tsx`
- `lib/tool-display.ts`, `app/globals.css` (chat classes ~L4560–5470, composer ~L6150, editor ~L10390)

---

## 1. Design tokens (gpu-hub values → CallCenter neutral mapping)

gpu-hub is a near-white light theme with a single dark-ink accent — very close to CallCenter already.

| Token | gpu-hub value | CallCenter (Tailwind neutral) |
|---|---|---|
| bg-primary | `#f5f7f6` | `bg-white` |
| bg-secondary | `#fbfcfb` | `bg-neutral-50` |
| bg-elevated / raised | `#ffffff` | `bg-white` |
| text-primary (ink) | `#1d2738` | `text-neutral-900` |
| text-secondary | `#516072` | `text-neutral-600` |
| text-tertiary | `#728194` | `text-neutral-400` |
| accent (= ink, monochrome) | `#1d2738` | `neutral-900` |
| border | `rgba(63,78,99,0.10)` | `border-neutral-200` |
| border-strong | `rgba(63,78,99,0.36)` | `border-neutral-300` |
| success / warning / error | `#29a17d` / `#d7942f` / `#d65c57` | `emerald-600` / `amber-600` / `red-500` (muted) |
| chat user bubble bg/text | `#1f2733` / `#ffffff` | `bg-neutral-900 text-white` |
| radius-sm / md / lg | `10px / 16px / 22px` | `rounded-[10px] / rounded-2xl / rounded-[22px]` |
| shadow-sm | `0 8px 24px rgba(46,57,77,0.05)` | `shadow-[0_8px_24px_rgba(0,0,0,0.05)]` |
| shadow-overlay | `0 32px 90px rgba(46,57,77,0.18)` | `shadow-[0_18px_44px_rgba(0,0,0,0.14)]` |
| duration-micro / panel / section | `160ms / 240ms / 360ms` | same |
| ease-default | `cubic-bezier(0.22,1,0.36,1)` | same |
| spring-pop | `cubic-bezier(0.16,1.34,0.28,1)` | same |

Fonts: sans = Manrope (`--font-sans`), mono = IBM Plex Mono. CallCenter: keep system/Inter + `font-mono`.
Type scale rhythm: **10px uppercase-tracked labels, 11px mono data, 12.5px user text, 13px assistant prose, 14px tool-line titles.** Tabular numerals (`tabular-nums`) on every numeric value.

Key aesthetic rules gpu-hub follows everywhere:
- Accent IS the ink color — no blue/purple. State color only for success/error dots.
- Micro type: labels at 8–10px with `letter-spacing: 0.14–0.22em; text-transform: uppercase; font-weight: 500`.
- Shadows are large-radius + very low alpha (soft ambient, never hard).
- All transitions 120–160ms; anything animated respects `prefers-reduced-motion`.

---

## 2. Chat UI

### Layout anatomy
- User messages: right-aligned dark bubble, `max-w-[76%]`.
- Assistant messages: **no bubble** — plain prose directly on the surface, left-aligned, `max-w-[92%]`.
- Tool calls: **bare text lines** ("[icon] Running a shell command") — no card, no border, no chevron. Whole row is a `<button>`; click expands an indented detail panel with a thin left branch line.
- System notices: centered pill.

### 2.1 User message (copy-paste)
```jsx
<div className="flex justify-end">
  <div className="max-w-[76%] select-text whitespace-pre-wrap rounded-[18px] rounded-br-[8px]
                  bg-neutral-900 px-3.5 py-2 text-[12.5px] leading-[1.5] text-white
                  border border-neutral-900/10 shadow-[0_8px_24px_rgba(0,0,0,0.05)]">
    {content}
  </div>
</div>
```
(gpu-hub: `.chat-bubble` radius 18px with `border-bottom-right-radius: 8px` "tail corner", bg `#1f2733`.)

### 2.2 Assistant message (copy-paste)
```jsx
<div className="flex justify-start">
  <div className="relative max-w-[92%] select-text px-1 py-0.5
                  text-[13px] leading-[1.62] font-[450] text-neutral-800">
    {/* markdown-rendered content; p margins: my-[0.52em], first:mt-0 last:mb-0;
        strong -> font-extrabold text-neutral-900; pre -> bg-neutral-50 */}
  </div>
</div>
```

### 2.3 System pill
```jsx
<div className="flex justify-center">
  <div className="rounded-full border border-neutral-200 bg-white px-3 py-1
                  text-[11px] text-neutral-400 shadow-[0_8px_18px_rgba(0,0,0,0.04)]">
    {content}
  </div>
</div>
```

### 2.4 Inline tool-call row — all states

Structure (from `ToolCallCard.tsx`): row = icon (15px, strokeWidth 2.25) + bold label + optional trailing hint/error dot. Label text comes from a registry mapping tool name → present-tense label while running / past-tense when done (e.g. `bash` → "Running a shell command" / "Ran a shell command", icon `Terminal`).

```jsx
// Row shell — identical for every state; state changes only classes on icon/label.
<div className="my-1 ml-0.5">
  <button type="button" onClick={toggle} aria-expanded={expanded}
    className="inline-flex max-w-full items-center gap-2 py-0.5 text-left
               text-[14px] font-semibold text-neutral-500 whitespace-nowrap
               disabled:cursor-default focus-visible:outline-none
               focus-visible:[&>span]:underline focus-visible:[&>span]:underline-offset-[3px]">
    <Icon size={15} strokeWidth={2.25}
      className={`shrink-0 text-neutral-500 ${running ? "animate-tool-pulse" : ""}`} />
    <span className={`max-w-[56ch] truncate font-semibold ${running ? "tool-shimmer" : ""}`}>
      {label}
    </span>
    {/* ERROR: subtle red dot after title — no red box */}
    {error && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500
                               shadow-[0_0_0_2px_rgba(255,255,255,0.92)]" aria-label="Error" />}
    {/* INTERRUPTED: faint mono hint */}
    {interrupted && <span className="ml-0.5 font-mono text-[12px] font-medium text-neutral-400">
      <span className="mx-1 text-neutral-300">·</span>interrupted</span>}
  </button>

  {/* Expanded detail: indented branch */}
  {expanded && (
    <div className="ml-[22px] mt-1 mb-1.5 max-w-[760px] border-l border-neutral-200/70 pl-3">
      <div className="space-y-3">
        {/* section label */}
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">Output</div>
        {/* panel */}
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-[14px]
                        border border-neutral-200 bg-neutral-50 px-3 py-3
                        font-mono text-[11px] leading-5 text-neutral-600">
          {output}
        </pre>
      </div>
    </div>
  )}
</div>
```

State CSS (port of `.chat-tool-line-*`, add to global CSS):
```css
/* RUNNING — icon pulse (opacity 0.55→1, scale 1.05, 4.2s) */
@keyframes tool-pulse { 0%,100% { opacity:.55; transform:scale(1); } 50% { opacity:1; transform:scale(1.05); } }
.animate-tool-pulse { animation: tool-pulse 4.2s cubic-bezier(.4,0,.6,1) infinite; }

/* RUNNING — text shimmer: lighter band sweeps across the bold title every 4.8s */
.tool-shimmer {
  background-image: linear-gradient(90deg,
    #525252 0%, #525252 35%, #d4d4d4 50%, #525252 65%, #525252 100%);
  background-size: 220% 100%; background-position: 200% 0;
  -webkit-background-clip: text; background-clip: text;
  color: transparent; -webkit-text-fill-color: transparent;
  animation: tool-shimmer 4.8s linear infinite;
}
@keyframes tool-shimmer { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }

/* INTERRUPTED — dim everything, kill motion */
.tool-interrupted, .tool-interrupted * { color:#a3a3a3; animation:none; }

@media (prefers-reduced-motion: reduce) {
  .animate-tool-pulse { animation:none; opacity:.85; }
  .tool-shimmer { animation:none; background:none; -webkit-text-fill-color:#525252; color:#525252; }
}
```

State summary:
- **running** → icon pulses + label shimmers. No spinner.
- **done** → static row, past-tense label. Errors auto-expand the panel; nothing else does.
- **error** → 6px red dot trailing the title; detail panel opens with a pill badge: `inline-flex items-center rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[10px] font-medium text-red-500` preceded by a 1.5px red dot.
- **interrupted** → dimmest gray, `· interrupted` mono hint, all animation off.

Terminal detail panel (bash/shell tools keep a live dark terminal even in light theme):
```jsx
<div className="max-w-[760px] overflow-hidden rounded-[10px] border border-white/10
                bg-[#070a0f] px-3 pb-3 pt-[11px] font-mono">
  <pre className="whitespace-pre-wrap break-words text-[11px] leading-[1.55] font-[560] text-white/90">
    <span className="text-neutral-400">$</span> <span>{command}</span>
  </pre>
  <pre className="max-h-[190px] overflow-y-auto whitespace-pre-wrap break-words
                  text-[11px] leading-[1.58] text-white/70">
    {output}{live && <span className="terminal-cursor" />}
  </pre>
</div>
```

Streaming/"thinking" indicator (pixel loader — 3 tiny blinking cells, not a spinner):
```css
.pixel-loader { display:inline-flex; align-items:center; gap:2px; height:12px; color:#a3a3a3; }
.pixel-loader-cell { width:3px; height:3px; background:currentColor; border-radius:.5px;
  opacity:.18; animation:pixel-blink 1.8s steps(2,end) infinite; }
@keyframes pixel-blink { 0%,100% {opacity:.18; transform:scaleY(1);} 35% {opacity:.95; transform:scaleY(1.6);} 60% {opacity:.55;} }
```
Live thinking text preview: `border-l border-neutral-200/70 pl-2.5 font-mono text-[12px] leading-6 text-neutral-400 opacity-80 max-h-[7lh] overflow-y-auto whitespace-pre-wrap`.

### 2.5 Chat input (composer)

Shell + controls (from `MultiChat.tsx` L1528–1672 + `.chat-composer-shell` CSS):
```jsx
<div className="shrink-0 border-t border-neutral-200/70 bg-white/85 px-4 pb-4 pt-2">
  <div className="relative rounded-2xl border border-neutral-200/75 bg-white/70 px-2.5 py-2
                  transition-[background-color,border-color,box-shadow] duration-[160ms]
                  focus-within:bg-white focus-within:border-neutral-900/25
                  focus-within:shadow-[0_0_0_1px_rgba(0,0,0,0.07)]">
    <div className="flex items-end gap-2">
      <div className="relative min-w-0 flex-1">
        <textarea rows={1} placeholder="Message…"
          className="w-full resize-none bg-transparent px-1 py-[7px] text-[14px] leading-[1.55]
                     text-neutral-900 placeholder:text-neutral-400 outline-none
                     min-h-[1lh] max-h-[calc(7lh+14px)] overflow-y-auto
                     disabled:opacity-55 disabled:cursor-not-allowed" />
      </div>
      {/* Stop (while streaming): quiet gray circle */}
      {streaming && (
        <button aria-label="Stop" className="inline-flex h-[34px] w-[34px] shrink-0 items-center
          justify-center rounded-full border border-neutral-200 bg-neutral-50 text-neutral-500
          transition duration-[160ms] hover:-translate-y-px">
          <Square size={13} strokeWidth={2} />
        </button>
      )}
      {/* Send: solid ink circle, ArrowUp */}
      <button aria-label="Send" disabled={!canSend}
        className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full
                   border border-neutral-900 bg-neutral-900 text-white
                   transition duration-[160ms] hover:-translate-y-px hover:bg-neutral-800
                   disabled:opacity-40 disabled:translate-y-0">
        <ArrowUp size={16} strokeWidth={2.1} />
      </button>
    </div>
  </div>
</div>
```
Details that matter: input rests at exactly 1 line (`min-h-[1lh]`), grows to 7 lines then scrolls; 34px circular send/stop match ~36px single-line input height so bottom-alignment reads as centered; hover lifts buttons `-1px`; placeholder while streaming becomes "Send next...".

---

## 3. Tooltip system

gpu-hub has **no Radix/Floating-UI — all tooltips are hand-rolled** with `createPortal(document.body)` + a `getBoundingClientRect` positioning hook. Two tiers:

### 3.1 Tier 1 — text tooltip (`InfoTooltip.tsx`)
Trigger: `Info` icon at 11px, strokeWidth 1.6, `text-neutral-300 hover:text-neutral-600`. Opens on hover/focus, closes on a **80ms delay timer** (prevents flicker crossing gaps). Gap from anchor: 6px. Flips placement when <84px from viewport edge.

Container classes (verbatim from source, colors adapted):
```
pointer-events-none fixed rounded-[10px] border border-neutral-200 bg-white
px-2.5 py-1.5 text-[12px] leading-[1.4] text-neutral-600
shadow-[0_2px_10px_rgba(0,0,0,0.08)]
```
`maxWidth: min(240px, calc(100vw - 16px))`, `minWidth: 120`, `zIndex: 200`. No arrow.

### 3.2 Tier 2 — data tooltip ("compute tab" style, `HardwareTooltip.tsx`)
This is the "magnified info at a glance" pattern. Fixed **264px wide**, radius **6px** (tighter than UI chrome — reads as an instrument), padding **9px**, `pointer-events: none`, `zIndex 999`. **120ms intent delay** before mount (`setTimeout` before rendering anything). Positioned by `useTooltipPosition`: centered above anchor with 6px pad, clamped 8px from viewport edges, flips below when `rect.top < 200`.

Container:
```jsx
<div role="tooltip" style={{ position:"fixed", left, top, width:264,
     transform: flip ? undefined : "translateY(-100%)", zIndex:999, pointerEvents:"none" }}>
  <div className="rounded-[6px] border border-neutral-200 bg-white p-[9px]
                  shadow-[0_18px_44px_rgba(0,0,0,0.18)] [isolation:isolate]">
    {body}
  </div>
</div>
```

How it packs information — a strict 4-part vertical stack:

**(a) Identity row** (what this hardware is running): 8px colored dot + 11px medium truncating label + right-aligned 10px tabular-nums live-elapsed timer.
```jsx
<div className="mb-2 flex items-center gap-2">
  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: expColor }} />
  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-900">{label}</span>
  <span className="text-[10px] text-neutral-400 tabular-nums">{elapsed /* "1h 04m" | "3:27" */}</span>
</div>
{/* idle variant: */}
<div className="mb-2 text-[9px] font-medium uppercase tracking-[0.22em] text-neutral-400">Idle</div>
```

**(b) ChartBlock × N** (LOAD, VRAM …): micro label-left / value-right header over a 244×32 sparkline area chart.
```jsx
<div className="mb-2">
  <div className="mb-1 flex justify-between">
    <span className="text-[8px] font-medium uppercase tracking-[0.22em] text-neutral-400">LOAD</span>
    <span className="text-[10px] text-neutral-900 tabular-nums">87%</span>
  </div>
  <AreaChart data={history} width={244} height={32} yMax={100} stroke={color} fill={fillRgba18} />
</div>
```
AreaChart = ~40-line inline SVG: 1px stroke polyline + closed area path at 0.18 alpha of the same hue, `yMax` pinned (100 for %, total GB for VRAM). Port `AreaChart.tsx` verbatim — it's dependency-free.

**(c) Footer stat row** behind a hairline divider: icon (11px, strokeWidth 1.5) + 10px tabular value, 16px gaps.
```jsx
<div className="flex gap-4 border-t border-neutral-200/80 pt-2">
  <span className="inline-flex items-center gap-1.5">
    <Thermometer size={11} strokeWidth={1.5} className="text-neutral-400" />
    <span className="text-[10px] text-neutral-900 tabular-nums">64°C</span>
  </span>
  <span className="inline-flex items-center gap-1.5">
    <Zap size={11} strokeWidth={1.5} className="text-neutral-400" />
    <span className="text-[10px] text-neutral-900 tabular-nums">312 W</span>
  </span>
</div>
```

**(d) Compact state variant**: when the resource is transitioning ("Attaching"), the tooltip shrinks to **126px**, side-anchored (right of pill, `translateY(-50%)`), radius 7px, slightly tinted bg, single line: `text-[11px] font-semibold` label + `text-neutral-400 tabular-nums` timer. Same component, different width — a tooltip that resizes to its information density.

### 3.3 Key-value list variant (`StorageDirsTooltip.tsx`) — 300px wide
Header row: mono path left (11px) / usage right (10px tabular) with bottom hairline `mb-2 pb-2 border-b`. Then up to 8 clickable rows:
```jsx
<button className="flex w-full items-baseline justify-between rounded-[4px] px-1.5 py-[5px]
                   text-left font-mono text-[11px] text-neutral-900
                   transition-colors duration-[120ms] hover:bg-neutral-100">
  <span className="mr-3 min-w-0 flex-1 truncate">/workspace/checkpoints</span>
  <span className="text-[10px] text-neutral-500 tabular-nums">41.2 GB</span>
</button>
{/* overflow: */}<span className="px-1.5 py-[5px] text-[10px] text-neutral-400">… 12 more</span>
```
Optional note chip above the list: `rounded-[5px] bg-neutral-100 px-[7px] py-1.5 text-[10px] leading-[1.45] text-neutral-600`.

### 3.4 Trigger wiring (from `HardwarePill.tsx`)
Anchor passes its own element: `onPointerEnter/onMouseEnter/onFocus={(e) => showTooltip(e.currentTarget)}`, `onPointerLeave/onBlur={hideTooltip}`, plus `aria-describedby={tooltipId}` and `role="tooltip"` + `id` on the floating node.

---

## 4. Ready-to-paste `Tooltip` for CallCenter (dependency-free)

Direct port of the gpu-hub pattern (portal + rect positioning + intent delay + close-delay), Tailwind-only, white theme. One component, two variants: `variant="text"` (Tier 1) and `variant="panel"` (Tier 2 data surface — put grids/stat rows/sparklines in children).

```tsx
// components/ui/Tooltip.tsx
// Author: Harsha Gundala — Portal tooltip (gpu-hub pattern: intent delay, edge flip, no deps).
"use client";

import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;                       // trigger (any inline element)
  placement?: "top" | "bottom" | "left" | "right";
  variant?: "text" | "panel";               // text: 240px prose; panel: fixed-width data surface
  width?: number;                            // panel width, default 264
  openDelay?: number;                        // default 120ms (gpu-hub intent delay)
  className?: string;
}

export default function Tooltip({
  content, children, placement = "top",
  variant = "text", width = 264, openDelay = 120, className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const updatePosition = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    let p = placement;
    if (p === "top" && r.top < 96) p = "bottom";
    if (p === "bottom" && window.innerHeight - r.bottom < 96) p = "top";
    if (p === "right" && window.innerWidth - r.right < width + 16) p = "left";
    if (p === "left" && r.left < width + 16) p = "right";

    const cx = Math.max(8 + width / 2,
      Math.min(window.innerWidth - 8 - width / 2, r.left + r.width / 2));
    const pos: Record<typeof p, CSSProperties> = {
      top:    { left: cx, top: r.top - gap,               transform: "translate(-50%, -100%)" },
      bottom: { left: cx, top: r.bottom + gap,            transform: "translateX(-50%)" },
      left:   { left: r.left - gap,  top: r.top + r.height / 2, transform: "translate(-100%, -50%)" },
      right:  { left: r.right + gap, top: r.top + r.height / 2, transform: "translateY(-50%)" },
    };
    setStyle(pos[p]);
  }, [placement, width]);

  useEffect(() => () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const show = () => {
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (open || openTimer.current) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
      requestAnimationFrame(updatePosition);
    }, openDelay);
  };
  const hide = () => {
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    closeTimer.current = window.setTimeout(() => setOpen(false), 80);
  };

  const surface =
    variant === "text"
      ? "rounded-[10px] border border-neutral-200 bg-white px-2.5 py-1.5 text-[12px] leading-[1.4] text-neutral-600 shadow-[0_2px_10px_rgba(0,0,0,0.08)]"
      : "rounded-[6px] border border-neutral-200 bg-white p-[9px] shadow-[0_18px_44px_rgba(0,0,0,0.14)]";

  return (
    <span
      ref={wrapperRef}
      className={`relative inline-flex items-center ${className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && style && typeof document !== "undefined"
        ? createPortal(
            <span
              role="tooltip"
              className={`pointer-events-none fixed z-[200] ${surface}`}
              style={{
                ...style,
                ...(variant === "text"
                  ? { maxWidth: "min(240px, calc(100vw - 16px))", minWidth: 120, whiteSpace: "normal" }
                  : { width }),
              }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
```

Inner layout snippets to compose inside `variant="panel"` content:

```jsx
// Micro section label
<div className="text-[8px] font-medium uppercase tracking-[0.22em] text-neutral-400">LATENCY</div>

// Label / value stat header row
<div className="mb-1 flex justify-between">
  <span className="text-[8px] font-medium uppercase tracking-[0.22em] text-neutral-400">CALLS</span>
  <span className="text-[10px] text-neutral-900 tabular-nums">1,284</span>
</div>

// Key-value grid (2-col)
<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
  <span className="text-[10px] text-neutral-400">Agent</span>
  <span className="truncate text-right text-[11px] font-medium text-neutral-900">voice-router-2</span>
</div>

// Icon footer stat row (behind hairline)
<div className="mt-2 flex gap-4 border-t border-neutral-200/80 pt-2">
  <span className="inline-flex items-center gap-1.5">
    <Clock size={11} strokeWidth={1.5} className="text-neutral-400" />
    <span className="text-[10px] text-neutral-900 tabular-nums">312 ms</span>
  </span>
</div>
```

Info-icon trigger (Tier 1 usage):
```jsx
<Tooltip content="Median time from caller audio to first agent token.">
  <button aria-label="More info"
    className="inline-flex items-center justify-center text-neutral-300 transition-colors
               duration-[160ms] hover:text-neutral-600 focus-visible:text-neutral-600 outline-none">
    <Info size={11} strokeWidth={1.6} />
  </button>
</Tooltip>
```

---

## 5. Icon + motion conventions (gpu-hub, adopt as-is)

- Library: **lucide-react everywhere.** Icons resolved by string name via a central registry (`lib/tool-display.ts` → `ToolIcon.tsx`) so labels/icons stay data, not JSX.
- Size ladder: **11px** (tooltip stats, info triggers, sw 1.5–1.6) · **12–13px** (row actions/status, sw 1.7–2) · **15px** (tool-call line, sw **2.25** — heavier stroke at small size keeps it crisp) · **16px** (send arrow, sw 2.1).
- Icons are always `aria-hidden`, colored via `currentColor`, never decorative-large.
- Tool labels: short present-tense verb phrases ≤24 chars while running ("Visualizing the data"), past tense when done ("Visualized the data").
- Motion: 160ms micro / 240ms panel / 360ms section; entrance pop = `240ms cubic-bezier(0.2,1.18,0.24,1)` translateY(8px)+scale(0.985)→overshoot→settle; hover lift = `-translate-y-px`; press scale 0.985. Every looping animation has a `prefers-reduced-motion` fallback.

## 6. What NOT to copy
- gpu-hub's tooltips set `pointer-events: none` — fine unless content is clickable (StorageDirsTooltip keeps pointer events because rows navigate; if CallCenter needs clickable tooltip rows, drop `pointer-events-none` and rely on the 80ms close delay).
- The dark terminal panel (`#070a0f`) is intentionally dark inside the light theme — keep that contrast, don't whitewash it.
- No arrows on any tooltip, anywhere. Keep it that way.
