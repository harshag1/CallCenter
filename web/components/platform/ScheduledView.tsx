// Author: Harsha Gundala
// ScheduledView.tsx — outbound queue: campaign cards with live stats + upcoming calls (recalls flagged).

"use client";

import { useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import type { Campaign, ScheduledCall } from "@/components/hooks/useScheduled";
import { PulseDot, SatChip, fmtRel, useNow } from "./shared";

const HEADERS = ["to", "agent", "source", "when", "reason", "tries", ""];
const JSON_HEADERS = { "Content-Type": "application/json" };

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));

async function cancel(body: Record<string, string>): Promise<void> {
  try {
    await fetch("/api/scheduled", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  } catch { /* reload reflects truth */ }
}

const STATUS_CHIP: Record<string, string> = {
  running: "bg-neutral-900 text-white",
  scheduled: "border border-neutral-200 text-neutral-500",
  done: "bg-neutral-100 text-neutral-500",
  canceled: "bg-neutral-50 text-neutral-300",
  failed: "bg-red-50 text-red-600",
};

function StatusChip({ s }: { s: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CHIP[s] ?? "bg-neutral-100 text-neutral-500"}`}>
      {s === "running" && <PulseDot color="bg-emerald-400" ping="bg-emerald-300" />}
      {s}
    </span>
  );
}

/** Two-step inline cancel: first click arms, second confirms. */
function CancelButton({ armed, onArm, onConfirm, title }: { armed: boolean; onArm: () => void; onConfirm: () => void; title: string }) {
  return armed ? (
    <button
      onClick={(e) => { e.stopPropagation(); onConfirm(); }}
      className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-medium text-white transition-colors duration-[160ms] hover:bg-red-600"
    >
      confirm
    </button>
  ) : (
    <Tooltip content={title}>
      <button
        onClick={(e) => { e.stopPropagation(); onArm(); }}
        className="text-neutral-300 transition-colors duration-[160ms] hover:text-red-500"
      >
        <X size={13} />
      </button>
    </Tooltip>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className={`text-[13px] font-semibold tabular-nums ${tone ?? "text-neutral-900"}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-neutral-400">{label}</div>
    </div>
  );
}

function CampaignCard({ c, reload }: { c: Campaign; reload: () => void }) {
  const [arming, setArming] = useState(false);
  const cancellable = c.status === "running" || c.status === "scheduled";
  return (
    <div className="rounded-2xl border border-[var(--border)] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{c.name}</div>
          <div className="mt-0.5 truncate text-[11px] text-neutral-400">{c.agent} · {c.flow_name}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip s={c.status} />
          {cancellable && (
            <CancelButton
              armed={arming}
              onArm={() => setArming(true)}
              onConfirm={() => { setArming(false); void cancel({ cancel_campaign_id: c.id }).then(reload); }}
              title="cancel campaign"
            />
          )}
        </div>
      </div>
      <div className="mt-3.5 flex items-end justify-between">
        <div className="flex gap-5">
          <Stat label="total" value={num(c.total)} />
          <Stat label="answered" value={num(c.answered)} />
          <Stat label="missed" value={num(c.missed)} tone={num(c.missed) > 0 ? "text-red-600" : undefined} />
          <Stat label="pending" value={num(c.pending)} />
        </div>
        {c.avg_satisfaction != null && (
          <Tooltip content="avg satisfaction">
            <SatChip n={Number(c.avg_satisfaction)} />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

const isRecall = (s: ScheduledCall) => s.parent_call_id != null || (s.reason ?? "").startsWith("CUT-OFF RECALL");

export default function ScheduledView({
  scheduled, campaigns, reload,
}: { scheduled: ScheduledCall[]; campaigns: Campaign[]; reload: () => void }) {
  const now = useNow(15_000);
  const [arming, setArming] = useState<string | null>(null);

  const rows = useMemo(() => {
    const rank = (s: ScheduledCall) => (s.status === "pending" ? 0 : s.status === "dialing" ? 1 : 2);
    return [...scheduled].sort((a, b) =>
      rank(a) - rank(b) || (rank(a) === 0 ? Date.parse(a.run_at) - Date.parse(b.run_at) : Date.parse(b.run_at) - Date.parse(a.run_at))
    );
  }, [scheduled]);

  if (!campaigns.length && !rows.length) {
    return <div className="py-16 text-center text-xs text-neutral-300">nothing scheduled</div>;
  }

  return (
    <div className="space-y-6">
      {campaigns.length > 0 && (
        <section>
          <div className="mb-3 text-[11px] uppercase tracking-wide text-neutral-400">campaigns</div>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {campaigns.map((c) => <CampaignCard key={c.id} c={c} reload={reload} />)}
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <section>
          <div className="mb-3 text-[11px] uppercase tracking-wide text-neutral-400">upcoming</div>
          <div className="overflow-hidden rounded-2xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-neutral-400">
                  {HEADERS.map((h, i) => <th key={i} className="px-4 py-2.5 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const settled = s.status !== "pending" && s.status !== "dialing";
                  return (
                    <tr key={s.id} className={`border-b border-[var(--border)] last:border-0 ${settled ? "text-neutral-400" : ""}`}>
                      <td className="px-4 py-2.5 tabular-nums">{s.to_number}</td>
                      <td className="px-4 py-2.5">{s.agent}</td>
                      <td className="px-4 py-2.5">
                        {isRecall(s) ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-neutral-500">
                            <RotateCcw size={9} /> recall
                          </span>
                        ) : s.campaign ? (
                          <span className="max-w-[140px] truncate text-[12px] text-neutral-500">{s.campaign}</span>
                        ) : (
                          <span className="text-neutral-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-neutral-500">{fmtRel(s.run_at, now)}</td>
                      <td className="max-w-[220px] px-4 py-2.5">
                        {s.reason ? (
                          <Tooltip content={s.reason}>
                            <span className="block max-w-[220px] truncate text-neutral-500">{s.reason}</span>
                          </Tooltip>
                        ) : (
                          <span className="text-neutral-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-neutral-500">{s.attempts}</td>
                      <td className="w-16 px-4 py-2.5 text-right">
                        {s.status === "pending" ? (
                          <CancelButton
                            armed={arming === s.id}
                            onArm={() => setArming(s.id)}
                            onConfirm={() => { setArming(null); void cancel({ cancel_id: s.id }).then(reload); }}
                            title="cancel call"
                          />
                        ) : s.status === "dialing" ? (
                          <span className="inline-flex"><PulseDot /></span>
                        ) : (
                          <span className={`text-[10px] uppercase tracking-wide ${s.status === "failed" ? "text-red-500" : "text-neutral-300"}`}>{s.status}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
