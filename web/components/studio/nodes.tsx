// Author: Harsha Gundala
// nodes.tsx — custom React Flow nodes: incoming/outgoing call, topics (icons), editable fallback, experiment badge.

"use client";

import { memo, useState, type CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Phone, PhoneForwarded, PhoneOutgoing, LifeBuoy, Package, CreditCard, Calendar, User, Settings,
  ShoppingCart, Truck, RotateCcw, Shield, Zap, BookOpen, Wrench, Gift, Pencil, Check,
  Database, FlaskConical,
} from "lucide-react";

const ICONS: Record<string, typeof LifeBuoy> = {
  "life-buoy": LifeBuoy, package: Package, "credit-card": CreditCard, calendar: Calendar,
  user: User, settings: Settings, "shopping-cart": ShoppingCart, truck: Truck,
  "rotate-ccw": RotateCcw, shield: Shield, zap: Zap, "book-open": BookOpen,
  wrench: Wrench, gift: Gift, "phone-forwarded": PhoneForwarded,
};

function shell(active: boolean | undefined) {
  return `rounded-2xl border bg-white px-4 py-3 shadow-[0_4px_16px_rgba(15,15,15,0.04)] transition-all ${
    active ? "border-neutral-900 shadow-[0_0_0_2px_rgba(17,17,17,0.9)]" : "border-neutral-200"
  }`;
}

/** Variant-diff accent: when set, the node border adopts the variant's color with a soft ring. */
function diffStyle(data: NodeProps["data"]): CSSProperties | undefined {
  const c = data.diffColor as string | undefined;
  return c ? { borderColor: c, boxShadow: `0 0 0 1.5px ${c}33, 0 4px 16px rgba(15,15,15,0.04)` } : undefined;
}

export const IncomingCallNode = memo(function IncomingCallNode({ data }: NodeProps) {
  const number = data.number as string | null;
  const status = data.numberStatus as string | undefined;
  const label = (data.label as string | undefined) ?? "Incoming call";
  const outbound = Boolean(data.outbound) || /outgoing|outbound/i.test(label);
  const CallIcon = outbound ? PhoneOutgoing : Phone;
  return (
    <div className={`${shell(data.active as boolean)} min-w-[180px]`} style={diffStyle(data)}>
      <div className="flex items-center gap-3">
        <CallIcon size={17} strokeWidth={2.2} className="shrink-0 text-neutral-950" />
        <div>
          <div className="text-[13px] font-semibold">{label}</div>
          {number ? (
            <div className="text-[12px] tabular-nums text-neutral-500">{number}</div>
          ) : status === "failed" ? (
            <div className="text-[11px] text-red-400">provisioning failed</div>
          ) : status === "awaiting_operator_provisioning" ? (
            <div className="text-[11px] text-neutral-500">number setup requires approval</div>
          ) : status === "none" ? null : (
            <div className="mt-0.5 h-3.5 w-24 animate-pulse rounded bg-neutral-100" />
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      <Handle id="b" type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
    </div>
  );
});

export const TopicNode = memo(function TopicNode({ data }: NodeProps) {
  const Icon = ICONS[(data.icon as string) ?? "life-buoy"] ?? LifeBuoy;
  const steps = (data.steps as { label: string }[]) ?? [];
  const table = data.table as string | undefined;
  return (
    <div className={`${shell(data.active as boolean)} min-w-[170px] max-w-[200px]`} style={diffStyle(data)}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      <div className="flex items-center gap-2.5">
        <Icon size={16} strokeWidth={2.1} className="shrink-0 text-neutral-950" />
        <div className="text-[13px] font-semibold">{data.label as string}</div>
      </div>
      {steps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {steps.map((s, i) => (
            <span
              key={i}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                data.activeStep === i ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-500"
              }`}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
      {table && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
          <Database size={10} strokeWidth={1.8} className="shrink-0 text-neutral-400" />
          {table}
        </div>
      )}
    </div>
  );
});

export const FallbackNode = memo(function FallbackNode({ data }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const number = data.supportNumber as string | null;
  const save = data.onSaveNumber as ((n: string) => Promise<boolean>) | undefined;

  return (
    <div className={`${shell(data.active as boolean)} min-w-[180px]`} style={diffStyle(data)}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      <div className="flex items-center gap-2.5">
        <PhoneForwarded size={16} strokeWidth={2.1} className="shrink-0 text-neutral-950" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Other</div>
          <div className="text-[11px] text-neutral-400">contact support</div>
        </div>
      </div>
      {!save ? (
        number && <div className="mt-2 text-[11px] tabular-nums text-neutral-500">{number}</div>
      ) : editing ? (
        <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && (await save(value))) setEditing(false);
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="+1 415 555 0123"
            className="w-32 rounded-lg border border-neutral-200 px-2 py-1 text-[11px] tabular-nums outline-none focus:border-neutral-500"
          />
          <button
            onClick={async () => { if (await save(value)) setEditing(false); }}
            className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-white"
          >
            <Check size={11} />
          </button>
        </div>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setValue(number ?? ""); setEditing(true); }}
          className="mt-2 flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] tabular-nums text-neutral-600 transition-colors hover:border-neutral-900"
        >
          {number ?? "set number"} <Pencil size={10} className="text-neutral-300" />
        </button>
      )}
    </div>
  );
});

/** Running A/B test badge hung off the entry node — click-through to the experiment screen. */
export const ExperimentNode = memo(function ExperimentNode({ data }: NodeProps) {
  const onOpen = data.onOpen as (() => void) | undefined;
  return (
    <button
      onClick={onOpen}
      className={`min-w-[170px] rounded-2xl border border-violet-500 bg-white px-4 py-3 text-left
                  shadow-[0_4px_16px_rgba(139,92,246,0.12)] transition-transform duration-[160ms]
                  ${onOpen ? "cursor-pointer hover:-translate-y-px" : "cursor-default"}`}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      <div className="flex items-center gap-2.5">
        <FlaskConical size={16} strokeWidth={2.1} className="shrink-0 text-violet-500" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{data.label as string}</div>
          <div className="text-[11px] text-neutral-400">A/B test</div>
        </div>
      </div>
    </button>
  );
});

export const nodeTypes = {
  incoming_call: IncomingCallNode,
  topic: TopicNode,
  fallback: FallbackNode,
  experiment: ExperimentNode,
};
