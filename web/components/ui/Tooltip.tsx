// Author: Harsha Gundala
// Tooltip.tsx — dependency-free portal tooltip: intent delay, edge clamp + flip, text/panel variants.

"use client";

import {
  useCallback, useEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  placement?: Placement;
  variant?: "text" | "panel";
  width?: number;
  openDelay?: number;
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
    const pos: Record<Placement, CSSProperties> = {
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
              className={`pointer-events-none fixed z-[200] block ${surface}`}
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

/** Micro label / tabular value row for panel-variant bodies. */
export function TipStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[8px] font-medium uppercase tracking-[0.22em] text-neutral-400">{label}</span>
      <span className="min-w-0 truncate text-right text-[10px] text-neutral-900 tabular-nums">{value}</span>
    </div>
  );
}

/** Hairline section divider for panel-variant bodies. */
export function TipDivider() {
  return <div className="my-2 border-t border-neutral-200/80" />;
}
