// Author: Harsha Gundala
// OrgPills.tsx — icon-only org pills: internet access (globe + favicon + allowlist popover) and knowledge files.

"use client";

import { useEffect, useRef, useState } from "react";
import { FolderOpen, Globe, Plus, X } from "lucide-react";

export type OrgPillsProps = {
  enabled: boolean;
  domains: string[];
  faviconUrl: string | null;
  onToggle: (v: boolean) => void;
  onAddDomain: (d: string) => Promise<boolean>;
  onRemoveDomain: (d: string) => void;
  onOpenFiles: () => void;
  docCount: number;
  compact?: boolean;
};

const PILL =
  "pointer-events-auto flex items-center rounded-full border border-neutral-200 bg-white/95 shadow-[0_4px_20px_rgba(15,15,15,0.05)] backdrop-blur";

export default function OrgPills({
  enabled, domains, faviconUrl, onToggle, onAddDomain, onRemoveDomain, onOpenFiles, docCount, compact,
}: OrgPillsProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const h = compact ? "h-7" : "h-8";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <>
      {!enabled ? (
        <button
          onClick={() => onToggle(true)}
          aria-label="enable internet access"
          className={`${PILL} ${h} ${compact ? "w-7" : "w-8"} justify-center transition-colors hover:border-neutral-400`}
        >
          <Globe size={14} strokeWidth={2.2} className="text-neutral-300" />
        </button>
      ) : (
        <div ref={ref} className="pointer-events-auto relative">
          <div className={`${PILL} ${h} ${compact ? "gap-1.5 px-2" : "gap-2 px-2.5"}`}>
            <button onClick={() => onToggle(false)} aria-label="disable internet access" className="flex items-center">
              <Globe size={14} strokeWidth={2.2} className="text-neutral-950 transition-opacity hover:opacity-50" />
            </button>
            {faviconUrl && domains.length > 0 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={faviconUrl} alt={domains[0]} title={domains[0]} className="h-4 w-4 rounded" />
            )}
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label="allowed domains"
              className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-200 text-neutral-400 transition-colors hover:border-neutral-900 hover:text-neutral-900"
            >
              <Plus size={10} className={`transition-transform duration-[160ms] ${open ? "rotate-45" : ""}`} />
            </button>
          </div>
          {open && (
            <div className="absolute left-0 top-full z-20 mt-1.5 w-52 rounded-xl border border-neutral-200 bg-white/95 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.12)] backdrop-blur">
              {domains.map((d, i) => (
                <div key={d} className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-neutral-50">
                  {i === 0 && faviconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={faviconUrl} alt="" className="h-3.5 w-3.5 rounded" />
                  ) : (
                    <Globe size={11} className="shrink-0 text-neutral-300" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-600">{d}</span>
                  {i > 0 && (
                    <button
                      onClick={() => onRemoveDomain(d)}
                      aria-label={`remove ${d}`}
                      className="hidden text-neutral-300 hover:text-neutral-900 group-hover:block"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              ))}
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && value.trim() && (await onAddDomain(value.trim()))) setValue("");
                  if (e.key === "Escape") setOpen(false);
                }}
                placeholder="docs.acme.com"
                className="mt-1 w-full rounded-lg border border-neutral-200 px-2 py-1 text-[11px] outline-none focus:border-neutral-400"
              />
            </div>
          )}
        </div>
      )}

      <button
        onClick={onOpenFiles}
        aria-label="knowledge files"
        className={`${PILL} ${h} gap-1.5 ${compact ? "px-2" : "px-3"} transition-colors hover:border-neutral-900`}
      >
        <FolderOpen size={14} strokeWidth={2.1} />
        {docCount > 0 && <span className="text-[11px] font-medium tabular-nums">{docCount}</span>}
      </button>
    </>
  );
}
