// Author: Harsha Gundala
// TopPills.tsx — internet-access toggle (favicon + enforced URL allowlist) and files entry.

"use client";

import { useState } from "react";
import { Globe, Plus, FolderOpen, X } from "lucide-react";

type Props = {
  enabled: boolean;
  domains: string[];
  faviconUrl: string | null;
  onToggle: (v: boolean) => void;
  onAddDomain: (d: string) => Promise<boolean>;
  onRemoveDomain: (d: string) => void;
  onOpenFiles: () => void;
  docCount: number;
};

export default function TopPills({
  enabled, domains, faviconUrl, onToggle, onAddDomain, onRemoveDomain, onOpenFiles, docCount,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex items-start justify-center gap-2">
      {!enabled ? (
        <button
          onClick={() => onToggle(true)}
          aria-label="enable internet access"
          className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 bg-white/95 shadow-[0_4px_20px_rgba(15,15,15,0.05)] backdrop-blur transition-colors hover:border-neutral-400"
        >
          <Globe size={14} strokeWidth={2.2} className="text-neutral-300" />
        </button>
      ) : (
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-neutral-200 bg-white/95 py-1.5 pl-3 pr-2 shadow-[0_4px_20px_rgba(15,15,15,0.05)] backdrop-blur">
        <Globe size={14} strokeWidth={2.2} className="text-neutral-950" />
        <span className="text-[12px] font-medium">Internet</span>
        <button
          onClick={() => onToggle(!enabled)}
          className={`relative h-[18px] w-8 rounded-full transition-colors ${enabled ? "bg-neutral-950" : "bg-neutral-200"}`}
          aria-label="toggle internet access"
        >
          <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${enabled ? "left-[16px]" : "left-[2px]"}`} />
        </button>
        <span className="h-4 w-px bg-neutral-150 bg-neutral-200" />
        <div className="flex items-center gap-1.5">
          {domains.map((d, i) => (
            <span key={d} className="group flex items-center gap-1">
              {i === 0 && faviconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={faviconUrl} alt={d} title={d} className="h-4.5 h-[18px] w-[18px] rounded" />
              ) : (
                <span title={d} className="max-w-24 truncate rounded-full border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-500">
                  {d}
                </span>
              )}
              {i > 0 && (
                <button onClick={() => onRemoveDomain(d)} className="hidden text-neutral-300 hover:text-neutral-900 group-hover:block">
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
          {adding ? (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && value.trim()) {
                  if (await onAddDomain(value.trim())) { setValue(""); setAdding(false); }
                }
                if (e.key === "Escape") setAdding(false);
              }}
              onBlur={() => setAdding(false)}
              placeholder="docs.acme.com"
              className="w-28 rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] outline-none"
            />
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-neutral-200 text-neutral-400 transition-colors hover:border-neutral-900 hover:text-neutral-900"
              aria-label="add allowed domain"
            >
              <Plus size={11} />
            </button>
          )}
        </div>
      </div>
      )}

      <button
        onClick={onOpenFiles}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-neutral-200 bg-white/95 px-3 py-1.5 shadow-[0_4px_20px_rgba(15,15,15,0.05)] backdrop-blur transition-colors hover:border-neutral-900"
        aria-label="knowledge files"
      >
        <FolderOpen size={14} strokeWidth={2.1} />
        {docCount > 0 && <span className="text-[11px] font-medium tabular-nums">{docCount}</span>}
      </button>
    </div>
  );
}
